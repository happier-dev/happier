import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceStateSharingLockError,
  withConnectedServiceStateSharingDestinationLock,
} from './connectedServiceStateSharingLock';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for test condition');
}

describe('connectedServiceStateSharingLock', () => {
  it('serializes in-process materializations for the same destination', async () => {
    const destination = join(tmpdir(), `happier-state-sharing-lock-${Date.now()}`);
    await mkdir(destination, { recursive: true });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        events.push('first:start');
        await firstCanFinish;
        events.push('first:end');
      });
      const second = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        events.push('second:start');
      });

      await waitFor(() => events.length === 1);
      expect(events).toEqual(['first:start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('fails with a structured diagnostic when a cross-process lock cannot be acquired', async () => {
    const destination = join(tmpdir(), `happier-state-sharing-lock-held-${Date.now()}`);
    await mkdir(join(destination, '.happier-state-sharing.lock'), { recursive: true });
    await writeFile(join(destination, '.happier-state-sharing.lock', 'owner.json'), '{}');

    try {
      await expect(withConnectedServiceStateSharingDestinationLock(
        destination,
        async () => undefined,
        { acquireTimeoutMs: 5, retryDelayMs: 1 },
      )).rejects.toMatchObject({
        code: 'state_sharing_lock_unavailable',
        providerId: null,
      } satisfies Partial<ConnectedServiceStateSharingLockError>);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('recovers a stale cross-process lock left by a dead owner', async () => {
    const destination = join(tmpdir(), `happier-state-sharing-lock-stale-${Date.now()}`);
    const lockDir = join(destination, '.happier-state-sharing.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 999_999_999,
      providerId: 'codex',
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    let entered = false;
    try {
      await withConnectedServiceStateSharingDestinationLock(
        destination,
        async () => {
          entered = true;
        },
        { acquireTimeoutMs: 50, retryDelayMs: 1, staleLockTimeoutMs: 1_000 },
      );

      expect(entered).toBe(true);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
