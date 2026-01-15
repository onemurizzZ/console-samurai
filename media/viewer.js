(() => {
  const vscode = acquireVsCodeApi();
  const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'time', 'network'];

  const state = {
    logs: [],
    enabledLevels: new Set(LEVELS),
    search: '',
    entryElements: new Map()
  };

  const logList = document.getElementById('log-list');
  const searchInput = document.getElementById('search');
  const levelsContainer = document.getElementById('levels');
  const clearButton = document.getElementById('clear');
  const settingsButton = document.getElementById('settings');
  const serverStatus = document.getElementById('server-status');

  function init() {
    renderLevelFilters();
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value.trim().toLowerCase();
      applyFilters();
    });

    clearButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    settingsButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'openSettings' });
    });
  }

  function renderLevelFilters() {
    levelsContainer.innerHTML = '';
    for (const level of LEVELS) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.enabledLevels.has(level);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.enabledLevels.add(level);
        } else {
          state.enabledLevels.delete(level);
        }
        applyFilters();
      });
      const text = document.createElement('span');
      text.textContent = level;
      label.appendChild(checkbox);
      label.appendChild(text);
      levelsContainer.appendChild(label);
    }
  }

  function applyFilters() {
    for (const entry of state.logs) {
      const el = state.entryElements.get(entry.id);
      if (!el) {
        continue;
      }
      const visible = state.enabledLevels.has(entry.level) && matchesSearch(entry);
      el.classList.toggle('hidden', !visible);
    }
  }

  function matchesSearch(entry) {
    if (!state.search) {
      return true;
    }
    const haystack = [
      entry.text || '',
      entry.file || '',
      entry.stack || '',
      entry.url || '',
      entry.method || '',
      entry.label || ''
    ].join(' ').toLowerCase();
    return haystack.includes(state.search);
  }

  function renderEntry(entry) {
    const wrapper = document.createElement('div');
    wrapper.className = `entry level-${entry.level}`;

    const header = document.createElement('div');
    header.className = 'entry-header';

    const title = document.createElement('div');
    title.className = 'entry-title';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = entry.level.toUpperCase();

    const message = document.createElement('span');
    message.className = 'entry-message';
    message.textContent = entry.text || formatFallbackText(entry);

    title.appendChild(badge);
    title.appendChild(message);

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    meta.textContent = formatMeta(entry);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', event => {
      event.stopPropagation();
      vscode.postMessage({ type: 'open', entryId: entry.id });
    });
    actions.appendChild(openBtn);

    header.appendChild(title);
    header.appendChild(meta);
    header.appendChild(actions);

    const details = document.createElement('div');
    details.className = 'entry-details';
    details.textContent = buildDetails(entry);

    wrapper.appendChild(header);
    wrapper.appendChild(details);

    header.addEventListener('click', () => {
      wrapper.classList.toggle('expanded');
    });

    return wrapper;
  }

  function formatMeta(entry) {
    const time = new Date(entry.timestamp).toISOString().split('T')[1].replace('Z', '');
    const location = entry.file && entry.line ? ` | ${entry.file}:${entry.line}` : '';
    return `${time}${location}`;
  }

  function formatFallbackText(entry) {
    if (entry.kind === 'network') {
      return `${entry.method || 'GET'} ${entry.url || ''} ${entry.status || ''} ${entry.durationMs || ''}ms`.trim();
    }
    if (entry.kind === 'time') {
      return `${entry.label || 'timer'} ${entry.durationMs || ''}ms`.trim();
    }
    return '';
  }

  function buildDetails(entry) {
    const lines = [];
    if (entry.values && entry.values.length) {
      lines.push('Values:');
      try {
        lines.push(JSON.stringify(entry.values, null, 2));
      } catch (err) {
        lines.push(String(entry.values));
      }
      lines.push('');
    }
    if (entry.stack) {
      lines.push('Stack:');
      lines.push(entry.stack);
      lines.push('');
    }
    if (entry.kind === 'network') {
      lines.push(`Network: ${entry.method || 'GET'} ${entry.url || ''} ${entry.status || ''} ${entry.durationMs || ''}ms`);
      lines.push('');
    }
    if (entry.kind === 'time') {
      lines.push(`Timer: ${entry.label || ''} ${entry.durationMs || ''}ms`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function appendEntry(entry) {
    state.logs.push(entry);
    const element = renderEntry(entry);
    state.entryElements.set(entry.id, element);
    logList.appendChild(element);
    applyFilters();
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'init') {
      state.logs = [];
      state.entryElements.clear();
      logList.innerHTML = '';

      if (Array.isArray(message.logs)) {
        for (const entry of message.logs) {
          appendEntry(entry);
        }
      }

      if (Array.isArray(message.enabledLevels)) {
        state.enabledLevels = new Set(message.enabledLevels);
        renderLevelFilters();
      }

      serverStatus.textContent = `(${message.server}, clients: ${message.clientCount})`;
      return;
    }

    if (message.type === 'append' && message.entry) {
      appendEntry(message.entry);
      serverStatus.textContent = `(${message.server}, clients: ${message.clientCount})`;
      return;
    }
  });

  init();
})();
