const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const WebSocket = require('ws');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4973;

const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'time', 'network'];

const state = {
  server: null,
  serverHost: DEFAULT_HOST,
  serverPort: DEFAULT_PORT,
  clients: new Map(),
  clientSeq: 0,
  logs: [],
  logSeq: 0,
  maxLogEntries: 2000,
  outputChannel: null,
  statusBar: null,
  webviewPanel: null,
  inlineEnabled: true,
  lineStateByUri: new Map(),
  decorations: new Map(),
  config: null,
  extensionContext: null
};

function activate(context) {
  state.extensionContext = context;
  state.outputChannel = vscode.window.createOutputChannel('Console Samurai');
  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
  state.statusBar.command = 'consoleSamurai.showOutput';
  state.statusBar.show();

  buildDecorations();
  loadConfig();
  updateNodeAutoAttach(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('consoleSamurai.start', () => startServer()),
    vscode.commands.registerCommand('consoleSamurai.stop', () => stopServer()),
    vscode.commands.registerCommand('consoleSamurai.showOutput', () => showOutput()),
    vscode.commands.registerCommand('consoleSamurai.clearLogs', () => clearLogs()),
    vscode.commands.registerCommand('consoleSamurai.toggleInline', () => toggleInline()),
    vscode.commands.registerCommand('consoleSamurai.toggleNetwork', () => toggleNetwork())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('console-samurai')) {
        const prevConfig = state.config;
        loadConfig();
        handleConfigChange(prevConfig, state.config);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) {
        refreshInlineForEditor(editor);
      }
    })
  );

  if (state.config.autoStart) {
    startServer();
  } else {
    updateStatusBar();
  }
}

function deactivate() {
  stopServer();
  if (state.extensionContext && state.extensionContext.environmentVariableCollection) {
    state.extensionContext.environmentVariableCollection.clear();
  }
}

function loadConfig() {
  const cfg = vscode.workspace.getConfiguration('console-samurai');
  state.config = {
    autoStart: cfg.get('autoStart', true),
    host: cfg.get('host', DEFAULT_HOST),
    port: cfg.get('port', DEFAULT_PORT),
    maxLogEntries: cfg.get('maxLogEntries', 2000),
    inlineEnabled: cfg.get('inline.enabled', true),
    inlineMaxTextLength: cfg.get('inline.maxTextLength', 120),
    inlineShowTimestamp: cfg.get('inline.showTimestamp', false),
    enabledLevels: cfg.get('output.enabledLevels', LEVELS.slice()),
    networkEnabled: cfg.get('network.enabled', true),
    captureErrors: cfg.get('captureErrors', true),
    nodeAutoAttach: cfg.get('node.autoAttach', true),
    pathMappings: cfg.get('pathMappings', []),
    logCaptureOptions: cfg.get('logCaptureOptions', {
      maxDepth: 4,
      maxProps: 50,
      maxArray: 50,
      maxStringLength: 2000
    })
  };

  state.inlineEnabled = state.config.inlineEnabled;
  state.maxLogEntries = state.config.maxLogEntries;
}

function handleConfigChange(prevConfig, nextConfig) {
  if (!prevConfig) {
    return;
  }

  const serverChanged = prevConfig.host !== nextConfig.host || prevConfig.port !== nextConfig.port;
  if (serverChanged && state.server) {
    stopServer();
    if (nextConfig.autoStart) {
      startServer();
    }
  }
  if (!state.server && nextConfig.autoStart && !prevConfig.autoStart) {
    startServer();
  }

  if (prevConfig.inlineEnabled !== nextConfig.inlineEnabled) {
    state.inlineEnabled = nextConfig.inlineEnabled;
    refreshInlineAll();
  }

  if (prevConfig.inlineMaxTextLength !== nextConfig.inlineMaxTextLength ||
      prevConfig.inlineShowTimestamp !== nextConfig.inlineShowTimestamp) {
    refreshInlineAll();
  }

  if (prevConfig.maxLogEntries !== nextConfig.maxLogEntries) {
    state.maxLogEntries = nextConfig.maxLogEntries;
    trimLogs();
  }

  if (prevConfig.enabledLevels.join(',') !== nextConfig.enabledLevels.join(',')) {
    refreshInlineAll();
    updateWebview();
  }

  if (prevConfig.nodeAutoAttach !== nextConfig.nodeAutoAttach ||
      prevConfig.host !== nextConfig.host ||
      prevConfig.port !== nextConfig.port ||
      prevConfig.captureErrors !== nextConfig.captureErrors ||
      JSON.stringify(prevConfig.logCaptureOptions) !== JSON.stringify(nextConfig.logCaptureOptions)) {
    updateNodeAutoAttach(state.extensionContext);
  }

  if (prevConfig.networkEnabled !== nextConfig.networkEnabled ||
      prevConfig.captureErrors !== nextConfig.captureErrors ||
      JSON.stringify(prevConfig.logCaptureOptions) !== JSON.stringify(nextConfig.logCaptureOptions)) {
    broadcastConfig();
  }
}

function buildDecorations() {
  const colors = {
    log: new vscode.ThemeColor('editorCodeLens.foreground'),
    info: new vscode.ThemeColor('editorInfo.foreground'),
    warn: new vscode.ThemeColor('editorWarning.foreground'),
    error: new vscode.ThemeColor('editorError.foreground'),
    debug: new vscode.ThemeColor('editorCodeLens.foreground'),
    trace: new vscode.ThemeColor('editorInfo.foreground'),
    time: new vscode.ThemeColor('editorCodeLens.foreground'),
    network: new vscode.ThemeColor('editorHint.foreground')
  };

  for (const level of LEVELS) {
    const decoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: colors[level],
        margin: '0 0 0 1rem'
      }
    });
    state.decorations.set(level, decoration);
  }
}

function startServer() {
  if (state.server) {
    updateStatusBar();
    return;
  }

  const { host, port } = state.config;
  state.serverHost = host;
  state.serverPort = port;

  try {
    const wss = new WebSocket.Server({ host, port });
    state.server = wss;

    wss.on('connection', (ws, req) => {
      const clientId = ++state.clientSeq;
      state.clients.set(clientId, { ws, info: { remote: req.socket.remoteAddress } });
      sendConfigToClient(ws);

      ws.on('message', data => {
        handleClientMessage(clientId, data);
      });

      ws.on('close', () => {
        state.clients.delete(clientId);
        updateStatusBar();
        updateWebview();
      });

      ws.on('error', () => {
        state.clients.delete(clientId);
        updateStatusBar();
        updateWebview();
      });

      updateStatusBar();
      updateWebview();
    });

    wss.on('error', err => {
      vscode.window.showErrorMessage(`Console Samurai server error: ${err.message}`);
      stopServer();
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Console Samurai failed to start server: ${err.message}`);
    state.server = null;
  }

  updateStatusBar();
}

function stopServer() {
  if (!state.server) {
    updateStatusBar();
    return;
  }

  try {
    state.server.close();
  } catch (err) {
    // Ignore close errors.
  }

  state.server = null;
  state.clients.clear();
  updateStatusBar();
  updateWebview();
}

function updateStatusBar() {
  if (!state.statusBar) {
    return;
  }

  if (state.server) {
    const count = state.clients.size;
    state.statusBar.text = `$(debug-console) Console Samurai: ${state.serverHost}:${state.serverPort} (${count})`;
    state.statusBar.tooltip = 'Console Samurai server is running';
  } else {
    state.statusBar.text = '$(debug-console) Console Samurai: stopped';
    state.statusBar.tooltip = 'Console Samurai server is stopped';
  }
}

function handleClientMessage(clientId, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch (err) {
    return;
  }

  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'hello') {
    const client = state.clients.get(clientId);
    if (client) {
      client.info = Object.assign({}, client.info, message.client || {});
      updateWebview();
    }
    return;
  }

  if (message.type === 'log') {
    addLogEntry(message, clientId);
  }
}

function addLogEntry(payload, clientId) {
  const level = sanitizeLevel(payload.level || payload.kind || 'log');
  const timestamp = typeof payload.timestamp === 'number' ? payload.timestamp : Date.now();

  const entry = {
    id: ++state.logSeq,
    level,
    kind: payload.kind || payload.type || level,
    text: payload.text || '',
    values: payload.values || [],
    timestamp,
    file: payload.file || null,
    line: payload.line || null,
    column: payload.column || null,
    stack: payload.stack || null,
    url: payload.url || null,
    method: payload.method || null,
    status: payload.status || null,
    durationMs: payload.durationMs || null,
    label: payload.label || null,
    source: payload.source || null,
    clientId
  };

  state.logs.push(entry);
  trimLogs();

  if (state.config.enabledLevels.includes(entry.level)) {
    appendOutput(entry);
    if (state.inlineEnabled) {
      updateInlineForEntry(entry);
    }
  }

  updateWebview(entry);
}

function trimLogs() {
  if (state.logs.length <= state.maxLogEntries) {
    return;
  }

  const overflow = state.logs.length - state.maxLogEntries;
  state.logs.splice(0, overflow);
}

function appendOutput(entry) {
  if (!state.outputChannel) {
    return;
  }

  const time = formatTimestamp(entry.timestamp);
  const location = entry.file && entry.line ? ` ${shortenPath(entry.file)}:${entry.line}` : '';
  const text = entry.text || formatFallbackText(entry);
  state.outputChannel.appendLine(`[${time}] ${entry.level.toUpperCase()}${location} ${text}`);
}

function updateInlineForEntry(entry) {
  const resolvedPath = resolveEntryPath(entry);
  if (!resolvedPath) {
    return;
  }

  const uri = vscode.Uri.file(resolvedPath);
  const line = Math.max(0, (entry.line || 1) - 1);

  let lineState = state.lineStateByUri.get(uri.toString());
  if (!lineState) {
    lineState = new Map();
    state.lineStateByUri.set(uri.toString(), lineState);
  }

  const existing = lineState.get(line);
  const count = existing ? existing.count + 1 : 1;
  lineState.set(line, { entry, count });

  const editors = vscode.window.visibleTextEditors.filter(editor => editor.document.uri.toString() === uri.toString());
  for (const editor of editors) {
    refreshInlineForEditor(editor);
  }
}

function refreshInlineAll() {
  for (const editor of vscode.window.visibleTextEditors) {
    refreshInlineForEditor(editor);
  }
}

function refreshInlineForEditor(editor) {
  if (!editor || !editor.document) {
    return;
  }

  const uriKey = editor.document.uri.toString();
  const lineState = state.lineStateByUri.get(uriKey);

  for (const level of LEVELS) {
    editor.setDecorations(state.decorations.get(level), []);
  }

  if (!state.inlineEnabled || !lineState) {
    return;
  }

  const decorationsByLevel = new Map();
  for (const level of LEVELS) {
    decorationsByLevel.set(level, []);
  }

  for (const [line, data] of lineState.entries()) {
    const entry = data.entry;
    if (!entry || !state.config.enabledLevels.includes(entry.level)) {
      continue;
    }

    if (line < 0 || line >= editor.document.lineCount) {
      continue;
    }
    const lineText = editor.document.lineAt(line);
    const end = lineText.range.end;
    const range = new vscode.Range(end, end);
    const contentText = formatInlineText(entry, data.count);
    const hoverMessage = buildHover(entry);

    const list = decorationsByLevel.get(entry.level);
    list.push({
      range,
      renderOptions: {
        after: {
          contentText
        }
      },
      hoverMessage
    });
  }

  for (const [level, decorations] of decorationsByLevel.entries()) {
    editor.setDecorations(state.decorations.get(level), decorations);
  }
}

function formatInlineText(entry, count) {
  const maxLen = state.config.inlineMaxTextLength;
  let prefix = '';
  if (state.config.inlineShowTimestamp) {
    prefix = `[${formatTimestamp(entry.timestamp)}] `;
  }

  let text = entry.text || formatFallbackText(entry);
  if (text.length > maxLen) {
    text = text.slice(0, Math.max(0, maxLen - 3)) + '...';
  }

  let suffix = '';
  if (count > 1) {
    suffix = ` (+${count - 1})`;
  }

  return ` ${prefix}${text}${suffix}`;
}

function buildHover(entry) {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;

  md.appendMarkdown(`**${entry.level.toUpperCase()}**`);
  md.appendMarkdown(`  \n`);
  md.appendMarkdown(`Time: ${formatTimestamp(entry.timestamp)}`);

  if (entry.file && entry.line) {
    md.appendMarkdown(`  \n`);
    md.appendMarkdown(`Location: ${escapeMarkdown(shortenPath(entry.file))}:${entry.line}`);
  }

  if (entry.text) {
    md.appendMarkdown(`  \n`);
    md.appendMarkdown(`Message: ${escapeMarkdown(entry.text)}`);
  }

  if (entry.kind === 'network') {
    const networkText = `${entry.method || 'GET'} ${entry.url || ''} ${entry.status || ''} ${entry.durationMs || ''}ms`;
    md.appendMarkdown(`  \n`);
    md.appendMarkdown(`Network: ${escapeMarkdown(networkText.trim())}`);
  }

  if (entry.kind === 'time') {
    const timeText = `${entry.label || ''} ${entry.durationMs || ''}ms`;
    md.appendMarkdown(`  \n`);
    md.appendMarkdown(`Timer: ${escapeMarkdown(timeText.trim())}`);
  }

  if (entry.stack) {
    md.appendMarkdown('  \n');
    md.appendMarkdown('Stack:');
    md.appendMarkdown('  \n');
    md.appendMarkdown('```');
    md.appendMarkdown(`\n${escapeMarkdown(entry.stack)}`);
    md.appendMarkdown('\n```');
  }

  const showOutputCmd = `command:consoleSamurai.showOutput`;
  const settingsArg = encodeURIComponent(JSON.stringify('console-samurai'));
  const openSettingsCmd = `command:workbench.action.openSettings?${settingsArg}`;
  md.appendMarkdown('  \n');
  md.appendMarkdown(`[Show Output](${showOutputCmd}) | [Open Settings](${openSettingsCmd})`);

  return md;
}

function formatFallbackText(entry) {
  if (entry.kind === 'network') {
    return `${entry.method || 'GET'} ${entry.url || ''} ${entry.status || ''} ${entry.durationMs || ''}ms`.trim();
  }
  if (entry.kind === 'time') {
    return `${entry.label || 'timer'} ${entry.durationMs || ''}ms`.trim();
  }
  if (entry.values && entry.values.length) {
    return entry.values.map(value => stringifyValue(value)).join(' ');
  }
  return entry.text || '';
}

function stringifyValue(value) {
  if (value == null) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function sanitizeLevel(level) {
  if (LEVELS.includes(level)) {
    return level;
  }
  return 'log';
}

function escapeMarkdown(text) {
  if (!text) {
    return '';
  }
  return text.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function formatTimestamp(ts) {
  const date = new Date(ts);
  return date.toISOString().split('T')[1].replace('Z', '');
}

function shortenPath(filePath) {
  if (!filePath) {
    return '';
  }

  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (filePath.startsWith(root)) {
      return path.relative(root, filePath);
    }
  }
  return filePath;
}

function resolveEntryPath(entry) {
  if (!entry.file) {
    return null;
  }

  const raw = entry.file;

  if (raw.startsWith('file://')) {
    try {
      const uri = vscode.Uri.parse(raw);
      if (fs.existsSync(uri.fsPath)) {
        return uri.fsPath;
      }
    } catch (err) {
      return null;
    }
  }

  if (/^[a-zA-Z]+:\/\//.test(raw)) {
    const mapped = mapUrlToPath(raw);
    if (mapped) {
      return mapped;
    }
  }

  if (path.isAbsolute(raw) && fs.existsSync(raw)) {
    return raw;
  }

  if (!path.isAbsolute(raw)) {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      const candidate = path.join(folder.uri.fsPath, raw);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function mapUrlToPath(urlString) {
  const mappings = state.config.pathMappings || [];
  for (const mapping of mappings) {
    if (!mapping || !mapping.urlPrefix || !mapping.localPathPrefix) {
      continue;
    }
    if (urlString.startsWith(mapping.urlPrefix)) {
      let replaced = urlString.replace(mapping.urlPrefix, mapping.localPathPrefix);
      if (!path.isAbsolute(replaced)) {
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
          const candidate = path.join(folder.uri.fsPath, replaced);
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      } else if (fs.existsSync(replaced)) {
        return replaced;
      }
    }
  }

  let url;
  try {
    url = new URL(urlString);
  } catch (err) {
    return null;
  }

  const urlPath = decodeURIComponent(url.pathname || '');
  if (!urlPath) {
    return null;
  }
  const normalizedPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;

  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, normalizedPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function showOutput() {
  if (state.webviewPanel) {
    state.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
    updateWebview();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'consoleSamuraiOutput',
    'Console Samurai Output',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  panel.webview.html = getWebviewHtml(panel.webview);
  panel.onDidDispose(() => {
    state.webviewPanel = null;
  });

  panel.webview.onDidReceiveMessage(message => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'clear') {
      clearLogs();
      return;
    }

    if (message.type === 'open' && message.entryId) {
      openEntry(message.entryId);
      return;
    }

    if (message.type === 'openSettings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'console-samurai');
      return;
    }
  });

  state.webviewPanel = panel;
  updateWebview();
}

function updateWebview(newEntry) {
  if (!state.webviewPanel) {
    return;
  }

  const webview = state.webviewPanel.webview;
  const payload = {
    type: newEntry ? 'append' : 'init',
    entry: newEntry || null,
    logs: newEntry ? null : state.logs,
    enabledLevels: state.config.enabledLevels,
    clientCount: state.clients.size,
    server: state.server ? `${state.serverHost}:${state.serverPort}` : 'stopped'
  };

  webview.postMessage(payload);
}

function openEntry(entryId) {
  const entry = state.logs.find(item => item.id === entryId);
  if (!entry) {
    return;
  }

  const resolvedPath = resolveEntryPath(entry);
  if (!resolvedPath) {
    vscode.window.showWarningMessage('Console Samurai could not resolve the source file for this log entry.');
    return;
  }

  const uri = vscode.Uri.file(resolvedPath);
  vscode.workspace.openTextDocument(uri).then(doc => {
    vscode.window.showTextDocument(doc).then(editor => {
      const line = Math.max(0, (entry.line || 1) - 1);
      const column = Math.max(0, (entry.column || 1) - 1);
      const position = new vscode.Position(line, column);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(position, position);
    });
  });
}

function clearLogs() {
  state.logs = [];
  state.lineStateByUri.clear();
  state.outputChannel.clear();
  refreshInlineAll();
  updateWebview();
}

function toggleInline() {
  const next = !state.inlineEnabled;
  state.inlineEnabled = next;
  vscode.workspace.getConfiguration('console-samurai').update('inline.enabled', next, true);
  refreshInlineAll();
}

function toggleNetwork() {
  const next = !state.config.networkEnabled;
  state.config.networkEnabled = next;
  vscode.workspace.getConfiguration('console-samurai').update('network.enabled', next, true);
  broadcastConfig();
  updateWebview();
}

function broadcastConfig() {
  for (const { ws } of state.clients.values()) {
    sendConfigToClient(ws);
  }
}

function sendConfigToClient(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const config = {
    networkEnabled: state.config.networkEnabled,
    captureErrors: state.config.captureErrors,
    logCaptureOptions: state.config.logCaptureOptions
  };

  ws.send(JSON.stringify({ type: 'config', config }));
}

function updateNodeAutoAttach(context) {
  if (!context || !context.environmentVariableCollection) {
    return;
  }
  const collection = context.environmentVariableCollection;
  collection.clear();

  if (!state.config.nodeAutoAttach) {
    return;
  }

  const clientPath = path.join(context.extensionPath, 'client', 'console-samurai-node.js');
  const requirePath = clientPath.includes(' ') ? `"${clientPath}"` : clientPath;
  collection.prepend('NODE_OPTIONS', `--require ${requirePath} `);

  const configPayload = {
    host: state.config.host,
    port: state.config.port,
    captureErrors: state.config.captureErrors,
    logCaptureOptions: state.config.logCaptureOptions
  };
  collection.replace('CONSOLE_SAMURAI_CONFIG', JSON.stringify(configPayload));
}

function getWebviewHtml(webview) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'media', 'viewer.js')));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'media', 'viewer.css')));
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet" />
  <title>Console Samurai Output</title>
</head>
<body>
  <header class="toolbar">
    <div class="toolbar-left">
      <strong>Console Samurai Output</strong>
      <span id="server-status" class="muted"></span>
    </div>
    <div class="toolbar-right">
      <button id="clear">Clear</button>
      <button id="settings">Settings</button>
    </div>
  </header>
  <section class="filters">
    <input id="search" type="search" placeholder="Search logs" />
    <div id="levels" class="levels"></div>
  </section>
  <section id="log-list" class="log-list"></section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
