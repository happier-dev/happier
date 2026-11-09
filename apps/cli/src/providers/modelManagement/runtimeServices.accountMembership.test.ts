import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  activate,
  PLUGIN_MANIFEST,
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
} from '@happier-dev/plugins-cliproxyapi';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from './runtimeServices';

describe('Connected Account runnable model membership', () => {
  it('withholds the public Muse fallback from runnable membership while preserving diagnostic models', async () => {
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const fixture = await createManagedRunLaunchFixture();
    try {
      const definition = CLIPROXYAPI_PROVIDER_CONTRIBUTION;
      const family = definition.managedRuntime.connectedAccounts.find(row => row.service.pluginId === 'happier.agent.muse');
      if (!family || family.staticModels.length === 0) throw new Error('Public Muse catalog missing');
      expect(plugin.registration('providers', definition.id)?.managedRuntime).toBeDefined();
      const provider = {
        identity: { pluginId: PLUGIN_MANIFEST.id, localId: definition.id },
        pluginId: PLUGIN_MANIFEST.id, provenance: 'external', source: { kind: 'path' }, definition,
      } as const satisfies ResolvedProviderContribution;
      const registry = { ...fixture.lease.registry, contributes: { ...fixture.lease.registry.contributes,
        providersByContributionKey: new Map([[`${PLUGIN_MANIFEST.id}/${definition.id}`, provider]]),
      } };
      const unavailable = async (): Promise<never> => { throw new Error('Unexpected account mutation or credential delivery'); };
      const purposes = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, materializeAccount: unavailable, projectTargetAccounts: unavailable,
        assertTargetAccountMaterializable: unavailable,
        resolveTarget: async target => target.kind === 'account'
          ? { account: target.account, displayName: 'Muse account' } : null,
      });
      const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
        featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => ({ ...fixture.lease, registry }),
        resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
        getAccountSettingsSnapshot: (): never => { throw new Error('Source discovery must not read the personal catalog'); },
        modelSettingsMutation: unavailable,
      });
      const target = { kind: 'account' as const, account: { service: family.service, accountId: 'selected-muse-account' } };
      const diagnostic = await services.projectModels({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
        sourceCatalog: true, connectedAccountTarget: target, refreshPolicy: 'current_only' });
      if (diagnostic.status !== 'success') throw new Error(diagnostic.error.code);
      expect(diagnostic.groups.length).toBeGreaterThan(0);
      for (const group of diagnostic.groups) {
        expect(group.rows.map(row => row.descriptor.id)).toEqual(family.staticModels.map(model => model.id));
        expect(group.rows.every(row => row.confidence === 'account_unverified')).toBe(true);
      }

      const runnable = await services.readSourceModelCatalogs({ machineId: fixture.machineId,
        source: { v: 1, kind: 'connected_account', target, credentialIncarnation: 'muse-credential' },
        refreshPolicy: 'current_only',
      });
      if (runnable.status !== 'success') throw new Error(runnable.error.code);
      expect(runnable.catalogs).toHaveLength(0);
    } finally { await fixture.cleanup(); await plugin.dispose(); }
  });
});
