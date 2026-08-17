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

export function ensureTuiStdinMode(stdin) {
  safeSetRawMode(stdin, true);
  safeResume(stdin);
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
      ensureTuiStdinMode(stdin);
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

export async function runWithTuiStdinHandoff({ stdin, onData, run }) {
  if (typeof run !== 'function') throw new Error('runWithTuiStdinHandoff: run is required');
  const handoff = detachTuiStdinForChild({ stdin, onData });
  try {
    return await run();
  } finally {
    handoff.restoreForTui();
  }
}
