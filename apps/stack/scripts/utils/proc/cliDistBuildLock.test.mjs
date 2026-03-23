import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withCliDistBuildLock } from './cliDistBuildLock.mjs';

test('withCliDistBuildLock reclaims a fresh lock from a dead owner pid immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-'));
  const lockPath = join(root, 'cli-dist-build.lock');

  try {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = await withCliDistBuildLock(
      async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
