import { mkdtemp, rm } from 'node:fs/promises';
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
});
