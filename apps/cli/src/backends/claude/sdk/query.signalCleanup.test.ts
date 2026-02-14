import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { query } from './query';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

describe('claude sdk query signal cleanup', () => {
  let tmpRoot = '';

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it('cleans up the child process when the parent receives SIGTERM (no hang)', { timeout: 20_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-sigterm-'));
    const sleeper = join(tmpRoot, `sleep-${Date.now()}.js`);
    writeFileSync(
      sleeper,
      `
        // Stay alive until the parent terminates us.
        setInterval(() => {}, 1000);
      `,
      'utf8',
    );

    const abortController = new AbortController();

    const sigtermBefore = process.listeners('SIGTERM').length;
    const sigintBefore = process.listeners('SIGINT').length;

    const q = query({
      prompt: 'hi',
      options: {
        cwd: tmpRoot,
        executable: process.execPath,
        executableArgs: [],
        pathToClaudeCodeExecutable: sleeper,
        abort: abortController.signal,
      },
    });

    try {
      expect(process.listeners('SIGTERM').length).toBe(sigtermBefore + 1);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore + 1);

      const iter = q[Symbol.asyncIterator]();
      const nextPromise = withTimeout(iter.next(), 5_000, 'query to terminate after SIGTERM');

      process.emit('SIGTERM');

      await expect(nextPromise).rejects.toThrow(/Claude Code process/i);

      // Allow processExitPromise.finally() to run and detach listeners.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.listeners('SIGTERM').length).toBe(sigtermBefore);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore);
    } finally {
      abortController.abort();
    }
  });
});
