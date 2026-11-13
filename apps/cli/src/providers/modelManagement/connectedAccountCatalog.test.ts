import { PLUGIN_MANIFEST as KILO_MANIFEST } from '../../../../../packages/plugins/kilo/src/manifest';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema } from '@happier-dev/protocol';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createBrokerProviderRegistry } from '@/providers/broker/providerBroker.testkit';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';

import { projectConnectedAccountCatalog, readConnectedAccountModelCatalog } from './connectedAccountCatalog';
import { projectDaemonProviderTeamCredentialRequestPolicySupportV1 } from './runtimeServices';
import { createConnectedAccountModelObserver } from './connectedAccountModelObservation';

afterEach(() => vi.restoreAllMocks());

it('replaces static membership with one exact current account observation across route applications', async () => {
  const service = { pluginId: 'acme.managed-run', localId: 'accounts' };
  const fixture = await createManagedRunLaunchFixture({ connectedAccounts: [{ purpose: 'models', service: service.localId,
    materializationKinds: ['httpHeaders'] }] });
  try {
  const base = createBrokerProviderRegistry();
  const registry = { ...base, agentDefinitionsById: fixture.lease.registry.contributes.agentDefinitionsById,
    providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => [key, {
    ...provider, definition: ProviderContributionV1Schema.parse({ ...provider.definition, managedRuntime: {
      ...provider.definition.managedRuntime, connectedAccounts: [{ purpose: 'openai-upstream',
        service, catalogObservation: { agent: fixture.lease.registry.contributes.agentDefinitionsById.get(fixture.agentId)!.identity },
        endpointTemplateIds: provider.definition.endpointTemplates.map(endpoint => endpoint.id), staticModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] }],
    } }),
  }])) };
  let sourceCurrent = true;
  const unavailable = async (): Promise<never> => { throw new Error('No mutation, delivery or Gateway during browsing'); };
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
    selectTarget: unavailable, materializeAccount: unavailable, projectTargetAccounts: unavailable,
    assertTargetAccountMaterializable: unavailable,
    resolveTarget: async target => sourceCurrent && target.kind === 'account' ? { account: target.account, displayName: 'Exact source' } : null,
  });
  const account = { service, accountId: 'source-account' };
  const request = { machineId: 'broker', agentTargetKey: 'agent:happier.agent.codex/codex', sourceCatalog: true as const,
    connectedAccountTarget: { kind: 'account' as const, account } };
  let nativeReads = 0;
  let models = [{ id: 'gpt-6.1-sol', name: 'Sol' }];
  let refreshError = false;
  // Only the installed Machine capability transport is replaced; declared source
  // resolution and native observation admission remain real.
  const observeModels = createConnectedAccountModelObserver({ registry, invoke: async request => {
    nativeReads++;
    expect(request.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
      [`${service.pluginId}/${service.localId}`]: { source: 'connected', profileId: account.accountId },
    } } });
    return { ok: true, result: { agentId: fixture.agentId, source: 'dynamic', observedAt: 1, refreshError,
      supportsFreeform: false, availableModels: models } };
  } });
  const input = { registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
    resolveSelection: purposes.resolveBindingIntentSelection, request, observeModels };
  const observed = await projectConnectedAccountCatalog(input);
  expect(observed.groups).toHaveLength(3);
  expect(observed.groups.every(group => !('source' in group))).toBe(true);
  expect(observed.groups.every(group => group.catalogObserved === true)).toBe(true);
  expect(observed.groups.every(group => group.rows.length === 1 && group.rows[0]?.descriptor.id === 'gpt-6.1-sol'
    && group.rows[0].confidence === 'probe' && group.rows[0].sources.probe && !group.rows[0].sources.static)).toBe(true);
  expect(nativeReads).toBe(1);
  expect(await observed.isCurrent()).toBe(true);

  const { agentTargetKey: _workerTarget, ...sourceRequest } = request;
  const source = await readConnectedAccountModelCatalog({ registry, resolveSelection: purposes.resolveBindingIntentSelection,
    request: sourceRequest, observeModels });
  expect(source.groups.map(group => group.sourceRevision)).toEqual(observed.groups.map(group => group.sourceRevision));
  expect(source.groups.flatMap(group => group.rows).every(row => !('agentTargetKey' in row.application))).toBe(true);
  expect(source.groups.flatMap(group => group.rows).map(row => row.descriptor))
    .toEqual(observed.groups.flatMap(group => group.rows).map(row => row.descriptor));
  expect(nativeReads).toBe(2);

  sourceCurrent = false;
  expect(await observed.isCurrent()).toBe(false);
  expect((await projectConnectedAccountCatalog(input)).groups).toEqual([]);
  expect(nativeReads).toBe(2);
  sourceCurrent = true;
  const direct = await projectConnectedAccountCatalog({ ...input, request: { ...request, includeDirectMaterialization: true } });
  // Team direct catalog metadata retains the owner's observed Account membership.
  // The delivery route does not change which models that Account can use.
  expect(direct.groups.map(group => group.rows)).toEqual(observed.groups.map(group => group.rows));
  expect(nativeReads).toBe(3);
  expect(direct.groups.every(group => group.catalogObserved === true)).toBe(true);
  models = [{ id: 'gpt-6.1-terra', name: 'Terra' }];
  const changed = await projectConnectedAccountCatalog(input);
  expect(changed.groups[0]?.rows.map(row => row.descriptor.id)).toEqual(['gpt-6.1-terra']);
  expect(changed.groups[0]?.sourceRevision).not.toBe(observed.groups[0]?.sourceRevision);
  refreshError = true;
  const stale = await projectConnectedAccountCatalog(input);
  expect(stale.groups.every(group => group.rows.every(row => row.catalog.stale))).toBe(true);
  refreshError = false;
  models = [];
  const empty = await projectConnectedAccountCatalog(input);
  expect(empty.groups).toHaveLength(3);
  expect(empty.groups.every(group => group.rows.length === 0 && group.catalogObserved === true)).toBe(true);
  expect(nativeReads).toBe(6);
  models = [{ id: 'source-model', name: 'Managed model' }];
  const managedInput = { ...input,
    request: { ...request, sourceCatalog: undefined },
    agentPurpose: { purpose: 'inference', service, managedProviderEndpoint: {
      provider: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      purpose: 'openai-upstream', modelIdPrefix: 'managed/' } },
  };
  const managed = await projectConnectedAccountCatalog(managedInput);
  // One Agent binding consumes the first accepted endpoint, as launch does.
  expect(managed.groups).toHaveLength(1);
  expect(managed.groups.flatMap(group => group.rows).map(row => row.ref)).toEqual([
    { agentTargetKey: request.agentTargetKey, providerConnectionId: null, modelId: 'managed/source-model' },
  ]);
  expect(nativeReads).toBe(7);
  models = [];
  const managedEmpty = await projectConnectedAccountCatalog(managedInput);
  expect(managedEmpty.groups).toHaveLength(1);
  expect(managedEmpty.groups[0]?.rows).toEqual([]);
  expect(await managedEmpty.isCurrent()).toBe(true);
  expect(nativeReads).toBe(8);
  models = [{ id: 'source-model', name: 'Native namespaced model' }];
  const namespaced = await projectConnectedAccountCatalog({ ...input,
    request: { ...request, sourceCatalog: undefined },
    agentPurpose: { purpose: 'native-inference', service, nativeModelIdPrefix: 'vendor/' },
  });
  expect(namespaced.groups.flatMap(group => group.rows).map(row => ({ ref: row.ref, id: row.descriptor.id }))).toEqual([
    { ref: { agentTargetKey: request.agentTargetKey, providerConnectionId: null, modelId: 'vendor/source-model' }, id: 'source-model' },
  ]);
  const kiloPurpose = KILO_MANIFEST.contributes.agents?.[0]?.connectedAccounts?.find(purpose => purpose.purpose === 'openai-codex-model-request');
  if (!kiloPurpose) throw new Error('Missing declared Kilo subscription purpose');
  const kiloTarget = 'agent:happier.agent.kilo/kilo';
  const kilo = await projectConnectedAccountCatalog({ ...input,
    request: { ...request, agentTargetKey: kiloTarget, sourceCatalog: undefined }, agentPurpose: kiloPurpose,
  });
  expect(kilo.groups.flatMap(group => group.rows).map(row => ({ ref: row.ref, id: row.descriptor.id }))).toEqual([
    { ref: { agentTargetKey: kiloTarget, providerConnectionId: null, modelId: 'openai/source-model' }, id: 'source-model' },
  ]);
  } finally { await fixture.cleanup(); }
});

it('projects a thousand admitted descriptors without another per-model validation pass', async () => {
  const base = createBrokerProviderRegistry();
  const models = Array.from({ length: 1_000 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
  const registry = { ...base, providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => [key, {
    ...provider,
    definition: ProviderContributionV1Schema.parse({ ...provider.definition, managedRuntime: {
      ...provider.definition.managedRuntime,
      connectedAccounts: [{ purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        endpointTemplateIds: ['cliproxyapi-openai-responses'], staticModels: models }],
    } }),
  }])) };
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential effect during catalog projection'); };
  // The Home target and binding store are system boundaries; selection/currentness remain real.
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
    resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null,
  });
  // Observe the real validator without replacing its implementation.
  const descriptorParses = vi.spyOn(ProviderModelDescriptorV1Schema, 'parse');
  const result = await projectConnectedAccountCatalog({ registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
    resolveSelection: purposes.resolveBindingIntentSelection,
    request: { machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', sourceCatalog: true,
      connectedAccountTarget: { kind: 'account', account: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'account-a',
      } } },
  });
  const rows = result.groups.flatMap(group => group.rows);
  expect(rows).toHaveLength(1_000);
  expect(await result.isCurrent()).toBe(true);
  expect.soft(descriptorParses).toHaveBeenCalledTimes(0);

  const application = rows[0]!.application;
  if (!application) throw new Error('Expected the admitted broker application');
  const policies = rows.map(row => projectDaemonProviderTeamCredentialRequestPolicySupportV1({
    application, sourceRevision: result.groups[0]!.sourceRevision!, descriptor: row.descriptor,
  }));
  expect(policies).toHaveLength(1_000);
  expect.soft(policies[0]?.descriptor).toBe(rows[0]!.descriptor);
  expect(descriptorParses).toHaveBeenCalledTimes(0);
});
