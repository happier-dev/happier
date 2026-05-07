/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Read a line from the user.
 *
 * On Unix we always prompt through a freshly-opened `/dev/tty` when it's
 * available, regardless of what `process.stdin` looks like. This matters for
 * the `curl | bash` installer path, where the installer wraps
 * `doctor repair </dev/tty` but Node's readline-on-the-redirected-fd can
 * wedge the terminal (typed keys don't register, Ctrl+C is swallowed).
 * Opening `/dev/tty` fresh sidesteps that entirely and also works for
 * normal interactive runs (same physical device, just a different fd).
 *
 * On Windows (or if `/dev/tty` isn't accessible), fall back to
 * `process.stdin` / `process.stdout`.
 */
export async function promptInput(prompt: string): Promise<string> {
  if (process.platform !== 'win32' && existsSync('/dev/tty')) {
    const ttyHandle = await open('/dev/tty', 'r+').catch(() => null);
    if (ttyHandle) {
      const input = ttyHandle.createReadStream();
      const output = ttyHandle.createWriteStream();
      // `terminal: false` — FileHandle-backed streams on /dev/tty don't expose
      // the TTY setRawMode API, so readline can't actually switch to raw mode.
      // If we let readline believe it's in terminal mode anyway, it emits its
      // own character echo while the kernel (canonical mode) ALSO echoes each
      // keystroke → you see "yy" on screen. With `terminal: false`, readline
      // operates in line-mode and the kernel handles echo cleanly.
      const rl = createInterface({ input, output, terminal: false });
      try {
        output.write(prompt);
        return await new Promise<string>((resolve) => {
          rl.once('line', (line) => resolve(line));
        });
      } finally {
        rl.close();
        input.destroy();
        output.destroy();
        await ttyHandle.close().catch(() => undefined);
      }
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(prompt, resolve));
  } finally {
    rl.close();
  }
}
