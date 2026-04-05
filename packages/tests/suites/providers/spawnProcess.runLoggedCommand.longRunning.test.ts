import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spawn-logged-command-long-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('providers: runLoggedCommand long-running process', () => {
  it('does not fail stream drain while command is still running', async () => {
    await withTempDir(async (dir) => {
      const stdoutPath = join(dir, 'stdout.log');
      const stderrPath = join(dir, 'stderr.log');
      const script = [
        "process.stdout.write('started\\n');",
        "setTimeout(() => {",
        "  process.stdout.write('done\\n');",
        "}, 11_000);",
      ].join('\n');

      await expect(
        runLoggedCommand({
          command: process.execPath,
          args: ['-e', script],
          cwd: dir,
          stdoutPath,
          stderrPath,
          timeoutMs: 30_000,
        }),
      ).resolves.toBeUndefined();
    });
  }, 40_000);

  it('aborts promptly when an abort signal is triggered', async () => {
    await withTempDir(async (dir) => {
      const stdoutPath = join(dir, 'stdout.log');
      const stderrPath = join(dir, 'stderr.log');
      const abortController = new AbortController();
      const startedAt = Date.now();
      const script = [
        "process.stdout.write('Starting Metro Bundler\\n');",
        'setInterval(() => {}, 1_000);',
      ].join('\n');

      const runPromise = runLoggedCommand({
        command: process.execPath,
        args: ['-e', script],
        cwd: dir,
        stdoutPath,
        stderrPath,
        timeoutMs: 30_000,
        abortSignal: abortController.signal,
      });

      setTimeout(() => {
        abortController.abort(new Error('runLoggedCommand aborted for test'));
      }, 100);

      await expect(runPromise).rejects.toThrow(/aborted for test/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await readFile(stdoutPath, 'utf8')).toContain('Starting Metro Bundler');
    });
  }, 10_000);
});
