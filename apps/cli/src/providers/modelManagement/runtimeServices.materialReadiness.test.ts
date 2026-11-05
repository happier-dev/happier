import { afterEach, expect, it } from 'vitest';
import { ProviderConnectionIdSchema, ProviderSettingsV1Schema, formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from './runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
  beginActiveSavedSecretCatalogRefresh,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

afterEach(() => resetActiveAccountSettingsSnapshotForTests());

it.each(['ready', 'temporarily_unavailable'] as const)(
  'projects picker material readiness from its admitted %s snapshot instead of ambient Settings identity',
  async state => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ controller,
      catalogModels: [{ id: 'openrouter/free', name: 'Free router' }],
      probeCatalog: true,
    });
    try {
      const connectionId = ProviderConnectionIdSchema.parse('run-gateway');
      const registry = resolveProviderContributionRegistryView(fixture.contributes,
        fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
      const external = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings,
        connections: fixture.providerSettings.connections.map(connection => ({ ...connection, deployment: { kind: 'external' } })),
        machineGrants: [], accountGrants: [], secretBindingsByConnectionId: {
          [connectionId]: { account: { apiKey: formatSharedSavedSecretRefV1('picker-key') } },
        } });
      const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: fixture.machineId,
        providerSettings: external, registry, dnsEvidenceByEndpointUrl: new Map([['https://example.test/v1', ['1.1.1.1']]]) });
      if (resolved.status !== 'resolved') throw new Error('Expected external Provider');
      const settings = ProviderSettingsV1Schema.parse({ ...external, accountGrants: [{ v: 1, connectionId,
        connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }] });
      setActiveAccountSettingsSnapshot({ ...fixture.snapshot,
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
        savedSecretCatalogState: 'ready', savedSecretResources: [{ resourceId: 'picker-key', ownerAccountId: 'owner',
          displayName: 'Picker key', kind: 'apiKey', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
          storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'picker-key', mode: 'plain',
            content: { v: 1, kind: 'apiKey', name: 'Picker key', value: 'synthetic-picker-material' } }) }] });
      const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, registry,
        featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
        acquireRuntimeLease: async () => {
          const lease = controller.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('Expected current runtime');
          return lease;
        }, resolveAddresses: async () => ['1.1.1.1'],
        modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected mutation'); } });
      const captured = getActiveAccountSettingsSnapshot();
      if (!captured?.scopeKey) throw new Error('Expected admitted Account snapshot');
      const snapshot = { ...captured, savedSecretCatalogState: state };
      // Connected Account persistence and delivery are unused boundaries for
      // this external Saved Secret Provider; keep its purpose owner real.
      const unusedBoundary = async (): Promise<never> => { throw new Error('Unexpected Connected Account effect'); };
      const purposes = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary,
          subscribe: () => ({ dispose() {} }) },
        selectTarget: unusedBoundary, resolveTarget: unusedBoundary,
        materializeAccount: unusedBoundary, projectTargetAccounts: unusedBoundary,
        assertTargetAccountMaterializable: unusedBoundary,
      });
      expect(beginActiveSavedSecretCatalogRefresh({
        scopeKey: captured.scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      })).toBe(true);
      expect(getActiveAccountSettingsSnapshot()?.settings).toBe(snapshot.settings);
      expect(getActiveAccountSettingsSnapshot()?.savedSecretCatalogState).toBe('temporarily_unavailable');

      const result = await services.projectModelsForAccount({
        machineId: fixture.machineId,
        agentTargetKey: fixture.agentTargetKey,
        sourceConnectionId: connectionId,
        mode: 'management',
        refreshPolicy: 'current_only',
      }, {
        getAccountSettingsSnapshot: () => snapshot,
        resolveManagedPurposeBindingIntent: purposes.resolveBindingIntent,
        isCurrent: () => true,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe('success');
      if (result.status !== 'success') throw new Error(result.error.code);
      if (state === 'ready') {
        // Current-only discovery need not have a vendor observation yet, but
        // material readiness must agree with the admitted snapshot.
        expect(result.refreshFailures ?? []).toEqual([]);
      } else {
        expect(result.refreshFailures).toEqual([expect.objectContaining({
          error: expect.objectContaining({ code: 'provider_secret_unavailable', action: 'retry', savedSecretReason: 'reference_unavailable' }),
        })]);
      }
    } finally {
      await fixture.cleanup();
    }
  },
);
