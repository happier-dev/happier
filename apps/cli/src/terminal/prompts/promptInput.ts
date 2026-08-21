/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { closeSync, existsSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Decide whether we can ask the user a question, given what the process can see.
 *
 * Pure so the `curl | bash` case can be tested without a terminal.
 */
export function resolveInteractiveTerminal(params: Readonly<{
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  platform: NodeJS.Platform | string;
  hasControllingTty: () => boolean;
  /**
   * A caller has stated that nobody is watching this run, whatever the terminal
   * looks like. Installers set this for their whole run, and `happier setup
   * --yes` sets it for the commands it spawns — a controlling terminal is still
   * attached in both cases, so nothing below can tell.
   */
  unattended?: boolean;
}>): boolean {
  if (params.unattended) {
    return false;
  }
  if (params.stdinIsTty && params.stdoutIsTty) {
    return true;
  }
  if (params.platform === 'win32') {
    return false;
  }
  return params.hasControllingTty();
}

/**
 * A device node at /dev/tty is not proof of a terminal — in a container it can
 * exist and still fail to open with ENXIO. Opening it is the only real check.
 */
function hasControllingTty(): boolean {
  let fd: number | null = null;
  try {
    fd = openSync('/dev/tty', 'r+');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: we only opened it to find out whether we could.
      }
    }
  }
}

/**
 * Whether the CLI can prompt.
 *
 * `process.stdin` is not the whole story. Under `curl … | bash -s -- --run <cmd>`
 * the installer hands us an exhausted pipe on stdin while the user is still sat
 * at a terminal — and `promptInput` below already prompts through a freshly
 * opened /dev/tty in exactly that case. Gating on stdin alone made every
 * installer-invoked command run blind, which is why those call sites had to pass
 * `--yes`.
 */
export function isInteractiveTerminal(): boolean {
  return resolveInteractiveTerminal({
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    platform: process.platform,
    hasControllingTty,
    unattended: String(process.env.HAPPIER_NONINTERACTIVE ?? '') === '1',
  });
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
