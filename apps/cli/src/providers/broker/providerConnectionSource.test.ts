import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveTeamCredentialResourceSourceCatalogs } from './resourceTestCandidate';
import { readProviderBrokerResponseBody } from '@/providers/broker/providerBroker.testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderConnectionSecurityFingerprintV1Schema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  formatSharedSavedSecretRefV1,
  splitProviderSettingsV1,
  type ProviderSettingsV1,
  sealSavedSecretResourceStoredContentV1,
  createProviderConnectionSecurityFingerprintV1,
} from '@happier-dev/protocol';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import {
  createProviderConnectionBrokerSourceOpen,
  materializeProviderConnectionDirectCredential,
  isProviderConnectionDirectSourceCurrent,
  materializeProviderConnectionBrokerSource,
  resolveProviderConnectionBrokerSource,
  resolveProviderConnectionDirectSourceSnapshot,
  type ProviderConnectionCpxBridge,
  type ProviderConnectionRegistryReader,
} from './providerConnectionSource';
import { providerBrokerApplicationFailureBody } from './providerBrokerApplicationFailure';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { createPrivateProviderBrokerStreamLifetime } from './daemonProviderBrokerRuntime';
import { createProviderConnectionCpxBridge } from './providerConnectionCpxBridge';
import { createBrokerProviderRegistry } from './providerBroker.testkit';
import { createDevelopmentPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';

const key = new Uint8Array(32).fill(7);
const connectionId = ProviderConnectionIdSchema.parse('pc_team_source');
const contributionKey = 'acme.gateway/gateway';
const definition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'gateway',
  name: 'External gateway',
  kind: 'cloud',
  requestCost: { endpointTemplateIds: ['responses'] },
  endpointTemplates: [{
    id: 'responses',
    protocol: 'openai-responses',
    baseUrl: 'https://gateway.example/v1',
    publicHeaders: { 'x-client': 'happ' },
    capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported',
      statefulResponses: 'supported', reasoningControls: 'supported',
    },
  }],
  credential: {
    kind: 'apiKey',
    required: true,
    transports: [{
      id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }, {
      // Valid for a different native Agent transport, but not executable by
      // the CPX final-hop adapter. It must not make the unique header
      // transport ambiguous.
      id: 'query', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'queryParam', name: 'api_key', format: 'raw' },
    }],
  },
  catalog: {
    source: 'static',
    manualModelPolicy: 'allowed',
    staticModels: [{
      id: 'gateway-model',
      name: 'Gateway model',
      capabilities: {
        toolRoundTrips: 'supported',
        reasoningControls: 'supported',
      },
    }],
  },
});
const contribution: ResolvedProviderContribution = {
  provenance: 'external',
  source: { kind: 'path' },
  pluginId: 'acme.gateway',
  identity: { pluginId: 'acme.gateway', localId: 'gateway' },
  definition,
};
const registry = {
  providersByContributionKey: new Map([...createBrokerProviderRegistry().providersByContributionKey, [contributionKey, contribution]]),
  runtimeRegistryGeneration: 9,
  providerActivationOccurrenceIdsByPluginId: new Map([['acme.gateway', 'gateway-occurrence-1']]),
};
const dnsEvidenceByEndpointUrl = new Map([['https://gateway.example/v1', ['1.1.1.1']]]);
const sharedSecretRef = formatSharedSavedSecretRefV1('resource-provider');
const sharedSecretResource = {
  resourceId: 'resource-provider',
  ownerAccountId: 'owner-account',
  displayName: 'Shared provider key',
  kind: 'apiKey' as const,
  encryptionMode: 'plain' as const,
  revision: 1,
  storedContent: sealSavedSecretResourceStoredContentV1({
    resourceId: 'resource-provider',
    mode: 'plain',
    content: { v: 1, name: 'Shared provider key', kind: 'apiKey', value: 'shared-provider-value' },
  }),
  materialStatus: 'ready' as const,
};

function accountSettings(activeRegistry = registry) {
  const initial = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1, id: connectionId, source: { kind: 'contribution', contributionKey },
      role: 'default', displayName: 'Gateway', displayNameMode: 'automatic',
      revision: 3, createdAt: 1, updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId, machineId: 'machine-a', providerSettings: initial,
    registry: activeRegistry, dnsEvidenceByEndpointUrl,
  });
  if (resolution.status !== 'resolved') throw new Error('expected resolved connection');
  return snapshotFromProviderSettings(ProviderSettingsV1Schema.parse({
      ...initial,
      accountGrants: [{
        v: 1, connectionId,
        connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
      secretBindingsByConnectionId: {
        [connectionId]: {
          account: { apiKey: formatSharedSavedSecretRefV1('secret-a') },
          byMachineId: { 'machine-a': { apiKey: formatSharedSavedSecretRefV1('secret-a') } },
        },
      },
  }));
}

function providerSecret(value: string, revision = 1, resourceId = 'secret-a') {
  return { ...sharedSecretResource, resourceId, revision, displayName: 'Gateway key',
    encryptionMode: 'e2ee' as const, resourceDataKey: key,
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee',
      resourceDataKey: key, randomBytes: length => new Uint8Array(length).fill(revision + 10),
      content: { v: 1, name: 'Gateway key', kind: 'apiKey', value } }) };
}

function snapshotFromProviderSettings(providerSettings: ProviderSettingsV1): ActiveAccountSettingsSnapshot {
  const { catalog, defaults } = splitProviderSettingsV1(providerSettings);
  return {
    source: 'cache', settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog },
    savedSecretResources: [providerSecret('source-secret')], savedSecretCatalogState: 'ready',
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken('provider-broker-account'),
  };
}

function snapshot(settings = accountSettings()): ActiveAccountSettingsSnapshot { return settings; }

function sourceFacts(settings: ActiveAccountSettingsSnapshot) {
  return { accountSettings: settings.settings, providerSettings: readProviderSettingsForCli(settings).settings,
    savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(settings) };
}

function resourceSource(settings = accountSettings(), activeRegistry = registry) {
  const resolution = resolveProviderConnectionForMachine({
    connectionId, machineId: 'machine-a', providerSettings: readProviderSettingsForCli(settings).settings,
    registry: activeRegistry, dnsEvidenceByEndpointUrl,
  });
  if (resolution.status !== 'resolved') throw new Error('expected current connection');
  return {
    v: 1 as const,
    kind: 'provider_connection' as const,
    connectionId,
    connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
    credentialSlotId: 'apiKey' as const,
  };
}

describe('Provider Connection Team broker source', () => {
  it.each([
    ['ready', null],
    ['selection', 'source_selection_unavailable'],
    ['resource', 'resource_not_current'],
    ['account', 'account_snapshot_unavailable'],
    ['activation', 'activation_occurrence_unavailable'],
    ['bridge', 'managed_custody_unavailable'],
    ['projection', 'projection_not_current'],
  ] as const)('composes a Team API-key OpenRouter-style source with OpenCode chat: %s', async (scenario, reason) => {
    const chatDefinition = ProviderContributionV1Schema.parse({ ...definition, requestCost: undefined,
      catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'openai/gpt-4.1-mini', name: 'GPT' }] },
      endpointTemplates: [{ ...definition.endpointTemplates[0], id: 'openrouter-openai-chat',
        protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' }],
      credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', uses: ['runtime'],
        protocols: ['openai-chat'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
    });
    const chatRegistry = { ...registry, providersByContributionKey: new Map(registry.providersByContributionKey)
      .set(contributionKey, { ...contribution, definition: chatDefinition }),
      providerActivationOccurrenceIdsByPluginId: scenario === 'activation' ? new Map<string, string>()
        : registry.providerActivationOccurrenceIdsByPluginId };
    const settings = accountSettings(chatRegistry);
    const source = resourceSource(settings, chatRegistry);
    const application = { agentTargetKey: 'agent:happier.agent.opencode/opencode',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-chat', protocol: 'openai-chat' } as const;
    const directory = await mkdtemp(join(tmpdir(), 'provider-openrouter-open-'));
    onTestFinished(async () => { await rm(directory, { recursive: true, force: true }); });
    // The loaded-plugin registry is the external boundary; catalog and exact selection stay real.
    const lease: PluginRuntimeRegistryLease = { source: 'active', durableRevision: 1, release: async () => {},
      registry: { generation: 9, contributes: { providersByContributionKey: chatRegistry.providersByContributionKey },
        readPluginOccurrenceId: (id: string) => registry.providerActivationOccurrenceIdsByPluginId.get(id) ?? null,
      } as unknown as ResolvedExecutablePluginRuntimeRegistry };
    const models = createRuntimeProviderModelManagementServices({ machineId: 'machine-a', registry: chatRegistry,
      runtimeStore: createProviderRuntimeStateStore({ happyHomeDir: directory, machineId: 'machine-a' }),
      client: createProviderProbeHttpClient({ transport: async () => { throw new Error('Static catalog cannot contact a vendor'); } }),
      getAccountSettingsSnapshot: () => settings, featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['1.1.1.1'], acquireRuntimeLease: async () => lease,
      modelSettingsMutation: async () => { throw new Error('Read cannot mutate settings'); },
    });
    const catalog = (await resolveTeamCredentialResourceSourceCatalogs({ machineId: 'machine-a', teamId: 'team-a',
      resourceId: 'team-resource', expectedResourceRevision: 4, source, application,
      readSourceModelCatalogs: models.readSourceModelCatalogs }))[0];
    if (!catalog) throw new Error('Expected Team source catalog');
    const custody: ManagedProviderExplicitStartCustody = {
      acquire: async () => scenario === 'bridge' ? null : ({
        access: { endpointUrl: () => 'http://127.0.0.1:43123/v1',
          request: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null }) },
        isCurrent: () => scenario !== 'projection', cleanup: async () => {},
      }),
      retire: async () => true, retireExternalApiKey: async () => true,
      revalidateRetainedClaims: async () => 0, retireAll: async () => 0,
    };
    const bridge = createProviderConnectionCpxBridge({ custody });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({ machineId: 'machine-a', custody,
      selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null,
      openProviderConnectionSource: createProviderConnectionBrokerSourceOpen({ machineId: 'machine-a',
        readResource: async () => ({ teamId: 'team-a', source, revision: 4, enabled: scenario !== 'resource',
          brokerPlacement: { kind: 'machine', machineId: 'machine-a' } }),
        withRegistry: async read => read(chatRegistry),
        getAccountSettingsSnapshot: () => scenario === 'account' ? null : settings,
        collectDnsEvidence: async () => new Map([['https://openrouter.ai/api/v1', ['1.1.1.1']]]),
        resolveExactSelection: models.resolveTeamCredentialBrokerSourceSelection,
        openCpxProviderConnection: bridge.open,
      }),
    });
    const operation = { kind: 'session', sessionId: 'member-opencode' } as const;
    const lifetime = createPrivateProviderBrokerStreamLifetime({ sourceOwner, application, operation });
    try {
      const result = await lifetime.acquireSource({ source, resourceId: 'team-resource', brokerMachineId: 'machine-a',
        expectedResourceRevision: 4, application, operation, modelId: 'openai/gpt-4.1-mini', sourceRevision: scenario === 'selection' ? 'catalog-r162-stale' : catalog.sourceRevision });
      if (reason) {
        expect(result).toMatchObject({ ok: false, reasonCode: 'resource_unavailable', sourceOpenFailureReason: reason });
        if (!result || !('reasonCode' in result)) throw new Error('Expected source refusal');
        expect(providerBrokerApplicationFailureBody(result, 'team-resource').error.message).toContain(reason);
      }
      else expect(result).toMatchObject({ access: { endpointUrl: expect.any(Function) } });
    } finally { await lifetime.retire(); }
  });

  it('preserves the source secret refusal instead of returning an absent broker source', async () => {
    const settings = accountSettings();
    const source = resourceSource(settings);
    const open = createProviderConnectionBrokerSourceOpen({ machineId: 'machine-a',
      readResource: async () => ({ teamId: 'team-a', source, enabled: true, revision: 2,
        brokerPlacement: { kind: 'machine', machineId: 'machine-a' } }),
      withRegistry: async read => read(registry),
      getAccountSettingsSnapshot: () => ({ ...settings, savedSecretResources: [] }),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl,
      openCpxProviderConnection: async () => { throw new Error('Missing secret must not start a gateway'); },
    });
    await expect(open({ source, resourceId: 'resource-a', resourceRevision: 2, brokerMachineId: 'machine-a',
      operation: { kind: 'resource_test', actorAccountId: 'member', requestId: 'request' },
      application: { agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ failure: { reasonCode: 'provider_secret_missing' } });
  });

  it.each(['ready', 'temporarily_unavailable'] as const)('honors admitted Saved Secret availability %s despite retained ready resource bytes', (savedSecretCatalogState) => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings), machineId: 'machine-a', protocol: 'openai-responses', endpointTemplateId: 'responses',
      ...sourceFacts(settings),
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1({ ...settings, savedSecretCatalogState }),
      registry, dnsEvidenceByEndpointUrl,
    });
    expect(resolved).toMatchObject(savedSecretCatalogState === 'ready'
      ? { ok: true }
      : { ok: false, error: { code: 'provider_secret_unavailable' } });
  });

  it.each([
    { externalSlot: 'primary', relationship: 'owner' }, { externalSlot: 'companion', relationship: 'owner' },
    { externalSlot: 'primary', relationship: 'recipient' }, { externalSlot: 'companion', relationship: 'recipient' },
  ] as const)('refuses an external $externalSlot credential ($relationship) before linking or broker materialization', async ({ externalSlot, relationship }) => {
    const pairedDefinition = ProviderContributionV1Schema.parse({ ...definition, credential: { ...definition.credential,
      transports: [{ ...definition.credential!.transports[0], additionalCredentials: [{ slotId: 'upstreamKey',
        destination: { kind: 'httpHeader', name: 'x-upstream-key', format: 'raw' } }] }],
    } });
    const pairedRegistry = { ...registry, providersByContributionKey: new Map(registry.providersByContributionKey)
      .set(contributionKey, { ...contribution, definition: pairedDefinition }) };
    const settings = readProviderSettingsForCli(accountSettings(pairedRegistry)).settings;
    let current = { ...snapshotFromProviderSettings({ ...settings, secretBindingsByConnectionId: {
      ...settings.secretBindingsByConnectionId, [connectionId]: { ...settings.secretBindingsByConnectionId[connectionId],
        account: { apiKey: formatSharedSavedSecretRefV1('secret-a'), upstreamKey: formatSharedSavedSecretRefV1('secret-b') } },
    } }), savedSecretResources: [providerSecret('source-secret'), providerSecret('upstream-secret', 1, 'secret-b')] };
    const source = resourceSource(current, pairedRegistry);
    const resolve = () => resolveProviderConnectionBrokerSource({ source, machineId: 'machine-a',
      protocol: 'openai-responses', endpointTemplateId: 'responses', ...sourceFacts(current), registry: pairedRegistry, dnsEvidenceByEndpointUrl });
    const admitted = resolve();
    if (!admitted.ok) throw new Error('Expected inline credentials to be supported');
    const resourceId = externalSlot === 'primary' ? 'secret-a' : 'secret-b';
    current = { ...current, savedSecretResources: current.savedSecretResources.map(resource => resource.resourceId !== resourceId ? resource : {
      ...resource, relationship, storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey: key,
        randomBytes: length => new Uint8Array(length).fill(21),
        content: { v: 2, name: 'Gateway key', kind: 'apiKey', source: { kind: 'external',
          contribution: { pluginId: 'acme.vault', localId: 'main' }, account: 'personal', reference: 'op://vault/item/field' } },
      }),
    }) };
    const unsupported = { ok: false, error: { code: 'provider_credential_transport_unavailable', retryable: false, action: 'review_credential_transport' } };
    expect(resolve()).toMatchObject(unsupported);
    await expect(materializeProviderConnectionBrokerSource({ expected: admitted.snapshot, registry: pairedRegistry,
      dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: () => current })).resolves.toMatchObject(unsupported);
  });

  it('admits an exact legacy source pin after a destination-only grant and refuses changed destinations', () => {
    const settings = accountSettings();
    const source = { ...resourceSource(settings), connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse(createProviderConnectionSecurityFingerprintV1({
      securityContractVersion: 1, endpoints: definition.endpointTemplates.map(endpoint => ({ endpointTemplateId: endpoint.id,
        protocol: endpoint.protocol, url: endpoint.baseUrl ?? null, publicHeaders: endpoint.publicHeaders })),
      credentialTransports: definition.credential?.transports ?? [], catalogProbes: [],
    })) };
    const request = { source, machineId: 'machine-a', ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl };
    expect(resolveProviderConnectionBrokerSource({ ...request, protocol: 'openai-responses', endpointTemplateId: 'responses' }))
      .toMatchObject({ ok: true });
    expect(resolveProviderConnectionDirectSourceSnapshot(request)).toMatchObject({ ok: true });
    const changedRegistry = { ...registry, providersByContributionKey: new Map(registry.providersByContributionKey)
      .set(contributionKey, { ...contribution, definition: ProviderContributionV1Schema.parse({ ...definition,
        endpointTemplates: [{ ...definition.endpointTemplates[0], baseUrl: 'https://changed.example/v1' }],
      }) }) };
    expect(resolveProviderConnectionBrokerSource({ ...request, registry: changedRegistry,
      protocol: 'openai-responses', endpointTemplateId: 'responses' })).toMatchObject({ ok: false });
    const changedDeclaration = { ...registry, providersByContributionKey: new Map(registry.providersByContributionKey)
      .set(contributionKey, { ...contribution, definition: ProviderContributionV1Schema.parse({ ...definition,
        catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'responses',
          path: '/models', parser: 'openai-models' }] },
      }) }) };
    expect(resolveProviderConnectionForMachine({ connectionId, machineId: 'machine-a',
      providerSettings: request.providerSettings, registry: changedDeclaration, dnsEvidenceByEndpointUrl }))
      .toMatchObject({ status: 'resolved', record: { authorization: { authorized: true } } });
    expect(resolveProviderConnectionBrokerSource({ ...request, registry: changedDeclaration,
      protocol: 'openai-responses', endpointTemplateId: 'responses' }))
      .toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('leases both independent source secrets and refuses the source after companion withdrawal', async () => {
    const pairedDefinition = ProviderContributionV1Schema.parse({ ...definition, credential: { ...definition.credential,
      transports: [{ ...definition.credential!.transports[0], additionalCredentials: [{ slotId: 'upstreamKey',
        destination: { kind: 'httpHeader', name: 'x-upstream-key', format: 'raw' } }] }],
    } });
    const pairedRegistry = { ...registry, providersByContributionKey: new Map(registry.providersByContributionKey)
      .set(contributionKey, { ...contribution, definition: pairedDefinition }) };
    let current = accountSettings(pairedRegistry);
    const source = resourceSource(current, pairedRegistry);
    const resolve = () => resolveProviderConnectionBrokerSource({ source, machineId: 'machine-a',
      protocol: 'openai-responses', endpointTemplateId: 'responses', ...sourceFacts(current), registry: pairedRegistry, dnsEvidenceByEndpointUrl });
    expect(resolve()).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
    const settings = readProviderSettingsForCli(current).settings;
    current = { ...snapshotFromProviderSettings({ ...settings, secretBindingsByConnectionId: {
      ...settings.secretBindingsByConnectionId, [connectionId]: { ...settings.secretBindingsByConnectionId[connectionId],
        account: { apiKey: formatSharedSavedSecretRefV1('secret-a'), upstreamKey: formatSharedSavedSecretRefV1('secret-b') } },
    } }), savedSecretResources: [providerSecret('source-secret'), providerSecret('upstream-secret', 1, 'secret-b')] };
    const resolved = resolve();
    if (!resolved.ok) throw new Error('Expected independently bound source');
    expect(resolveProviderConnectionDirectSourceSnapshot({ source, machineId: 'machine-a', ...sourceFacts(current),
      registry: pairedRegistry, dnsEvidenceByEndpointUrl })).toMatchObject({ ok: false, error: { code: 'provider_credential_transport_unavailable' } });
    const material = await materializeProviderConnectionBrokerSource({ expected: resolved.snapshot, registry: pairedRegistry,
      dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: () => current });
    expect(material).toMatchObject({ ok: true, lease: { credential: {
      value: 'Bearer source-secret', additionalCredentials: [{ name: 'x-upstream-key', value: 'upstream-secret' }],
    } } });
    if (!material.ok) throw new Error('Expected admitted material');
    expect(material.lease.redact('Bearer source-secret upstream-secret')).toBe('[REDACTED] [REDACTED]');
    material.lease.close();
    current = { ...current, savedSecretResources: [providerSecret('source-secret')] };
    expect(await materializeProviderConnectionBrokerSource({ expected: resolved.snapshot, registry: pairedRegistry,
      dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: () => current })).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
  });

  it('opens the exact Provider source through CPX and leases current credential material per request', async () => {
    let settings = accountSettings();
    const sourceBinding = resourceSource(settings);
    const credentialValues: string[] = [];
    // Records exactly what each hop sent, including an absent header map, so a
    // producer that stops sending headers cannot be mistaken for one that sends none.
    const receivedRequestHeaders: (Readonly<Record<string, string>> | undefined)[] = [];
    const noHeaders: Readonly<Record<string, string>> = {};
    const cleanup = vi.fn(async () => {});
    const retire = vi.fn(async () => {});
    let resourceEnabled = true;
    let resourceRevision = 7;
    const resolveExactSelection = vi.fn(async (candidate: Readonly<{
      modelId: string;
      sourceRevision: string;
    }>) => (
      candidate.modelId === 'gateway-model'
      && candidate.sourceRevision === 'source-revision-a'
        ? {
            endpointTemplateId: 'responses',
            protocol: 'openai-responses' as const,
            credentialTransport: definition.credential!.transports[0]!,
          }
        : null
    ));
    const openCpxProviderConnection = vi.fn<ProviderConnectionCpxBridge['open']>(async (input) => ({
      access: {
        endpointUrl: () => 'http://127.0.0.1:43123/v1',
        request: async (request) => {
          receivedRequestHeaders.push(request.headers);
          if (request.method === 'GET' && request.pathAndQuery === '/v1/models') {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': 'application/json' },
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"data":[{"id":"gateway-model"}]}'));
                  controller.close();
                },
              }),
            };
          }
          const lease = await input.acquireRequestCredential();
          if (!lease) return {
            ok: false,
            status: 403,
            statusText: 'Source unavailable',
            headers: noHeaders,
            body: null,
          };
          credentialValues.push(lease.credential.value);
          try {
            return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: noHeaders,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"model":"gateway-model"}'));
                controller.close();
              },
            }),
            };
          } finally {
            lease.close();
          }
        },
      },
      isCurrent: () => true,
      retire,
      cleanup,
    }));
    const openProviderConnectionSource = createProviderConnectionBrokerSourceOpen({
      machineId: 'machine-a',
      readResource: async () => ({
        teamId: 'team-a',
        // The Home already selected and signed machine-a for this Pool-backed
        // open. Source custody must not turn current Pool membership into a
        // second ongoing ACL.
        brokerPlacement: { kind: 'machine_pool', poolId: 'pool-a' },
        enabled: resourceEnabled,
        revision: resourceRevision,
        source: sourceBinding,
      }),
      withRegistry: async (read) => await read(registry),
      getAccountSettingsSnapshot: () => snapshot(settings),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl,
      openCpxProviderConnection,
      resolveExactSelection,
    });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'machine-a',
      openConnectedServicesSource: async () => null,
      openProviderConnectionSource,
    });
    const application = {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
      } as const;
    const streamLifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner,
      application,
      operation: { kind: 'session', sessionId: 'session-a' },
    });
    const access = await streamLifetime.acquireSource({
      resourceId: 'resource-a',
      brokerMachineId: 'machine-a',
      source: sourceBinding,
      operation: { kind: 'session', sessionId: 'session-a' },
      expectedResourceRevision: 7,
      application,
      modelId: 'gateway-model',
      sourceRevision: 'source-revision-a',
    });
    expect(access).not.toBeNull();
    if (!access || !('access' in access)) throw new Error('Expected acquired Provider source access');
    expect(access.sourceMemberKey).toBe(computeTeamCredentialSourceMemberKeyV1({
      kind: 'provider_credential_slot',
      connectionId: sourceBinding.connectionId,
      credentialSlotId: sourceBinding.credentialSlotId,
    }));
    expect(resolveExactSelection).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-a',
      resourceId: 'resource-a',
      expectedResourceRevision: 7,
      application,
      modelId: 'gateway-model',
      sourceRevision: 'source-revision-a',
    }));
    const staleLifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner,
      application,
      operation: { kind: 'session', sessionId: 'session-stale' },
    });
    await expect(staleLifetime.acquireSource({
      resourceId: 'resource-a',
      brokerMachineId: 'machine-a',
      source: sourceBinding,
      operation: { kind: 'session', sessionId: 'session-stale' },
      expectedResourceRevision: 7,
      application,
      modelId: 'gateway-model',
      sourceRevision: 'source-revision-stale',
    })).resolves.toMatchObject({ ok: false, reasonCode: 'resource_unavailable' });
    await staleLifetime.close();
    const controller = new AbortController();
    const modelList = await access.access.request({
      pathAndQuery: '/v1/models',
      method: 'GET',
      headers: {},
      body: undefined,
      signal: controller.signal,
    });
    expect(modelList).toMatchObject({ status: 200 });
    expect(credentialValues).toEqual([]);
    const response = await access.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      headers: { authorization: 'Bearer worker-must-not-cross' },
      body: new TextEncoder().encode('{"model":"gateway-model"}'),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(credentialValues).toEqual(['Bearer source-secret']);
    expect(receivedRequestHeaders).toEqual([
      {},
      { authorization: 'Bearer worker-must-not-cross' },
    ]);
    expect(openCpxProviderConnection).toHaveBeenCalledOnce();
    expect(JSON.stringify(openCpxProviderConnection.mock.calls[0]?.[0])).not.toContain('source-secret');
    expect(JSON.stringify(openCpxProviderConnection.mock.calls[0]?.[0])).not.toContain('worker-must-not-cross');
    // A policy edit only advances the revision (a mutable policy fact the Home
    // rechecks per request). The next request on this stream presents the new
    // revision and keeps the same operation, projection and source custody.
    resourceRevision = 8;
    await expect(streamLifetime.acquireSource({
      resourceId: 'resource-a',
      brokerMachineId: 'machine-a',
      source: sourceBinding,
      operation: { kind: 'session', sessionId: 'session-a' },
      expectedResourceRevision: 8,
      application,
      modelId: 'gateway-model',
      sourceRevision: 'source-revision-a',
    })).resolves.toBe(access);
    await expect(access.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      headers: {},
      body: new TextEncoder().encode('{"model":"gateway-model"}'),
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 200 });
    expect(credentialValues).toEqual(['Bearer source-secret', 'Bearer source-secret']);
    expect(retire).not.toHaveBeenCalled();
    expect(openCpxProviderConnection).toHaveBeenCalledOnce();
    settings = snapshotFromProviderSettings({ ...readProviderSettingsForCli(settings).settings, accountGrants: [] });
    await expect(access.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      headers: {},
      body: new TextEncoder().encode('{"model":"gateway-model"}'),
      signal: controller.signal,
    })).rejects.toMatchObject({ failure: { ok: false, reasonCode: 'provider_connection_disabled' } });
    // The next credential acquisition refuses a withdrawn source grant.
    // Home request admission owns resource/member withdrawal and retirement.
    expect(credentialValues).toEqual(['Bearer source-secret', 'Bearer source-secret']);
    expect(retire).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await streamLifetime.close();
    expect(retire).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects a non-CPX application before Provider or secret resolution', async () => {
    const settings = accountSettings();
    const readResource = vi.fn(async () => ({
      source: resourceSource(settings),
      brokerPlacement: { kind: 'machine' as const, machineId: 'machine-a' },
      revision: 7,
      enabled: true,
    }));
    const withRegistry: ProviderConnectionRegistryReader = vi.fn(async (read) => await read(registry));
    const openCpxProviderConnection: ProviderConnectionCpxBridge['open'] = vi.fn(async () => null);
    const open = createProviderConnectionBrokerSourceOpen({
      machineId: 'machine-a',
      readResource,
      withRegistry,
      getAccountSettingsSnapshot: () => snapshot(settings),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl,
      openCpxProviderConnection,
    });
    await expect(open({
      source: resourceSource(settings),
      resourceId: 'resource-a',
      resourceRevision: 7,
      brokerMachineId: 'machine-a',
      operation: { kind: 'session', sessionId: 'session-a' },
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'acme.other', localId: 'other' },
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ unavailable: 'application_unavailable' });
    expect(readResource).not.toHaveBeenCalled();
    expect(openCpxProviderConnection).not.toHaveBeenCalled();
  });

  it.each(['gateway_stale', 'source_stale', 'source_unknown', 'selection_unknown'] as const)('settles the captured CPX join without repeating source admission: %s', async failure => {
    const settings = accountSettings();
    const events: string[] = [];
    let joined = false;
    const retire = vi.fn(async () => { events.push('retire'); });
    const cleanup = vi.fn(async () => { events.push('cleanup'); });
    const open = createProviderConnectionBrokerSourceOpen({
      machineId: 'machine-a',
      readResource: async () => {
        if (joined && failure === 'source_unknown') throw new Error('Home unavailable');
        return {
          teamId: 'team-a',
          source: resourceSource(settings),
          brokerPlacement: { kind: 'machine' as const, machineId: 'machine-a' },
          revision: 7,
          enabled: !(joined && failure === 'source_stale'),
        };
      },
      resolveExactSelection: async () => {
        if (joined && failure === 'selection_unknown') throw new Error('Home unavailable');
        return { endpointTemplateId: 'responses', protocol: 'openai-responses',
          credentialTransport: definition.credential!.transports[0]! };
      },
      withRegistry: async (read) => await read(registry),
      getAccountSettingsSnapshot: () => snapshot(settings),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl,
      openCpxProviderConnection: async () => {
        joined = true;
        return {
          access: {
            endpointUrl: () => 'http://127.0.0.1:43123/v1',
            request: async () => ({
              ok: false,
              status: 403,
              statusText: 'Source unavailable',
              headers: {},
              body: null,
            }),
          },
          isCurrent: () => failure !== 'gateway_stale',
          retire,
          cleanup,
        };
      },
    });

    const opened = await open({
      source: resourceSource(settings),
      resourceId: 'resource-a',
      resourceRevision: 7,
      brokerMachineId: 'machine-a',
      operation: failure === 'selection_unknown' ? { kind: 'session', sessionId: 'session-a' } : {
        kind: 'resource_test',
        actorAccountId: 'account-a',
        requestId: 'request-a',
      },
      modelId: 'gateway-model',
      sourceRevision: 'source-revision-a',
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
      },
      signal: new AbortController().signal,
    });
    if (failure !== 'gateway_stale') {
      expect(opened).not.toBeNull();
      expect(retire).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      if (!opened || 'unavailable' in opened) throw new Error('Expected opened source');
      await opened.projection.cleanup();
    } else {
      expect(opened).toEqual({ unavailable: 'projection_not_current' });
      expect(retire).toHaveBeenCalledOnce();
    }
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events).toEqual(failure === 'gateway_stale' ? ['retire', 'cleanup'] : ['cleanup']);
  });

  it('materializes through the fingerprint owner without repeating captured source identity admission', async () => {
    const settings = accountSettings();
    const source = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings),
      machineId: 'machine-a', protocol: 'openai-responses', endpointTemplateId: 'responses',
      ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!source.ok) throw new Error(JSON.stringify(source.error));
    expect(source).toMatchObject({
      ok: true,
      snapshot: {
        connectionRevision: 3,
        machineId: 'machine-a',
        activationOccurrenceId: 'gateway-occurrence-1',
        provider: { identity: contribution.identity, definitionRevision: definition.v },
        endpoint: { normalizedUrl: 'https://gateway.example/v1', publicHeaders: { 'x-client': 'happ' } },
        credentialRef: { transport: { destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } },
      },
    });
    const duplicateIdentityReads = { provider: 0, endpointUrl: 0 };
    // Observe reads without changing the real admitted snapshot's values.
    // Current source fingerprint admission already owns these identity facts.
    const expected = { ...source.snapshot,
      get provider() { duplicateIdentityReads.provider++; return source.snapshot.provider; },
      endpoint: { ...source.snapshot.endpoint,
        get normalizedUrl() { duplicateIdentityReads.endpointUrl++; return source.snapshot.endpoint.normalizedUrl; },
      },
    };
    const materialized = await materializeProviderConnectionBrokerSource({
      expected,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    });
    expect(materialized).toMatchObject({ ok: true, lease: { credential: { name: 'authorization', value: 'Bearer source-secret' } } });
    if (materialized.ok) materialized.lease.close();
    const capture = { expected, registry, dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings) };
    expect(await isProviderConnectionDirectSourceCurrent(capture)).toBe(true);
    expect(await materializeProviderConnectionDirectCredential(capture))
      .toMatchObject({ ok: true, credential: { kind: 'apiKey', value: 'source-secret' } });
    expect(duplicateIdentityReads).toEqual({ provider: 0, endpointUrl: 0 });
  });

  // A contribution may publish several runtime header transports for one
  // protocol. The resource pins exactly one, so final materialization must
  // carry that selection instead of re-deriving a unique transport.
  it('materializes the selected header transport when a Provider publishes several', async () => {
    const ambiguousDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      credential: {
        kind: 'apiKey',
        required: true,
        transports: [
          definition.credential!.transports[0]!,
          {
            id: 'x-api-key', protocols: ['openai-responses'], uses: ['runtime'],
            destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
          },
        ],
      },
    });
    const ambiguousRegistry = {
      ...registry,
      providersByContributionKey: new Map([[contributionKey, { ...contribution, definition: ambiguousDefinition }]]),
    };
    const settings = accountSettings(ambiguousRegistry);
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings, ambiguousRegistry),
      machineId: 'machine-a', protocol: 'openai-responses', endpointTemplateId: 'responses',
      expectedCredentialTransport: ambiguousDefinition.credential!.transports[0]!,
      ...sourceFacts(settings), registry: ambiguousRegistry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));

    const materialized = await materializeProviderConnectionBrokerSource({
      expected: resolved.snapshot, registry: ambiguousRegistry, dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    });
    expect(materialized).toMatchObject({
      ok: true,
      lease: { credential: { name: 'authorization', value: 'Bearer source-secret' } },
    });
    if (materialized.ok) materialized.lease.close();
  });

  it('fails closed when the resource fingerprint is stale', () => {
    const settings = accountSettings();
    expect(resolveProviderConnectionBrokerSource({
      source: {
        v: 1, kind: 'provider_connection', connectionId,
        connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:stale'),
        credentialSlotId: 'apiKey',
      },
      machineId: 'machine-a', protocol: 'openai-responses', endpointTemplateId: 'responses',
      ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    })).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
  });

  it('follows the current Saved Secret in the pinned Provider credential slot', async () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings), machineId: 'machine-a', protocol: 'openai-responses',
      endpointTemplateId: 'responses', ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected broker source snapshot');
    const rotated = { ...settings, savedSecretResources: [providerSecret('rotated-secret', 2)] };
    await expect(materializeProviderConnectionBrokerSource({
      expected: resolved.snapshot, registry, dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(rotated),
    })).resolves.toMatchObject({
      ok: true,
      lease: { credential: { value: 'Bearer rotated-secret' } },
    });
  });

  it('materializes a shared Saved Secret through the canonical catalog owner', async () => {
    const base = accountSettings();
    const settings = snapshotFromProviderSettings(ProviderSettingsV1Schema.parse({
        ...readProviderSettingsForCli(base).settings,
        secretBindingsByConnectionId: {
          [connectionId]: { account: { apiKey: sharedSecretRef } },
        },
      }));
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings),
      machineId: 'machine-a',
      protocol: 'openai-responses',
      endpointTemplateId: 'responses',
      ...sourceFacts(settings),
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1({ ...settings, savedSecretResources: [sharedSecretResource] }),
      registry,
      dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected broker source snapshot');
    const materialized = await materializeProviderConnectionBrokerSource({
      expected: resolved.snapshot,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => ({
        ...snapshot(settings),
        savedSecretResources: [sharedSecretResource],
      }),
    });
    expect(materialized).toMatchObject({
      ok: true,
      lease: { credential: { value: 'Bearer shared-provider-value' } },
    });
    if (materialized.ok) materialized.lease.close();
  });

  it('keeps an external Provider source current across an unrelated registry replacement', async () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings), machineId: 'machine-a', protocol: 'openai-responses',
      endpointTemplateId: 'responses', ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected broker source snapshot');
    await expect(materializeProviderConnectionBrokerSource({
      expected: resolved.snapshot,
      registry: { ...registry, runtimeRegistryGeneration: 10 },
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    })).resolves.toMatchObject({ ok: true });
  });

  it('keeps the source current across rename and declaration churn without pinning credential rotation', async () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings), machineId: 'machine-a', protocol: 'openai-responses',
      endpointTemplateId: 'responses', ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected broker source snapshot');
    const providerSettings = readProviderSettingsForCli(settings).settings;
    const changedConnection = snapshotFromProviderSettings(ProviderSettingsV1Schema.parse({
        ...providerSettings,
        connections: providerSettings.connections.map((connection) => (
          connection.id === connectionId
            ? { ...connection, revision: connection.revision + 1, displayName: 'Changed gateway' }
            : connection
        )),
      }));
    const rotatedSecret = { ...settings, savedSecretResources: [providerSecret('rotated-secret', 2)] };
    const changedDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      name: 'Renamed Provider declaration',
      catalog: { ...definition.catalog, staticModels: [{ id: 'gateway-model', name: 'Renamed model' }] },
    });
    const changedRegistry = {
      ...registry,
      providersByContributionKey: new Map([[contributionKey, {
        ...contribution,
        definition: changedDefinition,
      }]]),
    };
    for (const current of [
      { settings: changedConnection, registry, value: 'Bearer source-secret' },
      { settings, registry: changedRegistry, value: 'Bearer source-secret' },
      { settings: rotatedSecret, registry, value: 'Bearer rotated-secret' },
    ]) {
      const materialized = await materializeProviderConnectionBrokerSource({
        expected: resolved.snapshot,
        registry: current.registry,
        dnsEvidenceByEndpointUrl,
        getAccountSettingsSnapshot: () => snapshot(current.settings),
      });
      expect(materialized).toMatchObject({ ok: true, lease: { credential: { value: current.value } } });
      if (materialized.ok) materialized.lease.close();
    }
  });

  it('invalidates a direct-material snapshot when its exact Saved Secret rotates or disappears', async () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionDirectSourceSnapshot({
      source: resourceSource(settings), machineId: 'machine-a',
      ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected direct source snapshot');
    const rotatedSecret = { ...settings, savedSecretResources: [providerSecret('rotated-secret', 2)] };
    for (const currentSettings of [rotatedSecret, { ...settings, savedSecretResources: [] }]) {
      await expect(isProviderConnectionDirectSourceCurrent({
        expected: resolved.snapshot,
        registry,
        dnsEvidenceByEndpointUrl,
        getAccountSettingsSnapshot: () => snapshot(currentSettings),
      })).resolves.toBe(false);
    }
    await expect(isProviderConnectionDirectSourceCurrent({
      expected: resolved.snapshot,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    })).resolves.toBe(true);
  });

  it('materializes an unrendered credential only through the direct source owner', async () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings), machineId: 'machine-a', protocol: 'openai-responses',
      endpointTemplateId: 'responses', ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected broker source snapshot');
    await expect(materializeProviderConnectionDirectCredential({
      expected: resolved.snapshot,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    })).resolves.toEqual({
      ok: true,
      credential: { kind: 'apiKey', value: 'source-secret' },
    });
  });

  it('selects the canonical Provider snapshot for direct preparation without a consumer endpoint choice', () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionDirectSourceSnapshot({
      source: resourceSource(settings),
      machineId: 'machine-a',
      ...sourceFacts(settings),
      registry,
      dnsEvidenceByEndpointUrl,
    });

    expect(resolved).toMatchObject({
      ok: true,
      snapshot: {
        machineId: 'machine-a',
        endpoint: { endpointTemplateId: 'responses', protocol: 'openai-responses' },
        credentialRef: { reference: { kind: 'apiKey', secretId: formatSharedSavedSecretRefV1('secret-a') } },
      },
    });
  });

  it('composes the source owner through the real CPX bridge and revokes before the next request', async () => {
    let settings = accountSettings();
    const source = resourceSource(settings);
    const managedRequests: ManagedServiceRequest[] = [];
    let resourceEnabled = true;
    let resourceReads = 0;
    let registryReads = 0;
    let dnsReads = 0;
    let selectionReads = 0;
    const cleanup = vi.fn(async () => {});
    const managedRequest = vi.fn(async (request: ManagedServiceRequest): Promise<ManagedServiceResponse> => {
      managedRequests.push(request);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: new Response('{"ok":true}').body,
      };
    });
    const custody: ManagedProviderExplicitStartCustody = {
      acquire: vi.fn(async () => ({
        access: {
          endpointUrl: () => 'http://127.0.0.1:43123/v1',
          request: managedRequest,
        },
        isCurrent: () => true,
        cleanup,
      })),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    };
    const bridge = createProviderConnectionCpxBridge({ custody });
    let costCurrent = true;
    let costEndpoints = ['responses'];
    const costAcquisitions: unknown[] = [];
    const openProviderConnectionSource = createProviderConnectionBrokerSourceOpen({
      acquireRequestCostParser: async (identity) => {
        costAcquisitions.push(identity);
        return { parse: () => 0.12, endpointTemplateIds: costEndpoints,
          activationOccurrenceId: 'gateway-occurrence-1', isCurrent: () => costCurrent,
          sourceCustody: createDevelopmentPluginSourceCustody('acme-gateway-root') };
      },
      machineId: 'machine-a',
      readResource: async () => {
        resourceReads++;
        return {
        teamId: 'team-a',
        source,
        brokerPlacement: { kind: 'machine' as const, machineId: 'machine-a' },
        revision: 7,
        enabled: resourceEnabled,
        };
      },
      withRegistry: async (read) => { registryReads++; return await read(registry); },
      getAccountSettingsSnapshot: () => snapshot(settings),
      collectDnsEvidence: async () => { dnsReads++; return dnsEvidenceByEndpointUrl; },
      openCpxProviderConnection: bridge.open,
      resolveExactSelection: async () => {
        selectionReads++;
        return {
        endpointTemplateId: 'responses',
        protocol: 'openai-responses' as const,
        credentialTransport: definition.credential!.transports[0]!,
        };
      },
    });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      machineId: 'machine-a',
      custody,
      selectConnectedServicesSourceMember: async () => null,
      openConnectedServicesSource: async () => null,
      openProviderConnectionSource,
    });
    const lifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner,
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
      },
      operation: { kind: 'session', sessionId: 'session-composed' },
    });
    const access = await lifetime.acquireSource({
      resourceId: 'resource-composed',
      brokerMachineId: 'machine-a',
      source,
      operation: { kind: 'session', sessionId: 'session-composed' },
      expectedResourceRevision: 7,
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
      },
      modelId: 'gateway-model',
      sourceRevision: 'source-revision-a',
    });
    expect(access).not.toBeNull();
    expect(costAcquisitions).toHaveLength(0);
    if (!access || !('access' in access)) throw new Error('Expected acquired Provider source access');
    expect({ resourceReads, registryReads, dnsReads, selectionReads }).toEqual({
      resourceReads: 1, registryReads: 1, dnsReads: 1, selectionReads: 1,
    });
    const response = await access.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      headers: { authorization: 'Bearer worker' },
      body: new TextEncoder().encode('{}'),
    });
    expect(response.status).toBe(200);
    expect(managedRequests).toHaveLength(1);
    expect(managedRequests[0]?.headers).toMatchObject({
      'x-happier-provider-source-credential': 'Bearer source-secret',
      'accept-encoding': 'identity',
    });
    expect(managedRequests[0]?.headers).not.toHaveProperty('authorization');
    expect({ resourceReads, registryReads, dnsReads, selectionReads }).toEqual({
      resourceReads: 1, registryReads: 1, dnsReads: 1, selectionReads: 1,
    });

    const renamed = readProviderSettingsForCli(settings).settings;
    settings = snapshotFromProviderSettings({ ...renamed, connections: renamed.connections.map(connection => ({
      ...connection, revision: connection.revision + 1, displayName: 'Renamed gateway',
    })) });
    const afterRename = await access.access.request({ pathAndQuery: '/v1/responses', method: 'POST',
      body: new TextEncoder().encode('{}') });
    expect(afterRename.status).toBe(200);
    await new Response(await readProviderBrokerResponseBody(afterRename.body)).text();
    expect(managedRequests).toHaveLength(2);
    expect({ resourceReads, registryReads, dnsReads, selectionReads }).toEqual({
      resourceReads: 1, registryReads: 1, dnsReads: 1, selectionReads: 1,
    });

    const externalRequest = { resourceId: 'resource-composed', resourceRevision: 7, brokerMachineId: 'machine-a',
      source, operation: { kind: 'external_api_key' as const, externalApiKeyId: 'external-key', operationId: 'operation-1',
        assignedAccountId: 'actor', assignedTeamMembershipId: 'member' },
      application: { agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const },
      signal: new AbortController().signal };
    const external = await sourceOwner.acquire(externalRequest);
    if (!external.ok) throw new Error('Expected external source');
    expect(costAcquisitions).toEqual([{ pluginId: 'acme.gateway', localId: 'gateway' }]);
    expect(external.projection.requestCostParser?.({ cost: 0.12 })).toBe(0.12);
    costCurrent = false;
    expect(external.projection.requestCostParser?.({ cost: 0.12 })).toBeNull();
    await external.projection.cleanup();
    costCurrent = true;
    costEndpoints = ['unrelated-endpoint'];
    const unsupported = await sourceOwner.acquire({ ...externalRequest, operation: { ...externalRequest.operation, operationId: 'operation-2' } });
    if (!unsupported.ok) throw new Error('Expected external source');
    expect(unsupported.projection.requestCostParser).toBeUndefined();
    await unsupported.projection.cleanup();

    const providerSettings = readProviderSettingsForCli(settings).settings;
    settings = snapshotFromProviderSettings({ ...providerSettings, accountGrants: [] });
    await expect(access.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      body: new TextEncoder().encode('{}'),
    })).rejects.toMatchObject({ failure: { reasonCode: 'source_unavailable' } });
    expect(managedRequests).toHaveLength(2);
    await lifetime.close();
    expect(cleanup).toHaveBeenCalled();
  });
});
