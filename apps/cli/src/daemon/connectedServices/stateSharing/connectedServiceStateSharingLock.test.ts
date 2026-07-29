import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceStateSharingLockError,
  withConnectedServiceStateSharingDestinationLock,
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

async function waitForFileContents(path: string, expected: string): Promise<void> {
  const deadlineMs = Date.now() + 5_000;
  while (Date.now() < deadlineMs) {
    if (await readFile(path, 'utf8').then((value) => value === expected, () => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}`);
}

async function writeExactDevPredecessorHarness(dir: string): Promise<string> {
  const predecessor = execFileSync('git', [
    'show',
    '877ee97a0df346a1daaa541632dc42643d533120:apps/cli/src/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock.ts',
  ], { encoding: 'utf8' });
  const harnessPath = join(dir, 'dev-predecessor-state-sharing-lock.ts');
  await writeFile(harnessPath, `${predecessor}\n
const destination = process.env.HAPPIER_TEST_DESTINATION!;
const enteredPath = process.env.HAPPIER_TEST_ENTERED!;
const releasePath = process.env.HAPPIER_TEST_RELEASE!;
const outcomePath = process.env.HAPPIER_TEST_OUTCOME!;
const offsetMs = Number(process.env.HAPPIER_TEST_NOW_OFFSET_MS ?? '0');
const actualNow = Date.now;
Date.now = () => actualNow() + offsetMs;
try {
  await withConnectedServiceStateSharingDestinationLock(destination, async () => {
    await writeFile(enteredPath, 'entered', 'utf8');
    while (!(await stat(releasePath).then(() => true, () => false))) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }, { acquireTimeoutMs: 750, retryDelayMs: 10, staleLockTimeoutMs: 5 * 60_000 });
  await writeFile(outcomePath, 'acquired', 'utf8');
} catch (error) {
  await writeFile(outcomePath, error instanceof ConnectedServiceStateSharingLockError ? 'blocked' : String(error), 'utf8');
}
`, 'utf8');
  return harnessPath;
}

function spawnPredecessor(harnessPath: string, env: Readonly<Record<string, string>>): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['--experimental-strip-types', harnessPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`predecessor exited ${child.exitCode}`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`predecessor exited ${code}`)));
    child.once('error', reject);
  });
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
        const lockPath = join(destination, '.happier-state-sharing.lock');
        expect((await stat(lockPath)).isDirectory()).toBe(true);
        expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toEqual({
          pid: process.pid,
          providerId: null,
          acquiredAt: expect.any(String),
        });
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
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, '.happier-state-sharing.lock'), '{}');

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
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('recovers a stale cross-process lock left by a dead owner', async () => {
    const destination = join(tmpdir(), `happier-state-sharing-lock-stale-${Date.now()}`);
    const lockPath = join(destination, '.happier-state-sharing.lock');
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
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('coexists with the exact Dev predecessor reader in both reachable directions', async () => {
    const destination = join(tmpdir(), `happier-state-sharing-lock-predecessor-${Date.now()}`);
    const harnessDir = join(destination, 'harness');
    const oldEnteredPath = join(destination, 'old-entered');
    const oldReleasePath = join(destination, 'old-release');
    const oldOutcomePath = join(destination, 'old-outcome');
    await mkdir(harnessDir, { recursive: true });
    const harnessPath = await writeExactDevPredecessorHarness(harnessDir);

    try {
      let releaseNew!: () => void;
      const newRelease = new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
      const newWriter = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        const oldReader = spawnPredecessor(harnessPath, {
          HAPPIER_TEST_DESTINATION: destination,
          HAPPIER_TEST_ENTERED: oldEnteredPath,
          HAPPIER_TEST_RELEASE: oldReleasePath,
          HAPPIER_TEST_OUTCOME: oldOutcomePath,
          HAPPIER_TEST_NOW_OFFSET_MS: String(6 * 60_000),
        });
        await waitForFileContents(oldOutcomePath, 'blocked');
        await expect(readFile(oldOutcomePath, 'utf8')).resolves.toBe('blocked');
        expect(await stat(oldEnteredPath).then(() => true, () => false)).toBe(false);
        await waitForChild(oldReader);
        await newRelease;
      }, { acquireTimeoutMs: 2_000, retryDelayMs: 10 });

      releaseNew();
      await newWriter;
      await rm(oldOutcomePath, { force: true });

      const oldWriter = spawnPredecessor(harnessPath, {
        HAPPIER_TEST_DESTINATION: destination,
        HAPPIER_TEST_ENTERED: oldEnteredPath,
        HAPPIER_TEST_RELEASE: oldReleasePath,
        HAPPIER_TEST_OUTCOME: oldOutcomePath,
      });
      await waitForPath(oldEnteredPath);
      let newEntered = false;
      const newReader = withConnectedServiceStateSharingDestinationLock(destination, async () => {
        newEntered = true;
      }, { acquireTimeoutMs: 5_000, retryDelayMs: 10 });
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(newEntered).toBe(false);
      await writeFile(oldReleasePath, 'release', 'utf8');
      await waitForChild(oldWriter);
      await expect(newReader).resolves.toBeUndefined();
      expect(newEntered).toBe(true);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
