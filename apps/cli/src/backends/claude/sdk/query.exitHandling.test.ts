import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { query } from './query';

function createTempJsScript(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-claude-sdk-query-'));
  const file = join(dir, 'fake-claude.js');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('claude sdk query exit handling', () => {
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
});
