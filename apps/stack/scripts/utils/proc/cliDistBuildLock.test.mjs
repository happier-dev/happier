import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

test('withCliDistBuildLock reports wait progress while a live owner holds the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-wait-'));
  const lockPath = join(root, 'cli-dist-build.lock');
  const waitEvents = [];

  try {
    const holder = withCliDistBuildLock(
      async () => {
        await delay(40);
        return 'held';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    while (true) {
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        break;
      } catch {
        await delay(1);
      }
    }

    const result = await withCliDistBuildLock(
      async ({ waited }) => {
        assert.equal(waited, true);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
        onWait: (event) => {
          waitEvents.push(event);
        },
      },
    );

    assert.equal(result, 'ok');
    assert.ok(waitEvents.length >= 1);
    assert.equal(waitEvents[0].lockPath, lockPath);
    assert.equal(waitEvents[0].owner.pid, process.pid);

    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
