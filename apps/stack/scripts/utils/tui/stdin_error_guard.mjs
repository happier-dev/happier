function normalizeErrCode(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return typeof code === 'string' ? code : '';
}

/**
 * Guard against `process.stdin` emitting an 'error' event (notably `read EIO` on TTY)
 * during restart/shutdown transitions. Without a listener, Node treats it as unhandled
 * and crashes the TUI.
 */
export function installTuiStdinErrorGuard({ stdin, onError } = {}) {
  const s = stdin;
  if (!s || typeof s.on !== 'function') {
    return { uninstall() {} };
  }

  const cb = typeof onError === 'function' ? onError : null;
  const handler = (err) => {
    // Never throw from here: this is running inside an 'error' event.
    try {
      cb?.(err);
    } catch {
      // ignore
    }

    // Swallow all stdin read errors. In practice this is most often:
    // - darwin/linux: Error: read EIO
    // When it happens during a restart, we prefer keeping the TUI alive.
    void normalizeErrCode(err);
  };

  try {
    s.on('error', handler);
  } catch {
    return { uninstall() {} };
  }

  return {
    uninstall() {
      try {
        s.off?.('error', handler);
      } catch {
        // ignore
      }
    },
  };
}
