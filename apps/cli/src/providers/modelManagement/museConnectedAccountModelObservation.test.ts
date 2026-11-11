import { expect, it } from 'vitest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { readConnectedAccountModelCatalog } from './connectedAccountCatalog';
import { createConnectedAccountModelObserver } from './connectedAccountModelObservation';

it('observes native Muse models through its published managed account declaration', async () => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    // The authored fixture needs an installed source generation to activate bundled contributions.
    plugins: [{ manifest: { schemaVersion: 2, id: 'acme.muse-catalog-test', version: '1.0.0', displayName: 'Catalog fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: {} }, files: { 'daemon.mjs': 'export function activate() {}' } }],
    resolveContributes: happyHomeDir => resolveMergedContributionRegistry({ happyHomeDir }),
  });
  try {
    const registry = fixture.registry.contributes;
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const account = { service, accountId: 'selected' };
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential effect during catalog reading'); };
    // Account metadata storage and native model invocation are IO boundaries.
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Selected' } : null,
    });
    const observeModels = createConnectedAccountModelObserver({ registry, invoke: async request => {
      expect(request.id).toBe('cli.muse');
      expect(request.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.muse/muse-account': { source: 'connected', profileId: account.accountId },
      } } });
      return { ok: true, result: { agentId: 'muse', source: 'dynamic', supportsFreeform: false,
        availableModels: [{ id: 'observed', name: 'Observed' }] } };
    } });
    const result = await readConnectedAccountModelCatalog({ registry, observeModels,
      resolveSelection: purposes.resolveBindingIntentSelection,
      request: { machineId: 'machine', connectedAccountTarget: { kind: 'account', account } },
    });
    expect(result.groups).toHaveLength(3);
    expect(result.groups.every(group => group.rows.length === 1 && group.rows[0]?.descriptor.id === 'observed')).toBe(true);
  } finally { await fixture.dispose(); }
});
