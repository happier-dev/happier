import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

function createTempJsScript(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-claude-sdk-query-'));
  const file = join(dir, 'fake-claude.js');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('claude sdk query exit handling', () => {
  let tmpRoot = '';

  afterEach(() => {
    vi.doUnmock('ps-list');
    vi.resetModules();

    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it('rejects the consumer when the subprocess exits non-zero (no hang)', async () => {
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const script = createTempJsScript(`
      setTimeout(() => process.exit(7), 25);
    `);

    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd: tmpdir(),
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: script,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow('Claude Code process exited with code 7');
    } finally {
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
    }
  });

  it('completes the consumer when the subprocess exits 0', async () => {
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const script = createTempJsScript(`
      setTimeout(() => process.exit(0), 25);
    `);

    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd: tmpdir(),
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: script,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.done).toBe(true);
    } finally {
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
    }
  });

  it('rejects the consumer when the subprocess emits non-JSON output in stream-json mode (auth failure)', async () => {
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const script = createTempJsScript(`
      console.log('Not logged in · Please run /login');
      setTimeout(() => process.exit(0), 25);
    `);

    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd: tmpdir(),
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: script,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow(/not logged in/i);
    } finally {
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
    }
  });

  it('terminates descendants synchronously when the parent receives exit', { timeout: 20_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-exit-'));
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

        setInterval(() => {}, 1000);
      `,
      'utf8',
    );

    vi.doMock('ps-list', async () => ({
      default: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return [];
      },
    }));

    const originalProcessOn = process.on.bind(process);
    let exitHandler: (() => void) | undefined;
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((...args: Parameters<typeof process.on>) => {
      const [event, listener] = args;
      if (event === 'exit') {
        const exitListener = listener as NodeJS.ExitListener;
        exitHandler = () => exitListener(0);
      }
      return originalProcessOn(...args);
    }) as typeof process.on);

    try {
      const { query: reloadedQuery } = await import('./query');

      const q = reloadedQuery({
        prompt: 'hi',
        options: {
          cwd: tmpRoot,
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: sleeper,
        },
      });

      const marker = await new Promise<{ childPid: number }>((resolve, reject) => {
        const startedAt = Date.now();
        const poll = () => {
          try {
            resolve(JSON.parse(readFileSync(markerPath, 'utf8')) as { childPid: number });
          } catch (error) {
            if (Date.now() - startedAt > 5_000) {
              reject(error);
              return;
            }
            setTimeout(poll, 25);
          }
        };
        poll();
      });

      const iter = q[Symbol.asyncIterator]();
      const nextPromise = withTimeout(iter.next(), 5_000, 'query to terminate after exit');
      void nextPromise.catch(() => undefined);

      expect(exitHandler).toBeTypeOf('function');
      if (!exitHandler) {
        throw new Error('Expected process exit handler to be registered');
      }
      exitHandler();

      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const check = () => {
            try {
              process.kill(marker.childPid, 0);
              if (Date.now() - startedAt > 250) {
                reject(new Error(`Timed out waiting for descendant ${marker.childPid} to exit after process exit`));
                return;
              }
              setTimeout(check, 25);
            } catch {
              resolve();
            }
          };
          check();
        }),
        500,
        'descendant cleanup after exit',
      );

      await expect(nextPromise).rejects.toThrow(/Claude Code process/i);
    } finally {
      processOnSpy.mockRestore();
    }
  });
});
