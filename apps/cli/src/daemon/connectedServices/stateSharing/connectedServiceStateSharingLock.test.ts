import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import {
  ConnectedServiceStateSharingLockError,
  withConnectedServiceStateSharingDestinationLock,
  withConnectedServiceStateSharingLocks,
} from './connectedServiceStateSharingLock';

async function waitFor(condition: () => boolean): Promise<void> {
  const deadlineMs = Date.now() + 2_000;
  while (Date.now() < deadlineMs) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
}

async function waitForPath(path: string): Promise<void> {
  const deadlineMs = Date.now() + 5_000;
  while (Date.now() < deadlineMs) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`contender exited ${child.exitCode}`);
    return;
  }
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`contender exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`)));
    child.once('error', reject);
  });
}

describe('connectedServiceStateSharingLock', () => {
  it('serializes in-process materializations for the same destination', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-${Date.now()}`);
    const destination = join(root, 'destination');
    await mkdir(destination, { recursive: true });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        const lockPath = `${destination}.happier-state-sharing.lock`;
        expect((await stat(lockPath)).isFile()).toBe(true);
        expect(await stat(join(destination, '.happier-state-sharing.lock')).then(() => true, () => false)).toBe(false);
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it('acquires overlapping root sets in one stable order', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-roots-${Date.now()}`);
    const firstRoot = join(root, 'a');
    const secondRoot = join(root, 'b');
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withConnectedServiceStateSharingLocks([secondRoot, firstRoot], async () => {
        events.push('first:start');
        await firstCanFinish;
        events.push('first:end');
      });
      const second = withConnectedServiceStateSharingLocks([firstRoot, secondRoot], async () => {
        events.push('second:start');
      });

      await waitFor(() => events.length === 1);
      expect(events).toEqual(['first:start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains lock ownership when the protected destination is atomically replaced', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-replacement-${Date.now()}`);
    const destination = join(root, 'destination');
    const staged = join(root, 'staged');
    await mkdir(destination, { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, 'materialized'), 'next');
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        await replaceDirectoryAtomically({
          stagedDir: staged,
          targetDir: destination,
        });
        await expect(readFile(join(destination, 'materialized'), 'utf8')).resolves.toBe('next');
        events.push('first:replaced');
        await firstCanFinish;
        events.push('first:released');
      });
      await waitFor(() => events.length === 1);

      const concurrent = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        events.push('concurrent:entered');
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(events).toEqual(['first:replaced']);
      releaseFirst();
      await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined]);
      expect(events).toEqual(['first:replaced', 'first:released', 'concurrent:entered']);

      await expect(withConnectedServiceStateSharingDestinationLock(
        destination,
        async () => 'reacquired',
        { acquireTimeoutMs: 250, retryDelayMs: 5 },
      )).resolves.toBe('reacquired');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not recreate the destination while a cross-process contender waits in the backup-to-promotion gap', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-cross-process-gap-${Date.now()}`);
    const destination = join(root, 'destination');
    const backup = join(root, 'backup');
    const staged = join(root, 'staged');
    const contenderStarted = join(root, 'contender-started');
    const contenderEntered = join(root, 'contender-entered');
    const lockPath = `${destination}.happier-state-sharing.lock`;
    const moduleUrl = new URL('./connectedServiceStateSharingLock.ts', import.meta.url).href;
    await mkdir(destination, { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, 'materialized'), 'next');
    const contenderRef: { current: ReturnType<typeof spawn> | null } = { current: null };

    try {
      await withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 5,
        staleAfterMs: 60_000,
        errorCode: 'test_owner_unavailable',
      }, async () => {
        await rename(destination, backup);
        const source = `
          import { writeFile } from 'node:fs/promises';
          import { withConnectedServiceStateSharingDestinationLock } from ${JSON.stringify(moduleUrl)};
          const destination = ${JSON.stringify(destination)};
          await writeFile(${JSON.stringify(contenderStarted)}, 'started');
          await withConnectedServiceStateSharingDestinationLock(destination, async () => {
            await writeFile(${JSON.stringify(contenderEntered)}, 'entered');
          }, { acquireTimeoutMs: 5_000, retryDelayMs: 5 });
        `;
        contenderRef.current = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
          cwd: process.cwd(),
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        await waitForPath(contenderStarted);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        expect(await stat(destination).then(() => true, () => false)).toBe(false);
        expect(await stat(contenderEntered).then(() => true, () => false)).toBe(false);
        await rename(staged, destination);
      });

      await waitForChild(contenderRef.current!);
      expect(await stat(contenderEntered).then(() => true, () => false)).toBe(true);
      await expect(readFile(join(destination, 'materialized'), 'utf8')).resolves.toBe('next');
    } finally {
      if (contenderRef.current?.exitCode === null) {
        await waitForChild(contenderRef.current).catch(() => {
          contenderRef.current?.kill('SIGKILL');
        });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases the stable lock when atomic promotion fails and rolls back the destination', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-rollback-${Date.now()}`);
    const destination = join(root, 'destination');
    const staged = join(root, 'staged');
    await mkdir(destination, { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(destination, 'materialized'), 'previous');
    await writeFile(join(staged, 'materialized'), 'next');

    try {
      await expect(withConnectedServiceStateSharingDestinationLock(destination, async () => {
        await replaceDirectoryAtomically({
          stagedDir: staged,
          targetDir: destination,
          afterPromote: () => {
            throw new Error('simulated promotion failure');
          },
        });
      })).rejects.toThrow('simulated promotion failure');
      await expect(readFile(join(destination, 'materialized'), 'utf8')).resolves.toBe('previous');

      await expect(withConnectedServiceStateSharingDestinationLock(
        destination,
        async () => 'reacquired',
        { acquireTimeoutMs: 250, retryDelayMs: 5 },
      )).resolves.toBe('reacquired');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails with a structured diagnostic when a cross-process lock cannot be acquired', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-held-${Date.now()}`);
    const destination = join(root, 'destination');
    await mkdir(destination, { recursive: true });
    await writeFile(`${destination}.happier-state-sharing.lock`, '{}');

    try {
      const startedAtMs = Date.now();
      await expect(withConnectedServiceStateSharingDestinationLock(
        destination,
        async () => undefined,
        { acquireTimeoutMs: 100, retryDelayMs: 5 },
      )).rejects.toMatchObject({
        code: 'state_sharing_lock_unavailable',
        providerId: null,
      } satisfies Partial<ConnectedServiceStateSharingLockError>);
      expect(Date.now() - startedAtMs).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers a stale cross-process lock left by a dead owner', async () => {
    const root = join(tmpdir(), `happier-state-sharing-lock-stale-${Date.now()}`);
    const destination = join(root, 'destination');
    const lockPath = `${destination}.happier-state-sharing.lock`;
    await mkdir(destination, { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: 999_999_999,
      ownerToken: 'dead-owner',
      processStartedAtMs: 1,
      createdAtMs: Date.now() - 60_000,
      updatedAtMs: Date.now() - 60_000,
    }));

    let entered = false;
    try {
      await withConnectedServiceStateSharingDestinationLock(
        destination,
        async () => {
          entered = true;
        },
        { acquireTimeoutMs: 1_000, retryDelayMs: 5, staleLockTimeoutMs: 1_000 },
      );

      expect(entered).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
