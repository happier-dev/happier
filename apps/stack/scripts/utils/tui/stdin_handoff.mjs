function safeSetRawMode(stdin, enabled) {
  try {
    if (stdin && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(Boolean(enabled));
    }
  } catch {
    // ignore
  }
}

function safePause(stdin) {
  try {
    if (stdin && typeof stdin.pause === 'function') stdin.pause();
  } catch {
    // ignore
  }
}

function safeResume(stdin) {
  try {
    if (stdin && typeof stdin.resume === 'function') stdin.resume();
  } catch {
    // ignore
  }
}

/**
 * When we spawn a child with stdio: 'inherit', the child and the TUI compete for the same stdin FD.
 * If the TUI keeps reading, it will consume keystrokes before the child sees them.
 *
 * Detach the TUI's stdin handler + pause stdin so the child can read deterministically.
 */
export function detachTuiStdinForChild({ stdin, onData }) {
  const hadListener = Boolean(stdin && typeof stdin.off === 'function' && typeof onData === 'function');
  if (hadListener) {
    try {
      stdin.off('data', onData);
    } catch {
      // ignore
    }
  }

  // Stop Node from reading stdin so the child can read directly from the terminal.
  safePause(stdin);
  safeSetRawMode(stdin, false);

  return {
    restoreForTui() {
      safeSetRawMode(stdin, true);
      safeResume(stdin);
      if (hadListener) {
        try {
          stdin.on('data', onData);
        } catch {
          // ignore
        }
      }
    },
  };
}

export async function waitForEnter({ stdin, timeoutMs = 120_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await new Promise((resolve) => {
      const onData = (d) => {
        cleanup();
        resolve(d);
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        try {
          stdin?.off?.('data', onData);
        } catch {
          // ignore
        }
        try {
          stdin?.off?.('end', onEnd);
        } catch {
          // ignore
        }
      };

      try {
        stdin?.on?.('data', onData);
        stdin?.on?.('end', onEnd);
      } catch {
        resolve(null);
      }
    });

    const s = chunk == null ? '' : String(chunk);
    if (s.includes('\n') || s.includes('\r')) return true;
  }
  return false;
}

