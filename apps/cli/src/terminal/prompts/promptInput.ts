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

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptViaDevTty(prompt: string): Promise<string | null> {
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
    return await new Promise<string>((resolve) => {
      rl?.question(prompt, resolve);
    });
  } finally {
    rl?.close();
    input?.destroy();
    output?.destroy();
    await ttyHandle.close().catch(() => undefined);
  }
}

async function promptViaProcessStdio(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });
  } finally {
    rl.close();
  }
}

export async function promptInput(prompt: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    return promptViaProcessStdio(prompt);
  }

  const ttyAnswer = await promptViaDevTty(prompt);
  if (ttyAnswer !== null) {
    return ttyAnswer;
  }

  return promptViaProcessStdio(prompt);
}
