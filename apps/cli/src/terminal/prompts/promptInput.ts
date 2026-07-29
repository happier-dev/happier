/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { closeSync, existsSync, openSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { ReadStream, WriteStream } from 'node:tty';

type PromptOptions = Readonly<{
  secret?: boolean;
  signal?: AbortSignal;
}>;
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

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function askQuestion(params: Readonly<{
  rl: Interface;
  output: NodeJS.WritableStream;
  prompt: string;
  secret: boolean;
  signal?: AbortSignal;
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
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', onAbort);
      params.rl.removeListener('SIGINT', onAbort);
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
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    params.rl.once('SIGINT', onAbort);
    params.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      params.rl.question(params.secret ? '' : params.prompt, (value) => {
        finish(() => resolve(value));
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
  try {
    inputFd = openSync('/dev/tty', 'r+');
    outputFd = openSync('/dev/tty', 'r+');
    input = new ReadStream(inputFd);
    inputFd = null;
    output = new WriteStream(outputFd);
    outputFd = null;
  } catch {
    input?.destroy();
    output?.destroy();
    if (inputFd !== null) closeSync(inputFd);
    if (outputFd !== null) closeSync(outputFd);
    return null;
  }

  let rl: Interface | null = null;

  try {
    rl = createInterface({ input, output, terminal: true });
    return await askQuestion({
      rl,
      output,
      prompt,
      secret: options.secret === true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } finally {
    rl?.close();
    input?.destroy();
    if (output) await flushAndEndTtyOutput(output);
    output?.destroy();
  }
}

async function promptViaProcessStdio(prompt: string, options: PromptOptions): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await askQuestion({
      rl,
      output: process.stdout,
      prompt,
      secret: options.secret === true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } finally {
    rl.close();
  }
}

export async function promptInput(
  prompt: string,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<string> {
  if (!isInteractiveTerminal()) {
    return promptViaProcessStdio(prompt, options);
  }

  const ttyAnswer = await promptViaDevTty(prompt, options);
  if (ttyAnswer !== null) {
    return ttyAnswer;
  }

  return promptViaProcessStdio(prompt, options);
}

export async function promptSecretInput(prompt: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    return promptViaProcessStdio(prompt, { secret: true });
  }

  const ttyAnswer = await promptViaDevTty(prompt, { secret: true });
  if (ttyAnswer !== null) {
    return ttyAnswer;
  }

  return promptViaProcessStdio(prompt, { secret: true });
}
