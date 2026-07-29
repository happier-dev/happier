import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../configuration', () => ({ configuration: { happyHomeDir: join(tmpdir(), 'unused-registry-home') } }));

import { resolvePluginStorePaths } from '../paths';
import { createPluginRegistryCommitCoordinator } from './commitCoordinator';
import { createEmptyPluginRegistryCommitRecord } from './commitRecord';
import { createPluginRegistryReconciler } from './reconcile';

describe('plugin registry durable reconciliation', () => {
  it('keeps a post-commit record authoritative, exposes retryable surface failure, and converges idempotently', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-reconcile-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 200, instanceId: 'daemon-a' } });
    await coordinator.commit({
      transactionId: 'bootstrap', baseRevision: null,
      buildNext: () => createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorPid: 200, creatorInstanceId: 'daemon-a' }),
    });
    const applied: string[] = [];
    let watcherFails = true;
    const reconciler = createPluginRegistryReconciler({
      paths,
      readState: async () => ({ revisionId: 'state-0' }),
      surfaces: [
        { name: 'activeRegistry', apply: async ({ commit }) => { applied.push(`active:${commit.revision}`); } },
        { name: 'watchers', apply: async ({ commit }) => { if (watcherFails) throw new Error('watcher unavailable'); applied.push(`watchers:${commit.revision}`); } },
      ],
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'retryable', revision: 0, surfaces: { activeRegistry: { status: 'applied' }, watchers: { status: 'failed' } },
    });
    watcherFails = false;
    await expect(reconciler.reconcile()).resolves.toMatchObject({ status: 'reconciled', revision: 0 });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ status: 'reconciled', revision: 0 });
    expect(applied).toEqual(['active:0', 'watchers:0']);
  });

  it('fences a surface when the durable record is substituted at the same revision', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-reconcile-identity-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 201, instanceId: 'daemon-a' } });
    await coordinator.commit({
      transactionId: 'bootstrap', baseRevision: null,
      buildNext: () => createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorPid: 201, creatorInstanceId: 'daemon-a' }),
    });
    const reconciler = createPluginRegistryReconciler({
      paths,
      readState: async () => ({ revisionId: 'state-0' }),
      surfaces: [{
        name: 'activeRegistry',
        apply: async ({ commit }) => {
          await writeFile(paths.registryCurrentFilePath, JSON.stringify({
            ...commit,
            transactionId: 'substituted-at-same-revision',
            creator: { ...commit.creator, instanceId: 'other-daemon' },
          }), 'utf8');
        },
      }],
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'retryable',
      revision: 0,
      surfaces: { activeRegistry: { status: 'stale' } },
    });
  });

  it('reconciles the same durable revision idempotently after a process restart', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-reconcile-restart-')));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 202, instanceId: 'daemon-a' } });
    await coordinator.commit({
      transactionId: 'bootstrap', baseRevision: null,
      buildNext: () => createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorPid: 202, creatorInstanceId: 'daemon-a' }),
    });
    const applied: string[] = [];
    const createRestartedReconciler = () => createPluginRegistryReconciler({
      paths,
      readState: async () => ({ revisionId: 'state-0' }),
      surfaces: [{ name: 'activeRegistry', apply: async ({ commit }) => { applied.push(`active:${commit.revision}`); } }],
    });

    await expect(createRestartedReconciler().reconcile()).resolves.toMatchObject({ status: 'reconciled', revision: 0 });
    await expect(createRestartedReconciler().reconcile()).resolves.toMatchObject({ status: 'reconciled', revision: 0 });
    expect(applied).toEqual(['active:0', 'active:0']);
  });
});
