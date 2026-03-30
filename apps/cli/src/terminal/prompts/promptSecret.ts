/**
 * Terminal secret prompt helper
 *
 * Prompts for a secret value without echoing input (TTY-only).
 */

import { createInterface } from 'node:readline';

import { isInteractiveTerminal } from './promptInput';

export async function promptSecret(promptLabel: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('promptSecret requires an interactive terminal.');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const rlAny = rl as unknown as {
    stdoutMuted?: boolean;
    _writeToOutput?: (stringToWrite: string) => void;
    output?: NodeJS.WritableStream;
  };
  const output = rlAny.output ?? process.stdout;

  const writeToOutputOriginal = rlAny._writeToOutput?.bind(rl);
  rlAny.stdoutMuted = false;

  if (writeToOutputOriginal) {
    rlAny._writeToOutput = (stringToWrite: string) => {
      if (rlAny.stdoutMuted) return;
      writeToOutputOriginal(stringToWrite);
    };
  }

  try {
    return await new Promise<string>((resolve, reject) => {
      output.write(promptLabel);
      rlAny.stdoutMuted = true;

      rl.once('SIGINT', () => {
        rlAny.stdoutMuted = false;
        output.write('\n');
        rl.close();
        reject(new Error('Cancelled.'));
      });

      rl.question('', (answer) => {
        rlAny.stdoutMuted = false;
        output.write('\n');
        rl.close();
        resolve(answer);
      });
    });
  } finally {
    rlAny.stdoutMuted = false;
    rl.close();
  }
}
