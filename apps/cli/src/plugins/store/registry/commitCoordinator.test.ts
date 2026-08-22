import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const canonicalUnlinkBarrier = vi.hoisted(() => {
  let targetPath: string | null = null;
  let paused = false;
  let enteredResolve: (() => void) | null = null;
  let releaseResolve: (() => void) | null = null;
  let entered = Promise.resolve();
  let release = Promise.resolve();
  return {
    arm(path: string) {
      targetPath = path;
      paused = false;
      entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    },
    async pauseIfTarget(path: string): Promise<void> {
      if (targetPath !== path || paused) return;
      paused = true;
      enteredResolve?.();
      await release;
    },
    waitUntilEntered: async () => await entered,
    release: () => releaseResolve?.(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await canonicalUnlinkBarrier.pauseIfTarget(String(args[0]));
      return await actual.unlink(...args);
    },
  };
});

vi.mock('../../../configuration', () => ({ configuration: { happyHomeDir: join(tmpdir(), 'unused-registry-home') } }));

import { resolvePluginStorePaths } from '../paths';
import { createPluginRegistryCommitCoordinator, withPluginRegistryCommitFence } from './commitCoordinator';
import {
  createEmptyPluginRegistryCommitRecord,
  readPluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
} from './commitRecord';
import {
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  type PluginInstallationStateRevision,
} from './generationStore';

const nextStateRevision: PluginInstallationStateRevision = {
  t: 'happier_plugin_installations_v1',
  schemaVersion: 1,
  revisionId: 'state-1',
  createdAtMs: 1,
  plugins: {},
  rollbackRetention: [],
};
const nextStateReference = {
  revisionId: nextStateRevision.revisionId,
};

function createNext(current: PluginRegistryCommitRecord, transactionId: string): PluginRegistryCommitRecord {
  return {
    ...current,
    revision: current.revision + 1,
    baseRevision: current.revision,
    transactionId,
    installationState: nextStateReference,
    createdAtMs: current.createdAtMs + 1,
  };
}


async function bootstrap(happyHomeDir: string): Promise<ReturnType<typeof resolvePluginStorePaths>> {
  const paths = resolvePluginStorePaths({ happyHomeDir });
  const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 100, instanceId: 'daemon-bootstrap' } });
  const result = await coordinator.commit({
    transactionId: 'bootstrap', baseRevision: null,
    expectedCurrent: null,
    buildNext: () => createEmptyPluginRegistryCommitRecord({
      transactionId: 'bootstrap', createdAtMs: 1, creatorInstanceId: 'daemon-bootstrap', creatorPid: 100,
    }),
  });
  expect(result.status).toBe('committed');
  await persistInstallationStateRevision({ paths, state: nextStateRevision });
  return paths;
}

describe('PluginRegistryCommitCoordinator', () => {
  it('never deletes a successor fence when two contenders recover the same dead owner', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-reclaim-race-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCommitLockFilePath, JSON.stringify({
      t: 'happier_plugin_registry_commit_lock_v1',
      token: '00000000-0000-4000-8000-000000000001',
      pid: 2_147_483_000,
      instanceId: 'dead-daemon',
      createdAtMs: 1,
    }), 'utf8');
    canonicalUnlinkBarrier.arm(paths.registryCommitLockFilePath);

    let active = 0;
    let maximumActive = 0;
    let firstEnteredResolve!: () => void;
    let secondEnteredResolve!: () => void;
    let releaseOperationsResolve!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstEnteredResolve = resolve; });
    const secondEntered = new Promise<void>((resolve) => { secondEnteredResolve = resolve; });
    const releaseOperations = new Promise<void>((resolve) => { releaseOperationsResolve = resolve; });
    const operation = (enteredResolve: () => void) => async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      enteredResolve();
      await releaseOperations;
      active -= 1;
    };

    const first = withPluginRegistryCommitFence({
      paths,
      owner: { pid: process.pid, instanceId: 'contender-a' },
      acquireTimeoutMs: 2_000,
      operation: operation(firstEnteredResolve),
    });
    const firstEvent = await Promise.race([
      canonicalUnlinkBarrier.waitUntilEntered().then(() => 'unsafe-unlink' as const),
      firstEntered.then(() => 'owned' as const),
    ]);

    const second = withPluginRegistryCommitFence({
      paths,
      owner: { pid: process.pid, instanceId: 'contender-b' },
      acquireTimeoutMs: 2_000,
      operation: operation(secondEnteredResolve),
    });
    if (firstEvent === 'unsafe-unlink') {
      await secondEntered;
      canonicalUnlinkBarrier.release();
      await firstEntered;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(maximumActive).toBe(1);
      releaseOperationsResolve();
      await secondEntered;
    }
    releaseOperationsResolve();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
  });

  it('treats transaction ids as persisted commit identity rather than in-flight execution dedupe', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-coordinate-')));
    const paths = await bootstrap(happyHomeDir);
    const coordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 101, instanceId: 'daemon-a' },
      isProcessAlive: (pid) => pid === 101,
    });
    const expectedCurrent = await readPluginRegistryCommitRecord(paths);

    const firstPromise = coordinator.commit({ transactionId: 'tx-a', baseRevision: 0, expectedCurrent, buildNext: (current) => createNext(current!, 'tx-a') });
    const samePromise = coordinator.commit({ transactionId: 'tx-a', baseRevision: 0, expectedCurrent, buildNext: (current) => createNext(current!, 'tx-a') });

    expect(samePromise).not.toBe(firstPromise);
    const [firstResult, sameIdResult] = await Promise.all([firstPromise, samePromise]);
    expect([firstResult.status, sameIdResult.status].sort()).toEqual(['committed', 'conflict']);
    const committed = firstResult.status === 'committed' ? firstResult : sameIdResult;
    const conflict = firstResult.status === 'conflict' ? firstResult : sameIdResult;
    expect(committed).toMatchObject({ status: 'committed', record: { revision: 1 } });
    expect(conflict).toEqual({ status: 'conflict', expectedRevision: 0, actualRevision: 1 });
    const completedRetryBuilder = vi.fn(() => { throw new Error('stale builders must not run'); });
    await expect(coordinator.commit({ transactionId: 'tx-a', baseRevision: 0, expectedCurrent: await readPluginRegistryCommitRecord(paths), buildNext: completedRetryBuilder })).resolves
      .toEqual({ status: 'conflict', expectedRevision: 0, actualRevision: 1 });
    expect(completedRetryBuilder).not.toHaveBeenCalled();
  });


  it('recovers a lock immediately when its process owner is proven dead and fences the displaced owner', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-stale-lock-')));
    const paths = await bootstrap(happyHomeDir);
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCommitLockFilePath, JSON.stringify({
      t: 'happier_plugin_registry_commit_lock_v1', token: '00000000-0000-4000-8000-000000000001', pid: 999, instanceId: 'dead-daemon', createdAtMs: 1,
    }), 'utf8');
    let nowMs = 100;
    const coordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 102, instanceId: 'daemon-b' },
      acquireTimeoutMs: 100,
      nowMs: () => nowMs++,
      isProcessAlive: () => false,
      sleep: async () => undefined,
    });
    const expectedCurrent = await readPluginRegistryCommitRecord(paths);

    await expect(coordinator.commit({ transactionId: 'tx-stale', baseRevision: 0, expectedCurrent, buildNext: (current) => createNext(current!, 'tx-stale') }))
      .resolves.toMatchObject({ status: 'committed', record: { revision: 1 } });
    await expect(readFile(paths.registryCommitLockFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts before the linearization point and rejects a lost fencing token without changing current', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-fence-')));
    const paths = await bootstrap(happyHomeDir);
    const abort = new AbortController();
    abort.abort();
    const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 103, instanceId: 'daemon-c' } });
    const expectedCurrent = await readPluginRegistryCommitRecord(paths);
    await expect(coordinator.commit({ transactionId: 'tx-abort', baseRevision: 0, expectedCurrent, signal: abort.signal, buildNext: (current) => createNext(current!, 'tx-abort') }))
      .resolves.toEqual({ status: 'aborted', reason: 'signal' });

    const fenced = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 104, instanceId: 'daemon-d' },
      beforeReplace: async () => {
        const lock = JSON.parse(await readFile(paths.registryCommitLockFilePath, 'utf8')) as { token: string };
        await writeFile(paths.registryCommitLockFilePath, JSON.stringify({ ...lock, token: 'replacement-token' }), 'utf8');
      },
    });
    await expect(fenced.commit({ transactionId: 'tx-fenced', baseRevision: 0, expectedCurrent, buildNext: (current) => createNext(current!, 'tx-fenced') }))
      .rejects.toThrow(/fenc/i);
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 0, transactionId: 'bootstrap' });
  });

  it('classifies a durability-report failure after atomic replacement as visible but durability-pending, never pre-commit', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-post-replace-')));
    const paths = await bootstrap(happyHomeDir);
    const flushCommit = vi.fn(async () => { throw new Error('injected directory fsync failure'); });
    const coordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 105, instanceId: 'daemon-e' },
      flushCommit,
    });

    await expect(coordinator.commit({ transactionId: 'tx-post-replace', baseRevision: 0, expectedCurrent: await readPluginRegistryCommitRecord(paths), buildNext: (current) => createNext(current!, 'tx-post-replace') }))
      .resolves.toMatchObject({
        status: 'committed_durability_pending',
        record: { revision: 1, transactionId: 'tx-post-replace' },
        message: 'injected directory fsync failure',
      });
    expect(flushCommit).toHaveBeenCalledOnce();
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 1, transactionId: 'tx-post-replace' });
  });

  it('compares a post-replacement durability failure against the canonical record rather than object insertion order', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-canonical-')));
    const paths = await bootstrap(happyHomeDir);
    const coordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 106, instanceId: 'daemon-f' },
      flushCommit: async () => { throw new Error('injected directory fsync failure'); },
    });

    await expect(coordinator.commit({
      transactionId: 'tx-canonical',
      baseRevision: 0,
      expectedCurrent: await readPluginRegistryCommitRecord(paths),
      buildNext: (current) => {
        const next = createNext(current!, 'tx-canonical');
        return {
          creator: next.creator,
          createdAtMs: next.createdAtMs,
          pluginGenerations: next.pluginGenerations,
          installationState: next.installationState,
          baseRevision: next.baseRevision,
          transactionId: next.transactionId,
          revision: next.revision,
          schemaVersion: next.schemaVersion,
          t: next.t,
        };
      },
    })).resolves.toMatchObject({
      status: 'committed_durability_pending',
      record: { revision: 1, transactionId: 'tx-canonical' },
    });
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 1, transactionId: 'tx-canonical' });
  });

  it('rejects a commit record whose transaction identity differs from the operation identity', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-transaction-id-')));
    const paths = await bootstrap(happyHomeDir);
    const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 107, instanceId: 'daemon-g' } });

    await expect(coordinator.commit({
      transactionId: 'tx-operation',
      baseRevision: 0,
      expectedCurrent: await readPluginRegistryCommitRecord(paths),
      buildNext: (current) => createNext(current!, 'tx-record'),
    })).rejects.toThrow(/transaction id/i);
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 0, transactionId: 'bootstrap' });
  });

  it('rejects publication when a referenced immutable generation disappeared before the commit fence', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-missing-generation-')));
    const paths = await bootstrap(happyHomeDir);
    const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 108, instanceId: 'daemon-h' } });

    await expect(coordinator.commit({
      transactionId: 'tx-missing-generation',
      baseRevision: 0,
      expectedCurrent: await readPluginRegistryCommitRecord(paths),
      buildNext: (current) => ({
        ...createNext(current!, 'tx-missing-generation'),
        pluginGenerations: {
          'acme.plugin': {
            immutableGenerationId: 'generation-retired',
          },
        },
      }),
    })).rejects.toThrow(/generation/i);
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 0 });
  });

  it('re-validates referenced immutable generation structure immediately before publication', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-prepublication-bytes-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-registry-prepublication-source-'));
    const paths = await bootstrap(happyHomeDir);
    const bytes = 'export default 1';
    await writeFile(join(sourceRootPath, 'daemon.mjs'), bytes, 'utf8');
    const prepared = await prepareImmutablePluginGeneration({
      paths,
      sourceRootPath,
      record: {
        t: 'happier_plugin_generation_v1',
        schemaVersion: 1,
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-current',
        createdAtMs: 1,
        files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(bytes) }],
        manifestRelativePath: 'daemon.mjs',
      },
    });
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'state-current',
      createdAtMs: 1,
      plugins: {
        'acme.plugin': {
          enabled: true,
          trust: {
            pluginId: 'acme.plugin',
            distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
            state: 'trusted',
            approvedAtMs: 1,
          },
          source: {
            distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
          },
          updatePolicy: 'manual',
          optionalAccess: [],
        },
      },
      rollbackRetention: [],
    };
    const installationState = await persistInstallationStateRevision({ paths, state });
    const coordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 109, instanceId: 'daemon-i' },
      beforeReplace: async () => {
        await rm(join(paths.generationsDir, 'generation-current', 'daemon.mjs'));
      },
    });

    await expect(coordinator.commit({
      transactionId: 'tx-prepublication-bytes',
      baseRevision: 0,
      expectedCurrent: await readPluginRegistryCommitRecord(paths),
      buildNext: (current) => ({
        ...createNext(current!, 'tx-prepublication-bytes'),
        installationState,
        pluginGenerations: { 'acme.plugin': prepared.reference },
      }),
    })).rejects.toThrow(/manifest|required|missing/i);
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 0, transactionId: 'bootstrap' });
  });
});
