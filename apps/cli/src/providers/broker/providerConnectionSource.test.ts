import { describe, expect, it, vi } from 'vitest';
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
} from '@happier-dev/protocol';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import {
  createProviderConnectionBrokerSourceOpen,
  isProviderConnectionBrokerSourceCurrent,
  materializeProviderConnectionDirectCredential,
  isProviderConnectionDirectSourceCurrent,
  materializeProviderConnectionBrokerSource,
  resolveProviderConnectionBrokerSource,
  resolveProviderConnectionDirectSourceSnapshot,
  type ProviderConnectionCpxBridge,
  type ProviderConnectionRegistryReader,
} from './providerConnectionSource';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { createPrivateProviderBrokerStreamLifetime } from './daemonProviderBrokerRuntime';
import { createProviderConnectionCpxBridge } from './providerConnectionCpxBridge';
import { createBrokerProviderRegistry } from './providerBroker.testkit';

const key = new Uint8Array(32).fill(7);
const connectionId = ProviderConnectionIdSchema.parse('pc_team_source');
const contributionKey = 'acme.gateway/gateway';
const definition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'gateway',
  name: 'External gateway',
  kind: 'cloud',
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

function providerSecret(value: string, revision = 1) {
  return { ...sharedSecretResource, resourceId: 'secret-a', revision, displayName: 'Gateway key',
    encryptionMode: 'e2ee' as const, resourceDataKey: key,
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'secret-a', mode: 'e2ee',
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
    savedSecretResources: settings.savedSecretResources };
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
  it('opens the exact Provider source through CPX and leases current credential material per request', async () => {
    const settings = accountSettings();
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
    expect(access?.sourceMemberKey).toBe(computeTeamCredentialSourceMemberKeyV1({
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
    })).resolves.toBeNull();
    await staleLifetime.close();
    const controller = new AbortController();
    const modelList = await access!.access.request({
      pathAndQuery: '/v1/models',
      method: 'GET',
      headers: {},
      body: undefined,
      signal: controller.signal,
    });
    expect(modelList).toMatchObject({ status: 200 });
    expect(credentialValues).toEqual([]);
    const response = await access!.access.request({
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
    await expect(access!.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      headers: {},
      body: new TextEncoder().encode('{"model":"gateway-model"}'),
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 200 });
    expect(credentialValues).toEqual(['Bearer source-secret', 'Bearer source-secret']);
    expect(retire).not.toHaveBeenCalled();
    expect(openCpxProviderConnection).toHaveBeenCalledOnce();
    resourceEnabled = false;
    await expect(access!.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      headers: {},
      body: new TextEncoder().encode('{"model":"gateway-model"}'),
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 403 });
    // Disabling the resource is real authority loss: the refused request
    // leases no credential material and the operation is retired.
    expect(credentialValues).toEqual(['Bearer source-secret', 'Bearer source-secret']);
    expect(retire).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    await streamLifetime.close();
    expect(retire).toHaveBeenCalledOnce();
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
    })).resolves.toBeNull();
    expect(readResource).not.toHaveBeenCalled();
    expect(openCpxProviderConnection).not.toHaveBeenCalled();
  });

  it('retires semantic custody before cleaning a CPX projection rejected after open', async () => {
    const settings = accountSettings();
    const events: string[] = [];
    const retire = vi.fn(async () => { events.push('retire'); });
    const cleanup = vi.fn(async () => { events.push('cleanup'); });
    const open = createProviderConnectionBrokerSourceOpen({
      machineId: 'machine-a',
      readResource: async () => ({
        source: resourceSource(settings),
        brokerPlacement: { kind: 'machine' as const, machineId: 'machine-a' },
        revision: 7,
        enabled: true,
      }),
      withRegistry: async (read) => await read(registry),
      getAccountSettingsSnapshot: () => snapshot(settings),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl,
      openCpxProviderConnection: async () => ({
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
        isCurrent: () => false,
        retire,
        cleanup,
      }),
    });

    await expect(open({
      source: resourceSource(settings),
      resourceId: 'resource-a',
      resourceRevision: 7,
      brokerMachineId: 'machine-a',
      operation: {
        kind: 'resource_test',
        actorAccountId: 'account-a',
        requestId: 'request-a',
      },
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
    })).resolves.toBeNull();
    expect(retire).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events).toEqual(['retire', 'cleanup']);
  });

  it('projects only exact current source facts and materializes through the canonical credential owner', async () => {
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
    const materialized = await materializeProviderConnectionBrokerSource({
      expected: source.snapshot,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    });
    expect(materialized).toMatchObject({ ok: true, lease: { credential: { name: 'authorization', value: 'Bearer source-secret' } } });
    if (materialized.ok) materialized.lease.close();
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
      savedSecretResources: [sharedSecretResource],
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

  it('offers a credential-free currentness check over the exact Provider snapshot', async () => {
    const settings = accountSettings();
    const resolved = resolveProviderConnectionBrokerSource({
      source: resourceSource(settings), machineId: 'machine-a', protocol: 'openai-responses',
      endpointTemplateId: 'responses', ...sourceFacts(settings), registry, dnsEvidenceByEndpointUrl,
    });
    if (!resolved.ok) throw new Error('expected broker source snapshot');
    await expect(isProviderConnectionBrokerSourceCurrent({
      expected: resolved.snapshot,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    })).resolves.toBe(true);
    await expect(isProviderConnectionBrokerSourceCurrent({
      expected: resolved.snapshot,
      registry: { ...registry, runtimeRegistryGeneration: 10 },
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    })).resolves.toBe(true);
    await expect(isProviderConnectionBrokerSourceCurrent({
      expected: resolved.snapshot,
      registry: {
        ...registry,
        runtimeRegistryGeneration: 10,
        providerActivationOccurrenceIdsByPluginId: new Map([['acme.gateway', 'gateway-occurrence-2']]),
      },
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(settings),
    })).resolves.toBe(false);
  });

  it('invalidates connection, endpoint, and grant changes without pinning credential rotation', async () => {
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
      endpointTemplates: definition.endpointTemplates.map((endpoint) => ({
        ...endpoint,
        publicHeaders: { ...endpoint.publicHeaders, 'x-revision': 'changed' },
      })),
    });
    const changedRegistry = {
      ...registry,
      providersByContributionKey: new Map([[contributionKey, {
        ...contribution,
        definition: changedDefinition,
      }]]),
    };
    for (const current of [
      { settings: changedConnection, registry },
      { settings, registry: changedRegistry },
    ]) {
      await expect(isProviderConnectionBrokerSourceCurrent({
        expected: resolved.snapshot,
        registry: current.registry,
        dnsEvidenceByEndpointUrl,
        getAccountSettingsSnapshot: () => snapshot(current.settings),
      })).resolves.toBe(false);
    }
    await expect(isProviderConnectionBrokerSourceCurrent({
      expected: resolved.snapshot,
      registry,
      dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: () => snapshot(rotatedSecret),
    })).resolves.toBe(true);
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
    const settings = accountSettings();
    const source = resourceSource(settings);
    const managedRequests: ManagedServiceRequest[] = [];
    let resourceEnabled = true;
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
    const openProviderConnectionSource = createProviderConnectionBrokerSourceOpen({
      machineId: 'machine-a',
      readResource: async () => ({
        teamId: 'team-a',
        source,
        brokerPlacement: { kind: 'machine' as const, machineId: 'machine-a' },
        revision: 7,
        enabled: resourceEnabled,
      }),
      withRegistry: async (read) => await read(registry),
      getAccountSettingsSnapshot: () => snapshot(settings),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl,
      openCpxProviderConnection: bridge.open,
      resolveExactSelection: async () => ({
        endpointTemplateId: 'responses',
        protocol: 'openai-responses' as const,
        credentialTransport: definition.credential!.transports[0]!,
      }),
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
    const response = await access!.access.request({
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

    resourceEnabled = false;
    await expect(access!.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      body: new TextEncoder().encode('{}'),
    })).resolves.toMatchObject({ status: 403 });
    expect(managedRequests).toHaveLength(1);
    await lifetime.close();
    expect(cleanup).toHaveBeenCalled();
  });
});
