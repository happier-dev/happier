import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readPluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { readInstallationStateRevision } from '@/plugins/store/registry/generationStore';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createDaemonPluginChangeService } from './changeService';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { readCurrentDaemonPluginCatalog } from './currentCatalog';

describe('bundled Machine desired enablement', () => {
  it('refreshes Account admission against the current Machine revision without rewriting installation state', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-refresh-'));
    const reloadController = createPluginReloadController();
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    try {
      await store.setEnabledWithResult('happier.app-context', false);
      const before = await readPluginRegistryCommitRecord(store.paths);
      const generationBefore = reloadController.getState().generation;
      await store.refreshRuntime(['happier.app-context']);
      expect(await readPluginRegistryCommitRecord(store.paths)).toEqual(before);
      expect((await store.readSnapshot()).bundledPluginEnabledById['happier.app-context']).toBe(false);
      expect(reloadController.getState().generation).toBeGreaterThan(generationBefore);
      expect(reloadController.getState().lastResult?.runningSessionDisposition).toBe('retainRunningSessions');
    } finally {
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('persists disable and re-enable through the daemon without installation, custody deletion or hard revocation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-enablement-'));
    const otherHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-other-machine-'));
    const pluginId = 'happier.app-context';
    const reloadController = createPluginReloadController();
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const changes = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle,
        // The Home transport reports no managed resources for this app-only plugin.
        readManagedResources: async () => ({ resources: [], reviewed: true }),
      }),
    });
    try {
      await store.initialize();
      const storagePath = join(store.paths.storageDir, pluginId, 'retained.json');
      const secretPath = join(store.paths.secretsDir, pluginId, 'retained.json');
      await mkdir(join(store.paths.storageDir, pluginId), { recursive: true });
      await mkdir(join(store.paths.secretsDir, pluginId), { recursive: true });
      await writeFile(storagePath, 'retained-storage');
      await writeFile(secretPath, 'retained-secret');
      const generationsBefore = await readdir(store.paths.generationsDir);

      await expect(changes.requestPluginChange({ kind: 'disable', pluginId }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      const restarted = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
      const disabled = await restarted.readSnapshot();
      expect(disabled.bundledPluginEnabledById[pluginId]).toBe(false);
      expect(disabled.state.plugins[pluginId]).toBeUndefined();
      expect(disabled.pluginOccurrenceIds[pluginId]).toBeUndefined();
      expect(disabled.materializationIdsByPluginId[pluginId]).toBeUndefined();
      const disabledEntry = (await readCurrentDaemonPluginCatalog({ happyHomeDir, reloadController }))
        .find(entry => entry.pluginId === pluginId);
      expect(disabledEntry).toMatchObject({ accountEnabled: true, machineEnabled: false, enabled: false });
      expect(disabledEntry?.contributionIntrospection.contributions.length).toBeGreaterThan(0);
      expect(disabledEntry?.contributionIntrospection.contributions.every(contribution => (
        contribution.projection.state === 'unavailable'
        && contribution.activation.state === (contribution.registration.requirement === 'required' ? 'unavailable' : 'notRequired')
      ))).toBe(true);
      const noLeaseController = createPluginReloadController();
      try {
        expect((await readCurrentDaemonPluginCatalog({ happyHomeDir, reloadController: noLeaseController }))
          .find(entry => entry.pluginId === pluginId))
          .toMatchObject({ accountEnabled: true, machineEnabled: false, enabled: false });
      } finally {
        await noLeaseController.shutdown();
      }
      const committed = (await readPluginRegistryCommitRecord(store.paths))!;
      const revision = await readInstallationStateRevision({ paths: store.paths, reference: committed.installationState });
      expect(revision.plugins).toEqual({});
      expect(revision.hardRevocationRevisions?.[pluginId]).toBeUndefined();
      expect(await readdir(store.paths.generationsDir)).toEqual(generationsBefore);
      expect(await readFile(storagePath, 'utf8')).toBe('retained-storage');
      expect(await readFile(secretPath, 'utf8')).toBe('retained-secret');
      expect((await createPluginRegistryStateStore({ happyHomeDir: otherHomeDir }).readSnapshot())
        .bundledPluginEnabledById[pluginId]).toBeUndefined();

      // Unchanged intent publishes no new registry revision or runtime replacement.
      await expect(restarted.setEnabledWithResult(pluginId, false)).resolves.toBeNull();
      expect((await restarted.readSnapshot()).revision).toBe(disabled.revision);
      await restarted.update(current => current);
      expect((await restarted.readSnapshot()).bundledPluginEnabledById[pluginId]).toBe(false);

      const externalRoot = join(happyHomeDir, 'external-plugin');
      await mkdir(join(externalRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(externalRoot, 'daemon.mjs'), 'export function activate() {}');
      await writeFile(join(externalRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.enablement-peer', engines: {},
      })));
      const installation = await changes.requestPluginChange({ kind: 'installPath', locator: externalRoot });
      if (installation.kind !== 'reviewRequired') throw new Error(`Expected review, received ${installation.kind}`);
      await expect(changes.decidePluginChange({ pendingChangeId: installation.pendingChangeId, decision: 'installAndTrust' }))
        .resolves.toMatchObject({ kind: 'committed' });
      expect((await restarted.readSnapshot()).bundledPluginEnabledById[pluginId]).toBe(false);
      await expect(changes.requestPluginChange({ kind: 'uninstall', pluginId: 'acme.enablement-peer' }))
        .resolves.toMatchObject({ kind: 'committed' });
      expect((await restarted.readSnapshot()).bundledPluginEnabledById[pluginId]).toBe(false);

      await expect(changes.requestPluginChange({ kind: 'enable', pluginId }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect((await restarted.readSnapshot()).bundledPluginEnabledById[pluginId] ?? true).toBe(true);
      expect((await readCurrentDaemonPluginCatalog({ happyHomeDir, reloadController }))
        .find(entry => entry.pluginId === pluginId))
        .toMatchObject({ accountEnabled: true, machineEnabled: true, enabled: true });
      expect(await readFile(storagePath, 'utf8')).toBe('retained-storage');
      expect(await readFile(secretPath, 'utf8')).toBe('retained-secret');
      await expect(changes.requestPluginChange({ kind: 'uninstall', pluginId }))
        .resolves.toMatchObject({ kind: 'failed' });
      await expect(restarted.setEnabledWithResult('acme.unknown-bundled', false)).rejects.toThrow('Unknown plugin id');
    } finally {
      await changes.shutdown();
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(otherHomeDir, { recursive: true, force: true });
    }
  });
});
