(function (global) {
  'use strict';

  const DEFAULTS = {
    host: '127.0.0.1',
    port: 4973,
    autoStart: true,
    captureConsole: true,
    captureErrors: true,
    networkEnabled: true,
    logCaptureOptions: {
      maxDepth: 4,
      maxProps: 50,
      maxArray: 50,
      maxStringLength: 2000
    }
  };

  const state = {
    ws: null,
    queue: [],
    connected: false,
    config: Object.assign({}, DEFAULTS, global.__CONSOLE_SAMURAI__ || {}),
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
    patchNetwork();
    captureErrors();
  }

  function connect() {
    if (state.ws) {
      return;
    }

    const url = `ws://${state.config.host}:${state.config.port}`;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.connected = true;
      flushQueue();
      send({ type: 'hello', client: { runtime: 'browser' } });
    });

    ws.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'config') {
          state.config = Object.assign({}, state.config, message.config || {});
        }
      } catch (err) {
        // Ignore.
      }
    });

    ws.addEventListener('close', () => {
      state.connected = false;
      state.ws = null;
      retryConnect();
    });

    ws.addEventListener('error', () => {
      state.connected = false;
    });
  }

  function retryConnect() {
    setTimeout(() => {
      if (!state.ws) {
        connect();
      }
    }, 1500);
  }

  function send(payload) {
    if (!payload) {
      return;
    }

    if (!state.connected || !state.ws || state.ws.readyState !== 1) {
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
          source: 'browser'
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
          source: 'browser'
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
          source: 'browser'
        });
      }
      state.timers.delete(key);
      if (originalTimeEnd) {
        originalTimeEnd.call(console, label);
      }
    };
  }

  function patchNetwork() {
    if (!global.fetch) {
      return;
    }

    const originalFetch = global.fetch.bind(global);
    state.originals.fetch = originalFetch;

    global.fetch = function (input, init) {
      if (!state.config.networkEnabled) {
        return originalFetch(input, init);
      }
      const start = now();
      const method = (init && init.method) || 'GET';
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      return originalFetch(input, init).then(response => {
        const durationMs = Math.round((now() - start) * 1000) / 1000;
        send({
          type: 'log',
          kind: 'network',
          level: 'network',
          text: `${method} ${url} ${response.status} ${durationMs}ms`,
          timestamp: Date.now(),
          url,
          method,
          status: response.status,
          durationMs,
          source: 'browser'
        });
        return response;
      }).catch(err => {
        const durationMs = Math.round((now() - start) * 1000) / 1000;
        send({
          type: 'log',
          kind: 'network',
          level: 'network',
          text: `${method} ${url} ERROR ${durationMs}ms`,
          timestamp: Date.now(),
          url,
          method,
          status: 'ERR',
          durationMs,
          values: serializeValues([err]),
          source: 'browser'
        });
        throw err;
      });
    };

    if (global.XMLHttpRequest) {
      const proto = global.XMLHttpRequest.prototype;
      if (!proto.__consoleSamuraiPatched) {
        proto.__consoleSamuraiPatched = true;
        const originalOpen = proto.open;
        const originalSend = proto.send;

        proto.open = function (method, url) {
          this.__consoleSamuraiMethod = method;
          this.__consoleSamuraiUrl = url;
          return originalOpen.apply(this, arguments);
        };

        proto.send = function () {
          if (!state.config.networkEnabled) {
            return originalSend.apply(this, arguments);
          }

          const start = now();
          const method = this.__consoleSamuraiMethod || 'GET';
          const url = this.__consoleSamuraiUrl || '';
          const onDone = () => {
            const durationMs = Math.round((now() - start) * 1000) / 1000;
            send({
              type: 'log',
              kind: 'network',
              level: 'network',
              text: `${method} ${url} ${this.status} ${durationMs}ms`,
              timestamp: Date.now(),
              url,
              method,
              status: this.status,
              durationMs,
              source: 'browser'
            });
            this.removeEventListener('loadend', onDone);
          };
          this.addEventListener('loadend', onDone);
          return originalSend.apply(this, arguments);
        };
      }
    }
  }

  function captureErrors() {
    if (!state.config.captureErrors || !global.addEventListener) {
      return;
    }

    global.addEventListener('error', event => {
      const error = event.error || new Error(event.message);
      const stack = error && error.stack ? error.stack : captureStack();
      const location = extractLocation(stack);
      send({
        type: 'log',
        kind: 'error',
        level: 'error',
        text: error ? error.message : 'Runtime error',
        values: serializeValues([error]),
        timestamp: Date.now(),
        stack: stack || null,
        file: location.file,
        line: location.line,
        column: location.column,
        source: 'browser'
      });
    });

    global.addEventListener('unhandledrejection', event => {
      const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
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
        source: 'browser'
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
      if (line.includes('console-samurai')) {
        continue;
      }
      const match = line.match(/([a-zA-Z]+:\/\/[^\s\)]+|\/[^\s\)]+):(\d+):(\d+)/);
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
    if (typeof Element !== 'undefined' && value instanceof Element) {
      return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ''}>`;
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
    if (global.performance && typeof global.performance.now === 'function') {
      return global.performance.now() / 1000;
    }
    return Date.now() / 1000;
  }

  if (state.config.autoStart) {
    start();
  }

  global.ConsoleSamurai = {
    start,
    stop,
    send
  };
})(typeof window !== 'undefined' ? window : this);
