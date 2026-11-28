/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { closeSync, createWriteStream, existsSync, openSync, type WriteStream } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { ReadStream } from 'node:tty';

export type PromptAnimation = Readonly<{
  animate?: boolean;
  /** Milliseconds between redraws, or a function of elapsed seconds for a cadence that changes over time. */
  intervalMs?: number | ((elapsedSeconds: number) => number);
  render: (elapsedSeconds: number) => string;
  onMove?: (delta: -1 | 1) => void;
  onToggle?: () => void;
  answerOnEmpty?: () => string;
}>;

type PromptOptions = Readonly<{
  secret?: boolean;
  signal?: AbortSignal;
  animation?: PromptAnimation;
  output?: 'stderr';
}>;
type TerminalOutput = NodeJS.WritableStream & { columns?: number; rows?: number };
type ReadlineWithOutputInterceptor = Interface & {
  _writeToOutput?: (value: string) => void;
};

async function flushAndEndTtyOutput(output: WriteStream): Promise<void> {
  if (output.destroyed || output.writableEnded) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      output.off('finish', finish);
      output.off('error', finish);
      resolve();
    };
    output.once('finish', finish);
    output.once('error', finish);
    output.end();
  });
}

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
}>): boolean {
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
 * opened /dev/tty in exactly that case. Gating on stdin alone makes every
 * installer-invoked command run blind, `happier setup` included.
 */
export function isInteractiveTerminal(output?: 'stderr'): boolean {
  return resolveInteractiveTerminal({
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean((output === 'stderr' ? process.stderr : process.stdout).isTTY),
    platform: process.platform,
    hasControllingTty,
  });
}

function askQuestion(params: Readonly<{
  rl: Interface;
  input: NodeJS.ReadableStream;
  output: TerminalOutput;
  prompt: string;
  secret: boolean;
  signal?: AbortSignal;
  animation?: PromptAnimation;
}>): Promise<string> {
  const rl = params.rl as ReadlineWithOutputInterceptor;
  const originalWriteToOutput = rl._writeToOutput;
  const restoreOutput = () => {
    if (originalWriteToOutput) {
      rl._writeToOutput = originalWriteToOutput;
    }
  };
  if (params.secret) {
    params.output.write(params.prompt);
    if (originalWriteToOutput) {
      rl._writeToOutput = () => undefined;
    }
  }
  // A secret prompt never redraws: its echo is suppressed and must stay that way.
  const animation = params.secret ? undefined : params.animation;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onKeypress: ((value: string, key?: Readonly<{ name?: string }>) => void) | null = null;
  let onResize: (() => void) | null = null;
  const stopAnimation = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (onKeypress) params.input.removeListener('keypress', onKeypress);
    onKeypress = null;
    if (onResize) {
      params.output.removeListener('resize', onResize);
      if (params.output !== process.stdout) process.stdout.removeListener('resize', onResize);
      process.removeListener('SIGWINCH', onResize);
    }
    onResize = null;
  };
  // Redraw the prompt in place (readline owns the cursor), move the highlight on ↑/↓,
  // and stop redrawing once the terminal is resized or the prompt reaches its last row.
  const startAnimation = (current: PromptAnimation, abort: () => void): void => {
    const startedAt = Date.now();
    const initialColumns = params.output.columns;
    const initialRows = params.output.rows;
    let redrawEnabled = true;
    const canRedraw = (): boolean => {
      const cursor = params.rl.getCursorPos();
      return (params.output === process.stdout || (typeof initialColumns === 'number' && typeof initialRows === 'number'))
        && params.output.columns === initialColumns
        && params.output.rows === initialRows
        && !(typeof initialRows === 'number' && cursor.rows >= initialRows - 1);
    };
    const stopRedraw = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      redrawEnabled = false;
    };
    // A freshly opened /dev/tty WriteStream keeps its initial dimensions.
    // Stop on the resize notification rather than trusting those cached fields.
    onResize = stopRedraw;
    params.output.on('resize', onResize);
    if (params.output !== process.stdout) process.stdout.on('resize', onResize);
    if (process.platform !== 'win32') process.on('SIGWINCH', onResize);
    const redraw = (): void => {
      if (!canRedraw()) {
        stopRedraw();
        return;
      }
      const elapsedSeconds = current.animate === false ? 0 : (Date.now() - startedAt) / 1000;
      params.rl.setPrompt(current.render(elapsedSeconds));
      params.rl.prompt(true);
    };
    onKeypress = (_value, key) => {
      if (key?.name === 'escape') {
        abort();
        return;
      }
      const isToggle = key?.name === 'space' || _value === ' ';
      if (!redrawEnabled || (key?.name !== 'up' && key?.name !== 'down' && !isToggle)) return;
      if (!canRedraw()) {
        stopRedraw();
        return;
      }
      if (isToggle) {
        current.onToggle?.();
        params.rl.write(null, { ctrl: true, name: 'u' });
      } else {
        current.onMove?.(key?.name === 'up' ? -1 : 1);
      }
      redraw();
    };
    params.input.on('keypress', onKeypress);
    if (current.animate === false) return;
    const nextDelay = (): number => {
      const interval = current.intervalMs;
      const value = typeof interval === 'function' ? interval((Date.now() - startedAt) / 1000) : interval;
      return Math.max(40, value ?? 120);
    };
    const tick = (): void => {
      redraw();
      if (timer === null) return;
      timer = setTimeout(tick, nextDelay());
      timer.unref?.();
    };
    timer = setTimeout(tick, nextDelay());
    timer.unref?.();
  };
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      stopAnimation();
      params.signal?.removeEventListener('abort', onAbort);
      params.rl.removeListener('SIGINT', onAbort);
      params.rl.removeListener('close', onAbort);
      restoreOutput();
      if (params.secret) {
        params.output.write('\n');
      }
      settle();
    };
    const onAbort = (): void => {
      const error = new Error('Terminal prompt aborted');
      error.name = 'AbortError';
      finish(() => reject(error));
    };
    // A pipe consumed by an earlier private-input read will not emit end again.
    // Readline otherwise leaves this question pending forever.
    if (params.signal?.aborted || ('readableEnded' in params.input && params.input.readableEnded === true)) {
      onAbort();
      return;
    }
    params.rl.once('SIGINT', onAbort);
    params.rl.once('close', onAbort);
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (animation) startAnimation(animation, onAbort);
    try {
      params.rl.question(params.secret ? '' : params.prompt, (value) => {
        const answer = value === '' && animation?.answerOnEmpty ? animation.answerOnEmpty() : value;
        finish(() => resolve(answer));
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

async function promptViaDevTty(prompt: string, options: PromptOptions): Promise<string | null> {
  if (process.platform === 'win32' || !existsSync('/dev/tty')) {
    return null;
  }

  let inputFd: number | null = null;
  let outputFd: number | null = null;
  let input: ReadStream | null = null;
  let output: WriteStream | null = null;
  const selectedOutput = options.output === 'stderr' ? process.stderr : process.stdout;
  try {
    inputFd = openSync('/dev/tty', 'r+');
    input = new ReadStream(inputFd);
    inputFd = null;
    // Borrow the selected terminal stream: fresh TTY output fails with EINVAL/kqueue on macOS Bun.
    // This must not discard the independent input needed by installer redirects.
    if (!selectedOutput.isTTY) {
      // File output avoids Bun's TTY constructor; terminal stderr supplies live geometry when available.
      outputFd = openSync('/dev/tty', 'r+');
      output = Object.defineProperties(createWriteStream('/dev/tty', { fd: outputFd, autoClose: true }), {
        columns: { get: () => process.stderr.isTTY ? process.stderr.columns : undefined },
        rows: { get: () => process.stderr.isTTY ? process.stderr.rows : undefined },
      });
      outputFd = null;
    }
  } catch {
    input?.destroy();
    output?.destroy();
    if (inputFd !== null) closeSync(inputFd);
    if (outputFd !== null) closeSync(outputFd);
    return null;
  }

  let rl: Interface | null = null;

  try {
    const promptOutput = output ?? selectedOutput;
    rl = createInterface({ input, output: promptOutput, terminal: true });
    return await askQuestion({
      rl,
      input,
      output: promptOutput,
      prompt,
      secret: options.secret === true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.animation ? { animation: options.animation } : {}),
    });
  } finally {
    rl?.close();
    input?.destroy();
    if (output) await flushAndEndTtyOutput(output);
    output?.destroy();
  }
}

async function promptViaProcessStdio(prompt: string, options: PromptOptions): Promise<string> {
  const output = options.output === 'stderr' ? process.stderr : process.stdout;
  const rl = createInterface({
    input: process.stdin,
    output,
    ...(options.secret && process.stdin.isTTY ? { terminal: true } : {}),
  });
  try {
    return await askQuestion({
      rl,
      input: process.stdin,
      output,
      prompt,
      secret: options.secret === true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.animation && process.stdin.isTTY && output.isTTY ? { animation: options.animation } : {}),
    });
  } finally {
    rl.close();
  }
}

export async function promptInput(
  prompt: string,
  options: PromptOptions = {},
): Promise<string> {
  if (!isInteractiveTerminal(options.output)) {
    return promptViaProcessStdio(prompt, options);
  }

  const ttyAnswer = await promptViaDevTty(prompt, options);
  if (ttyAnswer !== null) {
    return ttyAnswer;
  }

  return promptViaProcessStdio(prompt, options);
}

export async function promptSecretInput(prompt: string, options: Pick<PromptOptions, 'signal'> = {}): Promise<string> {
  const secretOptions = { ...options, secret: true };
  if (!isInteractiveTerminal()) {
    return promptViaProcessStdio(prompt, secretOptions);
  }

  const ttyAnswer = await promptViaDevTty(prompt, secretOptions);
  if (ttyAnswer !== null) {
    return ttyAnswer;
  }

  return promptViaProcessStdio(prompt, secretOptions);
}
