import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('claude sdk query', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-stderr-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('drains noisy stderr so stdout can keep flowing', { timeout: 10_000 }, async () => {
      const prevDebug = process.env.DEBUG;
      delete process.env.DEBUG;
      const noisyCli = join(tmpRoot, `noisy-cli-${Date.now()}.cjs`);
      writeFileSync(
        noisyCli,
        `
          const fs = require('node:fs');

          // Write enough stderr to fill a pipe buffer unless the parent drains it.
          const chunk = Buffer.alloc(64 * 1024, 97);
          for (let i = 0; i < 256; i++) fs.writeSync(2, chunk);

          process.stdout.write(JSON.stringify({ type: 'result' }) + '\\n');
        `,
        'utf8',
      );

      const abortController = new AbortController();

      const q = query({
        prompt: 'hello',
        options: {
          cwd: tmpRoot,
          executable: 'node',
          pathToClaudeCodeExecutable: noisyCli,
          abort: abortController.signal,
        },
      });

      try {
        const first = await withTimeout(q.next(), 4_000, 'first sdk message');
        expect(first.done).toBe(false);
        expect(first.value.type).toBe('result');
      } finally {
        abortController.abort();
        if (typeof prevDebug === 'string') process.env.DEBUG = prevDebug;
        else delete process.env.DEBUG;
      }
  });
});
