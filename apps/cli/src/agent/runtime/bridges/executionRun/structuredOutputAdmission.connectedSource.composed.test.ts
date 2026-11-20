import { expect, it } from 'vitest';
import { join } from 'node:path';
import type { DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createBrokerProviderRegistry } from '@/providers/broker/providerBroker.testkit';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { projectObservedNativeModelCatalog } from '@/providers/modelManagement/nativeModelObservation';
import { assertExecutionRunStructuredOutputModelAllowed, findNativeExecutionRunOfferedModel, readNativeExecutionRunOfferedModel } from './structuredOutputAdmission';

it('preserves exact and explicitly offered extended-context model facts', () => {
  const base = { id: 'base', name: 'Base', extendedContextModelId: 'extended', contextWindowTokens: 32_768,
    capabilities: { structuredOutput: 'supported' as const } };
  const exact = { id: 'extended', name: 'Exact variant', contextWindowTokens: 65_536 };
  expect(findNativeExecutionRunOfferedModel([base, exact], 'extended')).toBe(exact);
  expect(findNativeExecutionRunOfferedModel([base], 'extended')).toEqual({ id: 'extended', name: 'Base',
    capabilities: { structuredOutput: 'supported' } });
  expect(findNativeExecutionRunOfferedModel([base], 'unoffered')).toBeUndefined();
});

it('admits the selected source model using the same observed descriptor as the native picker', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'run-source-model-' }, async ({ homeDir }) => {
    const service = { pluginId: 'acme.managed-run', localId: 'accounts' };
    const modelId = 'meta/muse-spark-1.3-contributor';
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      connectedAccounts: [{ purpose: 'inference', service: service.localId, materializationKinds: ['httpHeaders'],
        nativeModelIdPrefix: 'meta/' }] });
    try {
      const base = createBrokerProviderRegistry();
      const registry = { ...fixture.lease.registry, contributes: { ...fixture.lease.registry.contributes,
        providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => [key, { ...provider,
          definition: ProviderContributionV1Schema.parse({ ...provider.definition, managedRuntime: { ...provider.definition.managedRuntime,
            connectedAccounts: [{ purpose: 'openai-upstream', service,
              endpointTemplateIds: provider.definition.endpointTemplates.map(endpoint => endpoint.id),
              catalogObservation: { agent: fixture.lease.registry.contributes.agentDefinitionsById.get(fixture.agentId)!.identity } }] } }),
        }])) } };
      const unexpected = async (): Promise<never> => { throw new Error('No credential, mutation or gateway during catalog discovery'); };
      const purposes = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
        resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Selected source' } : null,
      });
      let structuredOutput: 'supported' | 'unknown' | 'unsupported' = 'supported';
      const catalogs = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
        acquireRuntimeLease: async () => ({ ...fixture.lease, registry }), featureGate: { isEnabled: () => true },
        getAccountSettingsSnapshot: () => fixture.snapshot,
        resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
        // Installed native source invocation is the external process boundary.
        invokeConnectedAccountNativeModels: async () => ({ ok: true, result: { agentId: fixture.agentId,
          source: 'dynamic', availableModels: [{ id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor',
            capabilities: { structuredOutput } }], supportsFreeform: false } }),
        modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected catalog mutation'); } });
      const connectedServices = { v: 2 as const, bindingsByServiceId: {
        'acme.managed-run/accounts': { source: 'connected' as const, selection: 'profile' as const,
          profileId: 'upstream-account' },
      } };
      const queries: DaemonProviderModelProjectionRequestV1[] = [];
      const readProviderModels = async (request: DaemonProviderModelProjectionRequestV1) => {
        queries.push(request);
        return await catalogs.projectModels(request);
      };
      // Real catalog/selection/compatibility owners consume the committed plugin
      // fixture; its external Connected Account catalog is the system boundary.
      const control = await catalogs.projectModels({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
        connectedServices, mode: 'picker' });
      expect(control).toMatchObject({ status: 'success', groups: [expect.objectContaining({ catalogObserved: true,
        rows: expect.arrayContaining([expect.objectContaining({ ref: expect.objectContaining({ modelId, providerConnectionId: null }),
          descriptor: expect.objectContaining({ capabilities: { structuredOutput: 'supported' } }),
          compatibility: expect.objectContaining({ confirmed: true }) })]) })] });
      const native = { backendTarget: { kind: 'builtInAgent' as const, agentId: fixture.agentId }, modelId, cwd: homeDir,
        connectedServices, machineId: fixture.machineId, readProviderModels,
        catalogEntry: fixture.lease.registry.contributes.agentDefinitionsById.get(fixture.agentId)?.catalogEntry };
      const readNativeOfferedModel = (request: Parameters<typeof readNativeExecutionRunOfferedModel>[0]) =>
        readNativeExecutionRunOfferedModel({ ...native, ...request });
      await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, readNativeOfferedModel }))
        .resolves.toBeUndefined();
      for (const support of ['unknown', 'unsupported'] as const) {
        structuredOutput = support;
        await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, readNativeOfferedModel }))
          .rejects.toMatchObject({ code: 'model_structured_output_unsupported', details: { modelId, structuredOutput: support } });
      }
      // One selected-source read per admission, with no native re-probe after
      // the source established an unknown or unsupported model fact.
      const query = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, connectedServices, mode: 'picker' };
      expect(queries).toEqual([query, query, query]);
      if (control.status !== 'success') throw new Error('Missing source control');
      expect(projectObservedNativeModelCatalog({ ...control, agentTargetKey: 'agent:other.agent/agent' }, fixture.agentTargetKey))
        .toBeNull();
      expect(projectObservedNativeModelCatalog({ ...control, groups: control.groups.map(group => ({ ...group,
        catalogObserved: false })) }, fixture.agentTargetKey)).toBeNull();
      expect(projectObservedNativeModelCatalog({ ...control, groups: control.groups.map(group => ({ ...group,
        rows: group.rows.map(row => ({ ...row, compatibility: { ...row.compatibility, confirmed: false } })) })) }, fixture.agentTargetKey))
        .toEqual({ availableModels: [], supportsFreeform: false });
    } finally { await fixture.cleanup(); }
  });
});
