import { link, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquirePersonalHomeOperationLock, isPersonalHomeOperationLockHeld, PersonalHomeOperationError, withPersonalHomeOperationLock } from './lock.js';

// Only the filesystem boundary is replaced; exclusive creation and all lock logic stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

describe('Personal Home operation lock', () => {
  it.each(['initial', 'takeover claim', 'stale replacement'] as const)('recovers after failed %s publication', async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-write-failure-'));
    const directory = join(root, '.operations');
    const path = join(directory, 'lock');
    const failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await mkdir(directory);
    const stale = JSON.stringify({ token: 'stale-token', pid: 2_147_483_647, host: hostname(), startedAt: new Date(0).toISOString(), operation: 'backup' });
    if (phase !== 'initial') await writeFile(path, stale);
    let injected = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await fs.open(...args);
      const target = String(args[0]);
      if (!injected && (phase === 'takeover claim' ? target.endsWith('.tmp') : target === path)) {
        injected = true;
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
      }
      return handle;
    });
    try {
      await expect(acquirePersonalHomeOperationLock(root, 'restore')).rejects.toBe(failure);
      expect(injected).toBe(true);
      vi.mocked(open).mockImplementation(fs.open);
      // A failed claim must preserve the pre-existing stale file; failed owned writes leave nothing.
      expect(await readdir(directory)).toEqual(phase === 'takeover claim' ? ['lock'] : []);
      if (phase === 'takeover claim') expect(await readFile(path, 'utf8')).toBe(stale);
      const release = await acquirePersonalHomeOperationLock(root, 'restore');
      await release();
    } finally {
      vi.mocked(open).mockImplementation(fs.open);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['', JSON.stringify({ token: 'unknown', pid: 1, host: 'another-host', startedAt: 'unknown', operation: 'backup' })])('preserves an unknown existing lock', async (contents) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-unknown-'));
    const path = join(root, '.operations', 'lock');
    try {
      await mkdir(join(root, '.operations'));
      await writeFile(path, contents);
      await expect(acquirePersonalHomeOperationLock(root, 'restore')).rejects.toMatchObject({ code: 'ambiguous_stale_lock' });
      expect(await readFile(path, 'utf8')).toBe(contents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('serializes operations and writes owner metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-'));
    const release = await acquirePersonalHomeOperationLock(root, 'backup');
    await expect(acquirePersonalHomeOperationLock(root, 'restore')).rejects.toBeInstanceOf(PersonalHomeOperationError);
    const record = JSON.parse(await readFile(join(root, '.operations', 'lock'), 'utf8')) as { operation:string };
    expect(record.operation).toBe('backup');
    await release();
  });

  it('records the operation role and reports ownership only inside the exact lease context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-role-'));
    expect(await isPersonalHomeOperationLockHeld(root, 'relocate')).toBe(false);
    const release = await acquirePersonalHomeOperationLock(root, 'relocate', { role: 'source' });
    try {
      expect(await isPersonalHomeOperationLockHeld(root, 'relocate')).toBe(false);
      const record = JSON.parse(await readFile(join(root, '.operations', 'lock'), 'utf8')) as { operation: string; role?: string };
      expect(record.operation).toBe('relocate');
      expect(record.role).toBe('source');
    } finally {
      await release();
    }
    expect(await isPersonalHomeOperationLockHeld(root, 'relocate')).toBe(false);

    await withPersonalHomeOperationLock(root, 'relocate', async () => {
      expect(await isPersonalHomeOperationLockHeld(root, 'relocate')).toBe(true);
      expect(await isPersonalHomeOperationLockHeld(root, 'erase')).toBe(false);
    });
  });

  it('rejects lifecycle from an independent root async flow while the same process already holds the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-flow-'));
    let signalHolderEntered: () => void = () => undefined;
    const holderEntered = new Promise<void>((resolveReady) => { signalHolderEntered = resolveReady; });
    let signalIndependentSettled: () => void = () => undefined;
    const independentSettled = new Promise<void>((resolveSettled) => { signalIndependentSettled = resolveSettled; });

    // Separate root async flow in the same live process (for example an unrelated settings
    // restart task). It is created before the holder enters, so it never inherits the
    // holder's async context and must contend on the exclusive lock file like any other flow.
    const independentFlow = (async () => {
      await holderEntered;
      let nestedRan = false;
      const outcome = await withPersonalHomeOperationLock(root, 'lifecycle', async () => { nestedRan = true; }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(outcome).toBeInstanceOf(PersonalHomeOperationError);
        expect((outcome as PersonalHomeOperationError).code).toBe('operation_in_progress');
        expect(nestedRan).toBe(false);
      } finally {
        signalIndependentSettled();
      }
    })();

    await withPersonalHomeOperationLock(root, 'backup', async () => {
      signalHolderEntered();
      await independentSettled;
    });
    await independentFlow;
  });

  it('permits lifecycle nesting inside the holding async context and keeps nested mutations exclusive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-nested-'));
    await withPersonalHomeOperationLock(root, 'backup', async () => {
      await expect(withPersonalHomeOperationLock(root, 'lifecycle', async () => 'restarted')).resolves.toBe('restarted');
      await expect(withPersonalHomeOperationLock(root, 'restore', async () => undefined)).rejects.toMatchObject({ code: 'operation_in_progress' });
      await expect(withPersonalHomeOperationLock(root, 'backup', async () => undefined)).rejects.toMatchObject({ code: 'operation_in_progress' });
    });
  });

  it('expires inherited lifecycle ownership when the holding callback completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-expired-context-'));
    let signalDetached: () => void = () => undefined;
    const runDetached = new Promise<void>((resolveRun) => { signalDetached = resolveRun; });
    let detachedFlow: Promise<unknown> | undefined;

    await withPersonalHomeOperationLock(root, 'restore', async () => {
      detachedFlow = (async () => {
        await runDetached;
        return withPersonalHomeOperationLock(root, 'lifecycle', async () => 'stale-context-ran');
      })();
    });

    const release = await acquirePersonalHomeOperationLock(root, 'backup');
    try {
      signalDetached();
      await expect(detachedFlow).rejects.toMatchObject({ code: 'operation_in_progress' });
    } finally {
      await release();
    }
  });

  it('rejects a detached same-operation context after another same-process lease replaces it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-replaced-context-'));
    let resumeDetached: () => void = () => undefined;
    const resume = new Promise<void>((resolveResume) => { resumeDetached = resolveResume; });
    let detachedAttestation: Promise<boolean> | undefined;

    await withPersonalHomeOperationLock(root, 'erase', async () => {
      detachedAttestation = (async () => {
        await resume;
        return isPersonalHomeOperationLockHeld(root, 'erase');
      })();
    });

    const releaseSuccessor = await acquirePersonalHomeOperationLock(root, 'erase');
    try {
      resumeDetached();
      await expect(detachedAttestation).resolves.toBe(false);
    } finally {
      await releaseSuccessor();
    }
  });

  it('attests the exact file-record token owned by the current context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-token-context-'));
    const path = join(root, '.operations', 'lock');
    await withPersonalHomeOperationLock(root, 'erase', async () => {
      const original = JSON.parse(await readFile(path, 'utf8')) as { token: string };
      await writeFile(path, `${JSON.stringify({ ...original, token: 'replacement-token' })}\n`);
      expect(await isPersonalHomeOperationLockHeld(root, 'erase')).toBe(false);
      await writeFile(path, `${JSON.stringify(original)}\n`);
      expect(await isPersonalHomeOperationLockHeld(root, 'erase')).toBe(true);
    });
  });

  it('fails opposite-direction relocation admission fast when each source Home is already owned', async () => {
    const homeA = await mkdtemp(join(tmpdir(), 'happier-home-lock-opposite-a-'));
    const homeB = await mkdtemp(join(tmpdir(), 'happier-home-lock-opposite-b-'));
    const releaseA = await acquirePersonalHomeOperationLock(homeA, 'relocate', { role: 'source' });
    const releaseB = await acquirePersonalHomeOperationLock(homeB, 'relocate', { role: 'source' });
    let admittedWrites = 0;
    try {
      const attempts = await Promise.allSettled([
        withPersonalHomeOperationLock(homeB, 'relocate', async () => { admittedWrites += 1; return 'a-to-b'; }),
        withPersonalHomeOperationLock(homeA, 'relocate', async () => { admittedWrites += 1; return 'b-to-a'; }),
      ]);
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(attempt.status).toBe('rejected');
        if (attempt.status === 'rejected') {
          expect(attempt.reason).toMatchObject({ code: 'operation_in_progress' });
        }
      }
      expect(admittedWrites).toBe(0);
    } finally {
      await releaseB();
      await releaseA();
    }

    await expect(withPersonalHomeOperationLock(homeA, 'relocate', async () => 'retry-a')).resolves.toBe('retry-a');
    await expect(withPersonalHomeOperationLock(homeB, 'relocate', async () => 'retry-b')).resolves.toBe('retry-b');
  });

  it('allows only one contender to replace a proven stale inode and preserves the live successor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-race-'));
    const path = join(root, '.operations', 'lock');
    await mkdir(join(root, '.operations'), { recursive: true });
    await writeFile(path, JSON.stringify({ token: 'stale-token', pid: 2_147_483_647, host: hostname(), startedAt: new Date(0).toISOString(), operation: 'backup' }));
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquirePersonalHomeOperationLock(root, 'restore')));
    const winners = attempts.filter((attempt): attempt is PromiseFulfilledResult<() => Promise<void>> => attempt.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const live = JSON.parse(await readFile(path, 'utf8')) as { token: string; operation: string };
    expect(live.token).not.toBe('stale-token');
    expect(live.operation).toBe('restore');
    await winners[0].value();
  });

  it('recovers an orphaned stale-takeover claim after its claimant process exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-lock-orphaned-takeover-'));
    const path = join(root, '.operations', 'lock');
    const takeoverPath = `${path}.takeover`;
    const pinnedTakeoverPath = `${takeoverPath}.inode`;
    await mkdir(join(root, '.operations'), { recursive: true });
    const staleRecord = { token: 'stale-token', pid: 2_147_483_647, host: hostname(), startedAt: new Date(0).toISOString(), operation: 'backup' };
    await writeFile(path, JSON.stringify(staleRecord));
    await link(path, pinnedTakeoverPath);
    await writeFile(takeoverPath, JSON.stringify({ ...staleRecord, token: 'orphaned-claim-token', operation: 'restore' }));

    const release = await acquirePersonalHomeOperationLock(root, 'restore');
    const live = JSON.parse(await readFile(path, 'utf8')) as { token: string; operation: string };
    expect(live.token).not.toBe(staleRecord.token);
    expect(live.operation).toBe('restore');
    await expect(readFile(takeoverPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(pinnedTakeoverPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await release();
  });
});
