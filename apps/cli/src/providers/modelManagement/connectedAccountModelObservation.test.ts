import { expect, it, vi } from 'vitest';
import { PluginConnectedAccountAuthenticationV2Schema, ProviderContributionV1Schema, QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountRequestAuthUseV1Schema } from '@happier-dev/protocol';
import { createPurposeTargetResolver } from '@happier-dev/cli-common/connectedAccounts';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry, resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createBrokerProviderRegistry } from '@/providers/broker/providerBroker.testkit';
import { createAgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { createProviderProbeScheduler } from '@/providers/probe/scheduler';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { createDaemonQualifiedRequestAuthCallbacks } from '@/daemon/connectedServices/requestAuth/createDaemonQualifiedRequestAuthCallbacks';

import { readConnectedAccountModelCatalog } from './connectedAccountCatalog';
import { createConnectedAccountModelObserver } from './connectedAccountModelObservation';

it.each([
  { identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' }, routingId: 'ohMyPi' },
  { identity: { pluginId: 'acme.other', localId: 'ohmypi' }, routingId: 'acme.other/ohmypi' },
])('observes the assigned native Agent routing id $routingId despite a shared local id', async ({ identity, routingId }) => {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    plugins: [{ manifest: { schemaVersion: 2, id: 'acme.other', version: '1.0.0', displayName: 'Other Agent',
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: { agents: [{ id: 'ohmypi', title: 'Other Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }] } },
      files: { 'daemon.mjs': 'export function activate() {}' } }],
    resolveContributes: happyHomeDir => resolveMergedContributionRegistry({ happyHomeDir }),
  });
  try {
    expect(fixture.registry.contributes.agentDefinitionsById.get(routingId)?.identity).toEqual(identity);
    const service = { pluginId: 'happier.agent.ohmypi', localId: 'anthropic' };
    const account = { service, accountId: 'selected' };
    const base = createBrokerProviderRegistry();
    const providers = [...base.providersByContributionKey.values()].map(provider => ({
        ...provider, definition: ProviderContributionV1Schema.parse({ ...provider.definition, connectedAccounts: [{ purpose: 'native-models', service, catalogObservation: { agent: identity },
            endpointTemplateIds: provider.definition.endpointTemplates.map(endpoint => endpoint.id),
            staticModels: [{ id: 'fallback', name: 'Fallback' }] }] }),
    }));
    const registry = { ...createResolvedContributionRegistry({ providers }), agentDefinitionsById: fixture.registry.contributes.agentDefinitionsById };
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential effect during catalog reading'); };
    // Account metadata and the installed Machine capability transport are IO boundaries.
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Selected' } : null,
    });
    const observeModels = createConnectedAccountModelObserver({ registry, invoke: async request => {
      expect(request.id).toBe(`cli.${routingId}`);
      expect(request.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
        [`${service.pluginId}/${service.localId}`]: { source: 'connected', profileId: account.accountId },
      } } });
      return { ok: true, result: { agentId: routingId, source: 'dynamic', supportsFreeform: false,
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

it('observes a declared service with zero Agents through the shared catalog owner, retaining absent and observed-empty', async () => {
  const base = createBrokerProviderRegistry();
  const gateway = [...base.providersByContributionKey.values()][0]!;
  const service = { pluginId: 'acme.service', localId: 'subscription' };
  const identity = { pluginId: service.pluginId, localId: 'upstream' };
  const endpoint = { ...gateway.definition.endpointTemplates[0]!, id: 'upstream', baseUrl: 'https://models.example.com' };
  const upstream = { ...gateway, identity, pluginId: identity.pluginId, definition: ProviderContributionV1Schema.parse({
    v: 1, id: identity.localId, name: 'Upstream', kind: 'cloud', endpointTemplates: [endpoint],
    catalog: { source: 'static+probe', manualModelPolicy: 'catalog-only', membershipPolicy: 'probe-authoritative',
      staticModels: [{ id: 'upstream-fallback', name: 'Fallback' }],
      probes: [{ endpointTemplateId: endpoint.id, path: '/models', parser: 'service-entitlements' }] },
  }) };
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    plugins: [{ manifest: { schemaVersion: 2, id: identity.pluginId, version: '1.0.0', displayName: 'Service catalog',
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: { providers: [upstream.definition] } }, files: { 'daemon.mjs': `
        let activations = 0;
        export function activationCount() { return activations; }
        export function activate(api) {
          activations++;
          api.providers.registerCatalogParser('upstream', 'service-entitlements', input => ({
            models: input.entitlements.map(id => ({ id, name: 'Installed entitlement ' + id })),
          }));
        }
      ` } }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir,
      providerContributionKeys: [`${identity.pluginId}/${identity.localId}`] })),
  });
  try {
  expect(fixture.registry.contributes.agentDefinitionsById.size).toBe(0);
  const activationCount = fixture.modulesByPluginId.get(identity.pluginId)!.activationCount;
  if (typeof activationCount !== 'function') throw new Error('Missing fixture activation counter');
  const registry = createResolvedContributionRegistry({ providers: [
    { ...gateway, definition: ProviderContributionV1Schema.parse({
      ...gateway.definition, connectedAccounts: [{ purpose: 'service-upstream', service, materializationKinds: ['httpHeaders'],
          endpointTemplateIds: gateway.definition.endpointTemplates.map(row => row.id),
          catalogObservation: { provider: identity }, staticModels: [{ id: 'compatibility', name: 'Compatibility' }] }], requestAuthUses: [{ purpose: 'service-upstream', materialization: { kind: 'httpHeaders',
          origin: 'https://models.example.com', headerNames: ['authorization'] } }],
    }) },
    fixture.registry.contributes.providersByContributionKey.get(`${identity.pluginId}/${identity.localId}`)!,
  ] });
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected selection or credential materialization'); };
  const account = { service, accountId: 'selected' };
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, authenticationModeId: 'token', status: 'connected',
    revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true,
    configurationRevision: null, scopes: [], displayName: 'Selected' });
  // V4 metadata, plugin credential materialization and HTTP are the IO boundaries.
  const materializeAccount = vi.fn(async (input: Parameters<ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount']>[0]) => {
    input.credentialRevisionBasis?.captureCredentialRevision(revision);
    return { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer fake-token' } };
  });
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, materializeAccount, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
    resolveCredentialRevision: async () => revision,
    resolveTarget: createPurposeTargetResolver({ available: true,
      resolveService: async () => ({ service, authentication: PluginConnectedAccountAuthenticationV2Schema.parse({
        defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
          fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }] }],
      }) }), listAccounts: async () => [profile],
    }),
  });
  let modelIds = ['entitled'];
  const transport = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ entitlements: modelIds })) }));
  const requestAuth = createConnectedAccountRequestAuthService({
    ...createDaemonQualifiedRequestAuthCallbacks({}),
    refreshAfterAuthFailure: unexpected, reportQuotaFailure: unexpected,
  });
  const lookupRequestAuth = vi.spyOn(requestAuth, 'lookupRequestAuth');
  const observation = createAgentProviderCatalogObservationService({
    activatePurposeBindings: purposes.activatePurposeBindings,
    readBindingObservation: purposes.readBindingObservation,
    requestAuth,
    createRedactionLease: () => createProviderRedactionLease({ values: [] }),
    client: createProviderProbeHttpClient({ resolveAddresses: async () => ['93.184.216.34'], transport }),
    scheduler: createProviderProbeScheduler(),
  });
  let parserAcquisitions = 0;
  let acquiredParserFormats: readonly string[] = [];
  const observeModels = createConnectedAccountModelObserver({ registry,
    resolveContributedCatalogParsers: async identity => {
      parserAcquisitions++;
      const acquired = await fixture.registry.acquireProviderCatalogParsers?.(identity);
      acquiredParserFormats = Object.keys(acquired?.parsersByFormat ?? {});
      return acquired ? { ...acquired, pluginId: identity.pluginId } : null;
    },
    observe: input => {
      expect(QualifiedConnectedAccountRequestAuthUseV1Schema.safeParse(input.requestAuthUse).success).toBe(true);
      return observation.observe(input);
    } });
  const read = (currentOnly: boolean, forceRefresh = false) => readConnectedAccountModelCatalog({ registry,
    resolveSelection: purposes.resolveBindingIntentSelection, observeModels,
    request: { machineId: 'machine', connectedAccountTarget: { kind: 'account', account },
      ...(currentOnly ? { refreshPolicy: 'current_only' as const } : {}), ...(forceRefresh ? { forceRefresh: true as const } : {}) },
  });
  const absent = await read(true);
  expect(absent.groups).toEqual([]);
  expect(absent.error?.code).toBe('provider_catalog_unavailable');
  expect(lookupRequestAuth).toHaveBeenCalledTimes(0);
  expect(materializeAccount).toHaveBeenCalledTimes(0);
  expect(transport).toHaveBeenCalledTimes(0);
  expect(parserAcquisitions).toBe(0);
  expect(activationCount()).toBe(0);

  const refreshed = await read(false);
  expect(refreshed.groups).toHaveLength(3);
  expect(lookupRequestAuth).toHaveBeenCalledTimes(1);
  await expect(lookupRequestAuth.mock.results[0]!.value).resolves.toMatchObject({ credentialContext: { account } });
  expect(materializeAccount).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(parserAcquisitions).toBe(1);
  expect(activationCount()).toBe(1);
  expect(acquiredParserFormats).toEqual(['service-entitlements']);
  expect(refreshed.groups).toMatchObject(Array.from({ length: 3 }, () => ({ rows: [{
    descriptor: { id: 'entitled', name: 'Installed entitlement entitled' }, sources: { probe: true },
  }] })));
  const cached = await read(true);
  expect(cached.groups).toHaveLength(3);
  expect(cached.groups.every(group => group.rows[0]?.descriptor.id === 'entitled')).toBe(true);
  expect(lookupRequestAuth).toHaveBeenCalledTimes(1);
  expect(parserAcquisitions).toBe(1);
  expect(activationCount()).toBe(1);
  modelIds = [];
  const empty = await read(false, true);
  expect(empty.groups).toHaveLength(3);
  expect(empty.groups.every(group => group.rows.length === 0)).toBe(true);
  const cachedEmpty = await read(true);
  expect(cachedEmpty.groups).toHaveLength(3);
  expect(cachedEmpty.groups.every(group => group.rows.length === 0)).toBe(true);
  expect(lookupRequestAuth).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(parserAcquisitions).toBe(2);
  expect(activationCount()).toBe(1);
  } finally { await fixture.dispose(); }
});
