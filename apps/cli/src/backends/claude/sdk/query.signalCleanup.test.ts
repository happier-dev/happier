import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('cleans up the child process when the parent receives SIGTERM (no hang)', { timeout: 30_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-sigterm-'));
    const sleeper = join(tmpRoot, `sleep-${Date.now()}.js`);
    const markerPath = join(tmpRoot, 'marker.json');
    writeFileSync(
      sleeper,
      `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const markerPath = ${JSON.stringify(markerPath)};
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        writeFileSync(markerPath, JSON.stringify({ childPid: child.pid }), 'utf8');

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
    let descendantPid: number | null = null;

    try {
      expect(process.listeners('SIGTERM').length).toBe(sigtermBefore + 1);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore + 1);

      const iter = q[Symbol.asyncIterator]();
      const nextPromise = withTimeout(iter.next(), 5_000, 'query to terminate after SIGTERM');

      const marker = await withTimeout(
        new Promise<{ childPid: number }>((resolve, reject) => {
          const startedAt = Date.now();
          const poll = () => {
            try {
              resolve(JSON.parse(readFileSync(markerPath, 'utf8')) as { childPid: number });
            } catch (error) {
              if (Date.now() - startedAt > 10_000) {
                reject(error);
                return;
              }
              setTimeout(poll, 25);
            }
          };
          poll();
        }),
        11_000,
        'descendant marker before SIGTERM',
      );
      descendantPid = marker.childPid;

      process.emit('SIGTERM');

      await expect(nextPromise).rejects.toThrow(/Claude Code process/i);
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const check = () => {
            try {
              process.kill(marker.childPid, 0);
              if (Date.now() - startedAt > 10_000) {
                reject(new Error(`Timed out waiting for descendant ${marker.childPid} to exit`));
                return;
              }
              setTimeout(check, 25);
            } catch {
              resolve();
            }
          };
          check();
        }),
        11_000,
        'descendant process cleanup after SIGTERM',
      );

      // Allow processExitPromise.finally() to run and detach listeners.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.listeners('SIGTERM').length).toBe(sigtermBefore);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore);
    } finally {
      abortController.abort();
      if (descendantPid !== null) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });
});
