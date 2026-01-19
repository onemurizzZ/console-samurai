'use strict';

const WebSocket = require('ws');
const { performance } = require('perf_hooks');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4973,
  autoStart: true,
  captureConsole: true,
  captureErrors: true,
  logCaptureOptions: {
    maxDepth: 4,
    maxProps: 50,
    maxArray: 50,
    maxStringLength: 2000
  }
};

function parseEnvConfig(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.port === 'string') {
        const num = Number(parsed.port);
        if (!Number.isNaN(num)) {
          parsed.port = num;
        }
      }
      return parsed;
    }
  } catch (err) {
    // Ignore invalid config.
  }
  return {};
}

const envConfig = parseEnvConfig(process.env.CONSOLE_SAMURAI_CONFIG);

const state = {
  ws: null,
  queue: [],
  connected: false,
  config: Object.assign({}, DEFAULTS, envConfig, global.__CONSOLE_SAMURAI__ || {}),
  timers: new Map(),
  installed: false,
  originals: {}
};

function start(options) {
  if (options && typeof options === 'object') {
    state.config = Object.assign({}, state.config, options);
  }
  install();
  connect();
}

function stop() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

function install() {
  if (state.installed) {
    return;
  }
  state.installed = true;

  patchConsole();
  patchTimers();
  captureErrors();
}

function connect() {
  if (state.ws) {
    return;
  }

  const url = `ws://${state.config.host}:${state.config.port}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.on('open', () => {
    state.connected = true;
    flushQueue();
    send({ type: 'hello', client: { runtime: 'node', pid: process.pid } });
    unrefSocket(ws);
  });

  ws.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'config') {
        state.config = Object.assign({}, state.config, message.config || {});
      }
    } catch (err) {
      // Ignore.
    }
  });

  ws.on('close', () => {
    state.connected = false;
    state.ws = null;
    retryConnect();
  });

  ws.on('error', () => {
    state.connected = false;
  });
}

function retryConnect() {
  const timer = setTimeout(() => {
    if (!state.ws) {
      connect();
    }
  }, 1500);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function send(payload) {
  if (!payload) {
    return;
  }

  if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    state.queue.push(payload);
    return;
  }

  state.ws.send(JSON.stringify(payload));
}

function flushQueue() {
  while (state.queue.length) {
    send(state.queue.shift());
  }
}

function patchConsole() {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (const method of methods) {
    const original = console[method];
    state.originals[method] = original;
    console[method] = function () {
      const args = Array.prototype.slice.call(arguments);
      if (original) {
        try {
          original.apply(console, args);
        } catch (err) {
          // ignore
        }
      }

      if (!state.config.captureConsole) {
        return;
      }

      const stack = method === 'trace' ? new Error().stack : captureStack();
      const location = extractLocation(stack);
      send({
        type: 'log',
        kind: method === 'trace' ? 'trace' : method,
        level: method === 'trace' ? 'trace' : method,
        text: formatPreview(args),
        values: serializeValues(args),
        timestamp: Date.now(),
        stack: stack || null,
        file: location.file,
        line: location.line,
        column: location.column,
        source: 'node'
      });
    };
  }
}

function patchTimers() {
  const originalTime = console.time;
  const originalTimeEnd = console.timeEnd;
  const originalTimeLog = console.timeLog;

  console.time = function (label) {
    const key = label || 'default';
    state.timers.set(key, now());
    if (originalTime) {
      originalTime.call(console, label);
    }
  };

  console.timeLog = function (label) {
    const key = label || 'default';
    const start = state.timers.get(key);
    if (start != null) {
      const durationMs = Math.round((now() - start) * 1000) / 1000;
      const stack = captureStack();
      const location = extractLocation(stack);
      send({
        type: 'log',
        kind: 'time',
        level: 'time',
        text: `${key} ${durationMs}ms`,
        values: [{ label: key, durationMs }],
        timestamp: Date.now(),
        stack: stack || null,
        file: location.file,
        line: location.line,
        column: location.column,
        label: key,
        durationMs,
        source: 'node'
      });
    }
    if (originalTimeLog) {
      originalTimeLog.call(console, label);
    }
  };

  console.timeEnd = function (label) {
    const key = label || 'default';
    const start = state.timers.get(key);
    if (start != null) {
      const durationMs = Math.round((now() - start) * 1000) / 1000;
      const stack = captureStack();
      const location = extractLocation(stack);
      send({
        type: 'log',
        kind: 'time',
        level: 'time',
        text: `${key} ${durationMs}ms`,
        values: [{ label: key, durationMs }],
        timestamp: Date.now(),
        stack: stack || null,
        file: location.file,
        line: location.line,
        column: location.column,
        label: key,
        durationMs,
        source: 'node'
      });
    }
    state.timers.delete(key);
    if (originalTimeEnd) {
      originalTimeEnd.call(console, label);
    }
  };
}

function captureErrors() {
  if (!state.config.captureErrors) {
    return;
  }

  process.on('uncaughtException', error => {
    const stack = error && error.stack ? error.stack : captureStack();
    const location = extractLocation(stack);
    send({
      type: 'log',
      kind: 'error',
      level: 'error',
      text: error && error.message ? error.message : 'Uncaught exception',
      values: serializeValues([error]),
      timestamp: Date.now(),
      stack: stack || null,
      file: location.file,
      line: location.line,
      column: location.column,
      source: 'node'
    });
  });

  process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const stack = error && error.stack ? error.stack : captureStack();
    const location = extractLocation(stack);
    send({
      type: 'log',
      kind: 'error',
      level: 'error',
      text: error.message || 'Unhandled rejection',
      values: serializeValues([error]),
      timestamp: Date.now(),
      stack: stack || null,
      file: location.file,
      line: location.line,
      column: location.column,
      source: 'node'
    });
  });
}

function captureStack() {
  try {
    throw new Error();
  } catch (err) {
    return err.stack || '';
  }
}

function extractLocation(stack) {
  if (!stack) {
    return { file: null, line: null, column: null };
  }
  const lines = stack.split('\n').slice(1);
  for (const line of lines) {
    if (line.includes('console-samurai') || line.includes('node:internal') || line.includes('(internal')) {
      continue;
    }
    const match = line.match(/((?:[a-zA-Z]:)?[^\s\)]+):(\d+):(\d+)/);
    if (match) {
      const file = match[1].startsWith('(') ? match[1].slice(1) : match[1];
      return {
        file,
        line: Number(match[2]),
        column: Number(match[3])
      };
    }
  }
  return { file: null, line: null, column: null };
}

function serializeValues(values) {
  const options = state.config.logCaptureOptions || DEFAULTS.logCaptureOptions;
  return values.map(value => serializeValue(value, options, 0, new WeakSet()));
}

  function serializeValue(value, options, depth, seen) {
    const type = typeof value;
    if (value === null || type === 'undefined' || type === 'number' || type === 'boolean') {
      return value;
    }
    if (type === 'bigint') {
      return value.toString();
    }
    if (type === 'symbol') {
      return value.toString();
    }
    if (type === 'string') {
      if (value.length > options.maxStringLength) {
        return value.slice(0, options.maxStringLength) + '...';
      }
      return value;
  }
  if (type === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth >= options.maxDepth) {
    return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, options.maxArray);
    const arr = [];
    for (let i = 0; i < limit; i += 1) {
      arr.push(serializeValue(value[i], options, depth + 1, seen));
    }
    if (value.length > limit) {
      arr.push(`... (${value.length - limit} more)`);
    }
    return arr;
  }
  const keys = Object.keys(value);
  const limit = Math.min(keys.length, options.maxProps);
  const obj = {};
  for (let i = 0; i < limit; i += 1) {
    const key = keys[i];
    obj[key] = serializeValue(value[key], options, depth + 1, seen);
  }
  if (keys.length > limit) {
    obj.__truncated__ = `${keys.length - limit} more keys`;
  }
  return obj;
}

function formatPreview(values) {
  return values.map(value => previewValue(value)).join(' ');
}

function previewValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function now() {
  if (performance && typeof performance.now === 'function') {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

function unrefSocket(ws) {
  if (ws && ws._socket && typeof ws._socket.unref === 'function') {
    ws._socket.unref();
  }
}

if (state.config.autoStart) {
  start();
}

module.exports = {
  start,
  stop,
  send
};
