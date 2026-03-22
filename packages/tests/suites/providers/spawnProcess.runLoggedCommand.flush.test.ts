import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '../../src/testkit/fs/tempDir';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

describe('providers: runLoggedCommand log flush', () => {
  it('waits for stdout/stderr streams to flush before resolving', async () => {
    await withTempDir({ prefix: 'spawn-logged-command-' }, async ({ path: dir }) => {
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
