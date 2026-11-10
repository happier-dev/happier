import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { resolveConnectedServiceNativeHomeTarget } from '../materialize/resolveConnectedServiceNativeHomeTarget';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServiceNativeHomeCredentials } from '../stateSharing/materializeConnectedServiceNativeHomeCredentials';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createConnectedServiceGroupHomeCleanupScheduler } from './createConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir, resolveConnectedServiceHomeDir } from './resolveConnectedServiceHomeDir';

let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.kimi', 'happier.agent.devin', 'happier.agent.codex'] } });
});
afterAll(async () => { await fixture?.dispose(); });

describe('pool-selected native Account cleanup', () => {
  it.each(['kimi', 'devin', 'codex'] as const)('removes %s selected and old pool credentials after release, preserving native A and history', async agentId => {
    const root = await createTempDir('happier-selected-pool-cleanup-');
    try {
      const catalog = await fixture.registry.acquireAgentCatalogEntry!(agentId);
      const descriptor = (await catalog!.getConnectedServiceStateSharingDescriptor!())!;
      const nativeHome = descriptor.nativeHome!;
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId, contributions: fixture.registry.contributes })!;
      const scope = declaration.fileMaterializationPurposes[0]!;
      const account = { service: scope.serviceRefs[0]!, accountId: 'B' };
      const serviceId = buildQualifiedPluginContributionKey(account.service);
      const purpose = scope.purpose;
      const binding = { purpose, target: { kind: 'group' as const, service: account.service, groupId: 'pool' } };
      const nativeRoot = join(root, 'unmanaged-native-A');
      const selectedRoot = resolveConnectedServiceNativeHomeTarget({ agentId, activeServerDir: root, nativeHome,
        snapshot: { ...declaration, bindings: [binding] },
        expectedAccountsByPurposeKey: new Map([[qualifiedPurposeKey(purpose), account]]) })!;
      const expectedRoot = join(resolveConnectedServiceHomeDir({ activeServerDir: root, serviceId, profileId: 'B', agentId }), nativeHome.materializedDirectoryName!);
      // A pool must never persist its selected bearer under the shared group identity.
      if (agentId !== 'codex') expect(selectedRoot).toBe(expectedRoot);
      const groupRoot = resolveConnectedServiceGroupHomeDir({ activeServerDir: root, serviceId, groupId: 'pool', agentId });
      const oldRoot = join(groupRoot, nativeHome.materializedDirectoryName!);
      const quarantinedRoot = join(dirname(groupRoot), '.quarantine', `123-${agentId}`, nativeHome.materializedDirectoryName!);
      for (const home of [nativeRoot, selectedRoot, oldRoot, quarantinedRoot]) {
        await mkdir(home, { recursive: true });
        await materializeConnectedServiceNativeHomeCredentials({ targetRoot: home,
          declaredSecretEntries: descriptor.authIsolation.secretEntries,
          files: Object.fromEntries(descriptor.authIsolation.secretEntries.filter(path => path !== 'accounts')
            .map(path => [path, new TextEncoder().encode(home === nativeRoot ? 'fake-native-A' : 'fake-selected-B')])) });
        if (agentId === 'codex') {
          await mkdir(join(home, 'accounts'), { recursive: true });
          await writeFile(join(home, 'accounts', 'saved.json'), home === nativeRoot ? 'fake-native-A' : 'fake-selected-B');
        }
        await writeFile(join(home, 'retained-history'), 'session-history');
      }
      const registry = new ConnectedServiceRuntimeRegistry();
      registry.registerRunTarget({ runKey: 'finite:B', pid: 123, agentId, materializationKey: 'finite:B',
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'B' } } } });
      const scheduler = createConnectedServiceGroupHomeCleanupScheduler({ activeServerDir: root, runtimeRegistry: registry, pidToTrackedSession: new Map() });
      await expect(scheduler.scheduleDeletedAccountCleanup({ account })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      for (const home of [selectedRoot, oldRoot]) for (const path of descriptor.authIsolation.secretEntries) await expect(stat(join(home, path))).resolves.toBeTruthy();
      // Another admitted member can still be using the old shared group root.
      registry.registerRunTarget({ runKey: 'finite:C', pid: 124, agentId, materializationKey: 'finite:C',
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'C' } } } });
      registry.unregisterRunKey('finite:B');
      await scheduler.cleanupPendingDeletedGroupHomes();
      for (const path of descriptor.authIsolation.secretEntries) await expect(stat(join(oldRoot, path))).resolves.toBeTruthy();
      if (agentId !== 'codex') {
        expect(await readFile(join(selectedRoot, 'retained-history'), 'utf8')).toBe('session-history');
        for (const path of descriptor.authIsolation.secretEntries) await expect(stat(join(selectedRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      registry.unregisterRunKey('finite:C');
      await scheduler.cleanupPendingDeletedGroupHomes();
      for (const home of [oldRoot, quarantinedRoot]) {
        for (const path of descriptor.authIsolation.secretEntries) await expect(stat(join(home, path))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(home, 'retained-history'), 'utf8')).toBe('session-history');
      }
      for (const path of descriptor.authIsolation.secretEntries) expect(await readFile(join(nativeRoot, path === 'accounts' ? 'accounts/saved.json' : path), 'utf8')).toBe('fake-native-A');
    } finally { await removeTempDir(root); }
  });

  it('keeps cleanup queued while a previously materialized plugin is disabled and resumes after enablement', async () => {
    const root = await createTempDir('happier-disabled-account-cleanup-');
    const enabledFixture = fixture;
    try {
      const descriptor = (await (await fixture.registry.acquireAgentCatalogEntry!('kimi'))!.getConnectedServiceStateSharingDescriptor!())!;
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'kimi', contributions: fixture.registry.contributes })!;
      const account = { service: declaration.fileMaterializationPurposes[0]!.serviceRefs[0]!, accountId: 'B' };
      const serviceId = buildQualifiedPluginContributionKey(account.service);
      const roots = [
        resolveConnectedServiceHomeDir({ activeServerDir: root, serviceId, profileId: 'B', agentId: 'kimi' }),
        resolveConnectedServiceGroupHomeDir({ activeServerDir: root, serviceId, groupId: 'pool', agentId: 'kimi' }),
      ].map(home => join(home, descriptor.nativeHome!.materializedDirectoryName!));
      for (const home of roots) {
        await mkdir(home, { recursive: true });
        await materializeConnectedServiceNativeHomeCredentials({ targetRoot: home,
          declaredSecretEntries: descriptor.authIsolation.secretEntries,
          files: Object.fromEntries(descriptor.authIsolation.secretEntries.map(path => [path, new TextEncoder().encode('fake-selected-B')])) });
        await writeFile(join(home, 'retained-history'), 'session-history');
      }
      const scheduler = createConnectedServiceGroupHomeCleanupScheduler({ activeServerDir: root, pidToTrackedSession: new Map() });
      const disabled = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.agent.codex'], contributes: getResolvedContributionRegistry({
          pluginEnablementById: { 'happier.agent.kimi': { machineEnabled: false, enabled: false } },
        }) } });
      try {
        await expect(scheduler.scheduleDeletedAccountCleanup({ account })).rejects.toMatchObject({ code: 'agent_not_installed' });
        await expect(scheduler.cleanupPendingDeletedGroupHomes()).rejects.toMatchObject({ code: 'agent_not_installed' });
        for (const home of roots) for (const path of descriptor.authIsolation.secretEntries) {
          expect(await readFile(join(home, path), 'utf8')).toBe('fake-selected-B');
        }
      } finally {
        await disabled.dispose();
        fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.agent.kimi', 'happier.agent.devin', 'happier.agent.codex'] } });
      }
      await scheduler.cleanupPendingDeletedGroupHomes();
      for (const home of roots) {
        for (const path of descriptor.authIsolation.secretEntries) await expect(stat(join(home, path))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(home, 'retained-history'), 'utf8')).toBe('session-history');
      }
    } finally {
      await enabledFixture.dispose();
      await removeTempDir(root);
    }
  });
});
