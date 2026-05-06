/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import process from 'node:process';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:fs';

type PromptOptions = Readonly<{
  secret?: boolean;
}>;
type ReadlineWithOutputInterceptor = Interface & {
  _writeToOutput?: (value: string) => void;
};

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function askQuestion(params: Readonly<{
  rl: Interface;
  output: NodeJS.WritableStream;
  prompt: string;
  secret: boolean;
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
    try {
      params.rl.question(params.secret ? '' : params.prompt, (value) => {
        restoreOutput();
        if (params.secret) {
          params.output.write('\n');
        }
        resolve(value);
      });
    } catch (error) {
      restoreOutput();
      if (params.secret) {
        params.output.write('\n');
      }
      reject(error);
    }
  });
}

async function promptViaDevTty(prompt: string, options: PromptOptions): Promise<string | null> {
  if (process.platform === 'win32' || !existsSync('/dev/tty')) {
    return null;
  }

  const ttyHandle = await open('/dev/tty', 'r+').catch(() => null);
  if (!ttyHandle) {
    return null;
  }

  let rl: Interface | null = null;
  let input: ReadStream | null = null;
  let output: WriteStream | null = null;

  try {
    input = ttyHandle.createReadStream();
    output = ttyHandle.createWriteStream();
    rl = createInterface({ input, output, terminal: true });
    return await askQuestion({
      rl,
      output,
      prompt,
      secret: options.secret === true,
    });
  } finally {
    rl?.close();
    input?.destroy();
    output?.destroy();
    await ttyHandle.close().catch(() => undefined);
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
    });
  } finally {
    rl.close();
  }
}

export async function promptInput(prompt: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    return promptViaProcessStdio(prompt, {});
  }

  const ttyAnswer = await promptViaDevTty(prompt, {});
  if (ttyAnswer !== null) {
    return ttyAnswer;
  }

  return promptViaProcessStdio(prompt, {});
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
