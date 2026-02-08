import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spawn-logged-command-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('providers: runLoggedCommand log flush', () => {
  it('waits for stdout/stderr streams to flush before resolving', async () => {
    await withTempDir(async (dir) => {
      const stdoutPath = join(dir, 'stdout.log');
      const stderrPath = join(dir, 'stderr.log');
      const marker = 'END_FLUSH_MARKER_12345';
      const script = [
        "process.stdout.write('A'.repeat(2_000_000));",
        "process.stderr.write('B'.repeat(100_000));",
        `process.stdout.write('\\n${marker}\\n');`,
      ].join('');

      await runLoggedCommand({
        command: process.execPath,
        args: ['-e', script],
        cwd: dir,
        stdoutPath,
        stderrPath,
        timeoutMs: 30_000,
      });

      const stdout = await readFile(stdoutPath, 'utf8');
      const stderr = await readFile(stderrPath, 'utf8');
      expect(stdout.includes(marker)).toBe(true);
      expect(stderr.length).toBeGreaterThan(50_000);
    });
  });
});
