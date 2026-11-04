import { createUnavailableManagedServices } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createServer } from 'node:http';
import { once } from 'node:events';
import tweetnacl from 'tweetnacl';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, PLUGIN_MANIFEST } from '@happier-dev/plugins-cliproxyapi';
import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { createCLIProxyAPIManagedHealthResponse } from '../../../../../packages/plugins/cliproxyapi/src/provider/managedHealth.testkit';
import { evaluateTeamCredentialRequestPolicyV1 } from './requestPolicyV1';
import { PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from './providerBrokerPrivateProtocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { TeamCredentialDirectMaterialPayloadV1Schema, type TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { resolveTeamCredentialModelCompatibility } from './teamCredentialModelCompatibility';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { ProviderBrokerAdmissionFailureCodeV1Schema, createProviderBrokerRouteGrantSigningInputV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { DaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { MachineCarrierError } from '@/daemon/peer/iroh/machineCarrier';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import { logger } from '@/ui/logger';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER, writeProviderBrokerApplicationFailure } from './providerBrokerApplicationServer';

import {
  openExactSessionTeamCredentialProviderBinding,
  openSessionTeamCredentialProviderBinding,
  type SessionTeamCredentialDirectOpen,
} from './sessionTeamCredentialProviderBinding';

type ProviderAdapter = NonNullable<NonNullable<Parameters<PluginApi['agents']['register']>[2]>['providerBinding']>;
type ExactOpenBroker = NonNullable<Parameters<typeof openExactSessionTeamCredentialProviderBinding>[0]['openBroker']>;

const prepareSpawnEnv: ProviderAdapter['prepare'] = () => ({ v: 1, materialization: 'spawnEnv' });
const materializeEmptySpawnEnv: ProviderAdapter['materialize'] = () => ({ v: 1, kind: 'spawnEnv', env: [] });
const materializeBrokerAuthoritySpawnEnv: ProviderAdapter['materialize'] = (input) => ({
  v: 1,
  kind: 'spawnEnv',
  env: [{
    name: 'BROKER_AUTHORITY',
    value: input.credential.kind === 'apiKey' ? input.credential.value : null,
    source: 'provider',
  }],
});
const materializeNullBrokerAuthoritySpawnEnv: ProviderAdapter['materialize'] = () => ({
  v: 1,
  kind: 'spawnEnv',
  env: [{ name: 'BROKER_AUTHORITY', value: null, source: 'provider' }],
});

function lease(adapter: ProviderAdapter, protocol = 'openai-responses'): PluginRuntimeRegistryLease {
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([['codex', { definition: {
        id: 'codex', kindVersion: 1,
        providerRequirements: {
          acceptsProtocols: [protocol], required: { streaming: true, toolRoundTrips: true },
          credentialSupport: { supportsNoAuth: false, apiKeyTransports: [{
            protocol,
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
          }] },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['BROKER_AUTHORITY'] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: false,
        },
      }, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }]]),
    },
    agentRuntimesByAgentId: new Map([['codex', {
      pluginId: 'happier.agent.codex', pluginVersion: '1', agentId: 'codex', generation: '1',
      providerBinding: adapter, isCurrent: () => true,
      retirementSignal: new AbortController().signal,
      createRuntime: vi.fn(),
    }]]),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return { registry, source: 'active', durableRevision: 1, release: async () => undefined };
}

const row = {
  selection: {
    kind: 'team_credential_provider_model' as const,
    resourceId: 'resource-1', teamId: 'team-1', expectedResourceRevision: 3,
    deliveryMode: 'brokered' as const,
    agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
  },
  descriptor: { id: 'gpt-5', name: 'GPT-5 Dynamic', description: 'Source-owned descriptor', contextWindowTokens: 131_072,
    capabilities: { toolRoundTrips: 'supported' as const } },
  application: {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    implementationIdentity: { pluginId: 'happier.provider.clipro', localId: 'clipro' },
    endpointTemplateId: 'responses', protocol: 'openai-responses',
  },
  sourceRevision: 'catalog:3', availability: 'available' as const,
  sourceFacts: ProviderModelBindingSourceV1Schema.parse({
    endpoint: { id: 'responses', protocol: 'openai-responses', capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported',
    } },
    credential: { kind: 'apiKey', required: true, slotId: 'apiKey', transports: [{ id: 'bearer',
      protocols: ['openai-responses'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
    compatibilityOverrides: [{ agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', status: 'verified',
      reason: 'Fixture contract', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-20' } }],
  }),
} as const;

const authority = {
  payload: {
    v: 1 as const, grantId: 'grant-1', aud: 'happier-provider-broker-route-v1' as const,
    issuedAt: 1, expiresAt: 2, teamId: 'team-1', resourceId: 'resource-1',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    sourceRevision: 'catalog:3',
    initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
    target: { custodianAccountId: 'account-2', machineId: 'broker-1', endpointId: 'b'.repeat(64) },
    consumer: { kind: 'session' as const, sessionId: 'session-1' },
    application: row.application,
  },
  signature: { alg: 'Ed25519' as const, keyId: 'home', valueBase64Url: 'A'.repeat(86) },
};

describe('Session Team credential Provider binding', () => {
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());

  it.each(['brokered', 'direct', 'vendor-native'] as const)('admits an experimental Team pairing without anyone confirming (%s)', async deliveryMode => {
    const sourceFacts = { ...row.sourceFacts, compatibilityOverrides: row.sourceFacts.compatibilityOverrides!.map(override => ({
      ...override, status: 'experimental' as const,
    })) };
    const workerLease = lease({ v: 1, adapterVersion: 1, prepare: prepareSpawnEnv, materialize: materializeEmptySpawnEnv });
    const unconfirmed = await resolveTeamCredentialModelCompatibility({ lease: workerLease, agentId: 'codex',
      model: { ...row, sourceFacts, deliveryMode } });
    expect(unconfirmed).toMatchObject({ result: { status: 'experimental' }, confirmed: true });
  });

  it('reuses the installed native placeholder without a controller catalog and awaits local release', async () => {
    const credentialTransport = row.sourceFacts.credential?.transports[0];
    if (!credentialTransport) throw new Error('Expected the native credential transport');
    const nativeDelivery = { managedId: 'managed-1', controllerInstallationId: 'controller-installation',
      guestInstallationId: 'guest-installation', bindingKey: 'binding-native', placeholderRef: 'placeholder-ref',
      sourceRevision: row.sourceRevision, providerTicket: 't'.repeat(43) };
    const offered = { ...row, selection: { ...row.selection, deliveryMode: 'vendor-native' as const },
      nativeSource: { providerTicket: nativeDelivery.providerTicket } };
    let currentModel: TeamCredentialProviderModelCatalogEntryV1 = offered;
    const placeholder = 'binding-placeholder';
    const publicHeaders = { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' };
    let released = false;
    const open = () => openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: row.selection.agentTargetKey, modelId: row.selection.modelId,
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: row.selection.resourceId,
        expectedResourceRevision: 3, deliveryMode: 'vendor-native', nativeDelivery },
      lease: lease({ v: 1, adapterVersion: 1, prepare: prepareSpawnEnv, materialize: input => {
        expect(input.binding.endpoint.publicHeaders).toEqual(publicHeaders);
        return materializeBrokerAuthoritySpawnEnv(input);
      } }),
      materializationBaseDir: '/tmp/happier-team-native', signal: new AbortController().signal,
      readCatalog: async () => { throw new Error('Installed native use must not reread the controller catalog'); },
      openVendorNative: async () => ({ model: currentModel, endpoint: { endpointTemplateId: row.application.endpointTemplateId,
        normalizedUrl: 'https://gateway.example.test/v1', protocol: row.application.protocol, publicHeaders },
        credentialTransport, placeholder,
        cleanup: async () => { await Promise.resolve(); released = true; } }),
      openBroker: async () => { throw new Error('Native cannot acquire broker authority'); },
      openTeamDirect: async () => { throw new Error('Native cannot resolve company plaintext'); },
    });
    const opened = await open();
    expect(opened?.providerBinding.upstream?.normalizedUrl).toBe('https://gateway.example.test/v1');
    expect(opened?.environmentOverlay).toEqual([{ name: 'BROKER_AUTHORITY', value: placeholder, source: 'provider' }]);
    await opened?.cleanup();
    expect(released).toBe(true);
    for (const substituted of [
      { ...offered, selection: { ...offered.selection, resourceId: 'another-resource' } },
      { ...offered, sourceRevision: 'changed-source' },
      { ...offered, nativeSource: { providerTicket: 'x'.repeat(43) } },
    ]) {
      currentModel = substituted;
      released = false;
      await expect(open()).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
      expect(released).toBe(true);
    }
  });

  it.each(['vendor-native', 'future-route'])('refuses an unsupported %s route without opening a broker or direct material', async deliveryMode => {
    const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: row.selection.resourceId,
      expectedResourceRevision: 3, deliveryMode: 'brokered' as const };
    const offered = { ...row, selection: { ...row.selection } };
    // Exercise an untrusted/future route at the catalog/intent ingress boundary.
    Reflect.set(binding, 'deliveryMode', deliveryMode);
    Reflect.set(offered.selection, 'deliveryMode', deliveryMode);
    let brokerOpens = 0;
    let directOpens = 0;
    const open = openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: row.selection.agentTargetKey, modelId: row.selection.modelId, binding,
      lease: lease({ v: 1, adapterVersion: 1, prepare: prepareSpawnEnv, materialize: materializeEmptySpawnEnv }),
      materializationBaseDir: '/tmp/happier-team-unsupported-route', signal: new AbortController().signal,
      readCatalog: async () => [offered],
      openBroker: async () => { brokerOpens++; return { ok: false, reasonCode: 'broker_unavailable' }; },
      openTunnel: async () => { throw new Error('Unsupported delivery cannot open a tunnel'); },
      openTeamDirect: async () => { directOpens++; return { ok: false, reason: 'temporarily_unavailable' }; },
    });
    await expect(open).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
    expect(brokerOpens).toBe(0);
    expect(directOpens).toBe(0);
  });

  it.each(ProviderBrokerAdmissionFailureCodeV1Schema.options)('retains exact broker-open refusal %s as a typed launch error', async code => {
    const refused = await openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: { ...row.selection, descriptor: row.descriptor, application: row.application,
        sourceRevision: row.sourceRevision, sourceFacts: row.sourceFacts, brokerMachineId: 'broker-1' },
      lease: lease({ v: 1, adapterVersion: 1, prepare: prepareSpawnEnv, materialize: materializeEmptySpawnEnv }),
      materializationBaseDir: '/tmp/happier-team-broker-refusal', signal: new AbortController().signal,
      openBroker: async () => ({ ok: false, reasonCode: code }),
      openTunnel: async () => { throw new Error('Refused broker must not open tunnel'); },
    }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionTeamCredentialLaunchUnavailableError);
    expect(refused).toMatchObject({ code, message: code });
  });

  it('launches experimental Team models without consent and recomputes hard compatibility with the worker adapter', async () => {
    const sourceFacts = { ...row.sourceFacts, compatibilityOverrides: row.sourceFacts.compatibilityOverrides!.map(override => ({
      ...override, status: 'experimental' as const,
    })) };
    // The worker recomputes compatibility even if the source claimed verified.
    const offered = { ...row, sourceFacts, compatibility: { result: { status: 'verified' as const,
      selectedProtocol: 'openai-responses', evidence: row.sourceFacts.compatibilityOverrides![0]!.evidence! },
      compatibilityFingerprint: 'compatibility:v1:foreign', confirmed: true } };
    const settings = ProviderSettingsV1Schema.parse(DEFAULT_PROVIDER_SETTINGS_V1);
    const publish = () => setActiveAccountSettingsSnapshot({ source: 'cache', scopeKey: 'recipient-account',
      settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog } });
    publish();
    const adapter = { v: 1 as const, adapterVersion: 1, prepare: prepareSpawnEnv, materialize: materializeBrokerAuthoritySpawnEnv };
    const workerLease = lease(adapter);
    const compatibility = await resolveTeamCredentialModelCompatibility({ lease: workerLease, agentId: 'codex',
      model: { ...offered, deliveryMode: 'brokered' } });
    const open = (selectedLease = workerLease) => openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex', agentTargetKey: row.selection.agentTargetKey,
      modelId: row.selection.modelId, binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: row.selection.resourceId,
        expectedResourceRevision: 3, deliveryMode: 'brokered' },
      lease: selectedLease, materializationBaseDir: '/tmp/happier-team-recipient-confirmation', signal: new AbortController().signal,
      readCatalog: async () => [offered], openBroker: async () => ({ ok: true, authority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64),
          endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'relay',
        retire: async () => undefined, close: async () => undefined }),
    });
    if (compatibility.result.status !== 'experimental') throw new Error('Expected experimental worker binding');
    expect(settings.experimentalBindingConfirmations).toEqual([]);
    const opened = await open();
    if (!opened) throw new Error('Expected admitted Team Provider binding');
    await opened.cleanup();
    const changedAdapter = await open(lease({ ...adapter, adapterVersion: 2 }));
    await changedAdapter?.cleanup();
    await expect(open(lease(adapter, 'anthropic'))).rejects.toMatchObject({ code: 'provider_incompatible_with_agent' });
  });
  // The tunnel's HTTP transport is the system boundary; ordinary custody cases
  // receive the same endpoint metadata the broker publishes for Responses.
  beforeEach(() => vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
    new Response(null, { status: 204, headers: { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' } }))));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['anthropic', 'cliproxyapi-anthropic', '/v1/messages'],
    ['openai-responses', 'cliproxyapi-openai-responses', '/v1/responses'],
    ['openai-chat', 'cliproxyapi-openai-chat', '/v1/chat/completions'],
  ] as const)('composes the declared Team %s endpoint with the real Agent SDK and request policy', async (protocol, endpointTemplateId, expectedPath) => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const runtime = activation.registration('providers', 'cliproxyapi')?.managedRuntime;
    if (!runtime) throw new Error('missing managed runtime');
    const snapshot = { id: 'cliproxyapi-managed', state: 'healthy' as const, mode: 'spawn' as const,
      baseUrl: 'http://127.0.0.1:45123', startedAtMs: 1, lastHealthyAtMs: 2, diagnostics: [], diagnosticsTruncated: false };
    let launch: ManagedServiceSpec | undefined;
    const service = {
      snapshot: () => snapshot, waitUntilHealthy: async () => snapshot, observe: () => ({ dispose() {} }),
      request: async () => createCLIProxyAPIManagedHealthResponse(launch),
      stop: async () => ({ status: 'stopped' as const }), dispose: async () => undefined,
    };
    const declared = await runtime.start({ reason: 'explicitStartLocal', endpointTemplateIds: [endpointTemplateId] }, {
      signal: new AbortController().signal,
      connectedAccounts: {
        getBinding: async () => null,
      },
      managedServices: {
          ...createUnavailableManagedServices(), supervise: async (spec: ManagedServiceSpec) => { launch = spec; return service; } },
      // Only managed-process and Connected Account service boundaries are
      // supplied; the public plugin start and endpoint declaration stay real.
    } as never);
    await activation.dispose();
    const endpoint = declared.endpoints.find(candidate => candidate.endpointTemplateId === endpointTemplateId);
    if (!endpoint || endpoint.endpoint.kind !== 'servicePath') throw new Error('missing service endpoint');
    const declaredPath = endpoint.endpoint.path;
    const application = { ...row.application, endpointTemplateId, protocol };
    const selectedAuthority = { ...authority, payload: { ...authority.payload, application } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, {
      status: 204, headers: { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: declaredPath },
    })));
    const opened = await openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: { resourceId: 'resource-1', brokerMachineId: 'broker-1', expectedResourceRevision: 3,
        agentTargetKey: row.selection.agentTargetKey, modelId: row.descriptor.id, descriptor: row.descriptor,
        sourceFacts: { ...row.sourceFacts, endpoint: { ...row.sourceFacts.endpoint, id: endpointTemplateId, protocol },
          compatibilityOverrides: row.sourceFacts.compatibilityOverrides!.map(override => ({ ...override, protocol })) },
        application, sourceRevision: row.sourceRevision },
      lease: lease({ v: 1, adapterVersion: 1, prepare: prepareSpawnEnv, materialize: materializeBrokerAuthoritySpawnEnv }, protocol),
      materializationBaseDir: '/tmp/happier-team-endpoint-test', signal: new AbortController().signal,
      openBroker: async () => ({ ok: true, authority: selectedAuthority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64),
          endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'relay',
        retire: async () => undefined, close: async () => undefined }),
    });
    try {
      let policyResult: ReturnType<typeof evaluateTeamCredentialRequestPolicyV1> | undefined;
      let requestedPath = '';
      const sdkFetch: typeof fetch = async (url, init) => {
        requestedPath = new URL(url instanceof Request ? url.url : String(url)).pathname;
        policyResult = evaluateTeamCredentialRequestPolicyV1({ policy: {
          allowedProtocolKinds: null, allowedModelIds: null, reasoningEffort: null,
        }, request: { pathAndQuery: requestedPath, method: 'POST',
          body: new TextEncoder().encode(String(init?.body)) }, resolveCanonicalModelId: model => model });
        return Response.json({ id: 'result', type: 'message', role: 'assistant', content: [], model: row.descriptor.id,
          object: 'response', output: [], choices: [], usage: { input_tokens: 0, output_tokens: 0 } });
      };
      const baseURL = opened.providerBinding.upstream.normalizedUrl;
      if (protocol === 'anthropic') await new Anthropic({ apiKey: 'test', baseURL, fetch: sdkFetch, maxRetries: 0 })
        .messages.create({ model: row.descriptor.id, max_tokens: 1, messages: [] });
      else {
        const sdk = new OpenAI({ apiKey: 'test', baseURL, fetch: sdkFetch, maxRetries: 0 });
        if (protocol === 'openai-responses') await sdk.responses.create({ model: row.descriptor.id, input: 'test' });
        else await sdk.chat.completions.create({ model: row.descriptor.id, messages: [] });
      }
      expect(requestedPath).toBe(expectedPath);
      expect(policyResult).toMatchObject({ ok: true });
    } finally { await opened.cleanup(); }
  });
  it.each([
    {
      name: 'Session',
      consumerInput: { sessionId: 'session-1' },
      expectedConsumer: { kind: 'session' as const, sessionId: 'session-1' },
    },
    {
      name: 'detached Execution Run',
      consumerInput: { consumer: { kind: 'execution_run' as const, executionRunId: 'run-1' } },
      expectedConsumer: { kind: 'execution_run' as const, executionRunId: 'run-1' },
    },
  ])('opens experimental direct material without confirmation for a $name through the canonical Agent Provider materializer', async ({
    consumerInput,
    expectedConsumer,
  }) => {
    const directRow = {
      ...row,
      sourceFacts: { ...row.sourceFacts, compatibilityOverrides: row.sourceFacts.compatibilityOverrides!.map(override => ({
        ...override, status: 'experimental' as const,
      })) },
      selection: { ...row.selection, deliveryMode: 'direct' as const },
      direct: {
        sourceMemberKey: 'provider:source-member',
        sourceVersion: 'source-version:7',
      },
    };
    const openBroker = vi.fn();
    const openTunnel = vi.fn();
    let disclosed = false;
    const readCatalog = vi.fn(async () => disclosed ? [] : [directRow]);
    const openTeamDirect = vi.fn<SessionTeamCredentialDirectOpen>(async () => {
      disclosed = true;
      return {
      ok: true as const,
      payload: TeamCredentialDirectMaterialPayloadV1Schema.parse({
        v: 1 as const,
        domain: 'happier.team-credential-direct-material' as const,
        homeServerIdentityId: 'home-1', teamId: 'team-1', resourceId: 'resource-1',
        resourceRevision: 3,
        recipientAccountId: 'recipient-1',
        sourceMember: {
          kind: 'provider_credential_slot' as const,
          connectionId: 'pc_source', credentialSlotId: 'apiKey',
        },
        sourceVersion: 'source-version:7',
        material: {
        kind: 'provider_api_key' as const,
        value: 'recipient-secret',
        runtimeBinding: {
          provider: { identity: row.application.implementationIdentity, definitionRevision: 1 },
          endpoint: {
            endpointTemplateId: 'responses',
            normalizedUrl: 'https://api.example.test/v1',
            protocol: 'openai-responses' as const,
            publicHeaders: { 'X-Public-Route': 'stable' },
          },
          credentialTransport: {
            id: 'api-key', protocols: ['openai-responses' as const], uses: ['runtime' as const],
            destination: { kind: 'httpHeader' as const, name: 'Authorization', format: 'bearer' as const },
          },
        },
        },
      }),
      };
    });
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };

    const opened = await openSessionTeamCredentialProviderBinding({
      ...consumerInput, machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'direct' },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-direct-test',
      signal: new AbortController().signal,
      readCatalog, openBroker: openBroker as never, openTunnel: openTunnel as never,
      openTeamDirect,
    });

    expect(openTeamDirect).toHaveBeenCalledWith({
      teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 3,
      sourceMemberKey: 'provider:source-member', expectedSourceVersion: 'source-version:7',
      consumer: expectedConsumer,
    });
    expect(openBroker).not.toHaveBeenCalled();
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(openTunnel).not.toHaveBeenCalled();
    expect(adapter.materialize).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({ kind: 'apiKey', value: 'recipient-secret' }),
      binding: expect.objectContaining({ endpoint: expect.objectContaining({
        normalizedUrl: 'https://api.example.test/v1',
      }) }),
    }));
    expect(adapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      bindingKey: 'team_resource:resource-1:revision:3:route:direct',
    }));
    expect(opened?.providerBinding.upstream.normalizedUrl).toBe('https://api.example.test/v1');
    expect(opened?.additionalRedactionValues).toContain('recipient-secret');
    await opened?.cleanup();
  });

  it.each([
    ['temporarily_unavailable', 'provider_endpoint_unavailable'],
    ['source_changed', 'provider_authorization_changed'],
    ['access_removed', 'provider_account_grant_stale'],
    ['unsupported_direct_source', 'provider_credential_transport_unavailable'],
    ['resource_corrupt', 'provider_materialization_failed'],
  ] as const)('surfaces Team direct %s through the stable Provider error code %s', async (reason, code) => {
    const directRow = {
      ...row,
      selection: { ...row.selection, deliveryMode: 'direct' as const },
      direct: {
        sourceMemberKey: 'provider:source-member',
        sourceVersion: 'source-version:7',
      },
    };
    const materialize = vi.fn();

    await expect(openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'direct' },
      lease: lease({
        v: 1, adapterVersion: 1,
        prepare: vi.fn(prepareSpawnEnv),
        materialize,
      }),
      materializationBaseDir: '/tmp/happier-team-direct-test',
      signal: new AbortController().signal,
      readCatalog: async () => [directRow],
      openTeamDirect: async () => ({ ok: false, reason }),
    })).rejects.toMatchObject({ code });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('preserves a Team authentication operation error through the Session Provider binding', async () => {
    const directRow = {
      ...row,
      selection: { ...row.selection, deliveryMode: 'direct' as const },
      direct: {
        sourceMemberKey: 'provider:source-member',
        sourceVersion: 'source-version:7',
      },
    };

    await expect(openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'direct' },
      lease: lease({
        v: 1, adapterVersion: 1,
        prepare: vi.fn(prepareSpawnEnv),
        materialize: vi.fn(materializeEmptySpawnEnv),
      }),
      materializationBaseDir: '/tmp/happier-team-direct-test',
      signal: new AbortController().signal,
      readCatalog: async () => [directRow],
      openTeamDirect: async () => ({
        ok: false,
        operationError: { error: 'team_authentication_policy_unavailable' },
      }),
    })).rejects.toMatchObject({
      name: 'TeamCredentialDirectMaterialOperationError',
      code: 'team_authentication_policy_unavailable',
    });
  });

  it.each([
    { name: 'no consumer identity', sessionId: undefined, consumer: undefined },
    {
      name: 'conflicting Session identities',
      sessionId: 'session-1',
      consumer: { kind: 'session' as const, sessionId: 'session-2' },
    },
  ])('rejects $name before catalog or direct-material access', async ({ sessionId, consumer }) => {
    const readCatalog = vi.fn(async () => []);
    const openTeamDirect = vi.fn();

    await expect(openSessionTeamCredentialProviderBinding({
      ...(sessionId ? { sessionId } : {}),
      ...(consumer ? { consumer } : {}),
      machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'direct' },
      lease: lease({
        v: 1, adapterVersion: 1,
        prepare: vi.fn(prepareSpawnEnv),
        materialize: vi.fn(materializeEmptySpawnEnv),
      }),
      materializationBaseDir: '/tmp/happier-team-direct-test',
      signal: new AbortController().signal,
      readCatalog,
      openTeamDirect,
    })).rejects.toThrow('team_credential_provider_selection_not_current');
    expect(readCatalog).not.toHaveBeenCalled();
    expect(openTeamDirect).not.toHaveBeenCalled();
  });

  it('does not silently fail over a selected direct row when current material is absent', async () => {
    const openBroker = vi.fn();
    await expect(openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'direct' },
      lease: lease({
        v: 1, adapterVersion: 1,
        prepare: vi.fn(prepareSpawnEnv),
        materialize: vi.fn(materializeEmptySpawnEnv),
      }),
      materializationBaseDir: '/tmp/happier-team-direct-test', signal: new AbortController().signal,
      readCatalog: async () => [{ ...row, selection: { ...row.selection, deliveryMode: 'direct' } }],
      openBroker: openBroker as never,
    })).rejects.toThrow('team_credential_direct_material_not_current');
    expect(openBroker).not.toHaveBeenCalled();
  });

  it('opens one exact broker/tunnel from one admitted catalog and closes Session custody once', async () => {
    const closeOrder: string[] = [];
    const retire = vi.fn(async () => { closeOrder.push('retire'); });
    const close = vi.fn(async () => undefined);
    const brokerOpened = { ok: true as const, authority,
      target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } };
    const openBroker = vi.fn(async () => brokerOpened);
    const openTunnel = vi.fn(async () => ({
      localPort: 43123,
      localCapability: 'c'.repeat(64),
      observedPath: 'relay' as const,
      retire,
      close: vi.fn(async () => { closeOrder.push('close'); await close(); }),
    }));
    const directTwin = {
      ...row,
      selection: { ...row.selection, deliveryMode: 'direct' as const },
      direct: { sourceMemberKey: 'provider:source-member', sourceVersion: 'source-version:7' },
    };
    const readCatalog = vi.fn(async () => [directTwin, row]);
    const signal = new AbortController().signal;
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };

    const opened = await openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'brokered' },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal, readCatalog, openBroker, openTunnel,
    });

    expect(openBroker).toHaveBeenCalledOnce();
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(openTunnel).toHaveBeenCalledWith(expect.objectContaining({
      brokerOpen: brokerOpened,
      refreshBrokerOpen: expect.any(Function),
      signal,
    }));
    expect(adapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      bindingKey: 'team_resource:resource-1:revision:3:route:brokered',
    }));
    expect(opened?.providerBinding).toMatchObject({
      source: { kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 },
      upstream: { normalizedUrl: 'http://127.0.0.1:43123/v1' },
    });
    // The Agent receives only its loopback endpoint and the tunnel's local
    // capability through its raw credential header. Home-signed authority stays
    // with the trusted transport owner and never enters Agent configuration.
    expect(adapter.materialize).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ endpoint: expect.objectContaining({ publicHeaders: {} }) }),
      credential: { kind: 'apiKey', transport: expect.objectContaining({
        destination: { kind: 'httpHeader', name: 'x-happier-machine-local-capability', format: 'raw' },
      }), value: 'c'.repeat(64) },
    }));
    expect(JSON.stringify(vi.mocked(adapter.materialize).mock.calls)).not.toContain(authority.signature.valueBase64Url);
    // The carrier capability is a credential, never a public-header literal,
    // and must still be redacted like a direct source credential.
    expect(opened?.additionalRedactionValues).toContain('c'.repeat(64));
    await opened?.cleanup();
    await opened?.cleanup();
    expect(retire).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(closeOrder).toEqual(['retire', 'close']);
  });

  it('opens a fresh binding at the revision the catalog owner reports now, not the stale selection revision', async () => {
    // The Session selected revision 3; a policy edit since advanced the
    // resource to 8. The revision is a mutation precondition of the selection,
    // not identity (`04-private-iroh-broker-transport.md:272`, 10.11 A2(4)), so
    // the open re-reads it through the catalog owner and the Home rechecks it.
    const current = { ...row, selection: { ...row.selection, expectedResourceRevision: 8 } };
    const readCatalog = vi.fn(async () => [current]);
    const openBroker = vi.fn(async () => ({ ok: true as const, authority,
      target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }));
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };

    const opened = await openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'brokered' },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal, readCatalog, openBroker,
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'direct', retire: async () => undefined, close: async () => undefined }),
    });

    expect(openBroker).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'resource-1',
      expectedResourceRevision: 8,
    }), expect.anything());
    expect(opened?.providerBinding.source).toEqual({ kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 8 });
    await opened?.cleanup();
  });

  it('does not revalidate a selected brokered binding against its available direct twin', async () => {
    const directTwin = {
      ...row,
      selection: { ...row.selection, deliveryMode: 'direct' as const },
      direct: { sourceMemberKey: 'provider:source-member', sourceVersion: 'source-version:7' },
    };
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };
    const readCatalog = vi.fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([directTwin]);

    const opened = await openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'brokered' },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal, readCatalog,
      openBroker: async () => ({ ok: true, authority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'direct', retire: async () => undefined, close: async () => undefined }),
    });
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(adapter.materialize).toHaveBeenCalledOnce();
    expect(opened?.providerBinding.source).toMatchObject({ resourceId: row.selection.resourceId });
    await opened?.cleanup();
  });

  it('retains the native transport when the target retirement acknowledgement is lost, so a retry can still reach it', async () => {
    const order: string[] = [];
    let retireAttempt = 0;
    const retire = vi.fn(async () => {
      retireAttempt += 1;
      order.push('retire-attempt');
      if (retireAttempt === 1) throw new Error('lost close acknowledgement');
    });
    const close = vi.fn(async () => { order.push('transport-close'); });
    const brokerOpened = {
      ok: true as const,
      authority,
      target: {
        custodianAccountId: 'account-2',
        brokerMachineId: 'broker-1',
        endpointId: 'b'.repeat(64),
        endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) },
      },
    };
    const adapter: ProviderAdapter = {
      v: 1,
      adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };
    const opened = await openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1',
      machineId: 'worker-1',
      agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter),
      materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker: async () => brokerOpened,
      openTunnel: async () => ({
        localPort: 43123,
        localCapability: 'c'.repeat(64),
        observedPath: 'relay',
        retire,
        close,
      }),
    });

    // The retirement DELETE travels over this transport, so closing it on a
    // failed retirement would destroy the only way to release the target's
    // operation. The failure is reported and the transport survives for the
    // retry that acknowledges it.
    await expect(opened.cleanup()).rejects.toThrow('lost close acknowledgement');
    expect(order).toEqual(['retire-attempt']);
    expect(close).not.toHaveBeenCalled();
    await expect(opened.cleanup()).resolves.toBeUndefined();
    expect(order).toEqual(['retire-attempt', 'retire-attempt', 'transport-close']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('refuses a withdrawn catalog selection at the next open before acquiring the carrier or materializing the Agent', async () => {
    const close = vi.fn(async () => undefined);
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeNullBrokerAuthoritySpawnEnv),
    };
    const readCatalog = vi.fn(async () => []);
    const openTunnel = vi.fn(async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'direct' as const,
      retire: async () => undefined, close }));
    await expect(openSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'brokered' },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal, readCatalog,
      openBroker: async () => ({ ok: true, authority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel,
    })).rejects.toThrow('team_credential_provider_selection_not_current');
    expect(adapter.materialize).not.toHaveBeenCalled();
    expect(openTunnel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['missing declaration', 'non-204', 'non-204 unknown reason', 'cancelled'] as const)(
    'does not publish Team custody when endpoint discovery is %s', async (failure) => {
      const diagnostic = vi.spyOn(logger, 'warnLocalFile');
      onTestFinished(() => diagnostic.mockRestore());
      const controller = new AbortController();
      const close = vi.fn(async () => undefined);
      const retire = vi.fn(async () => { throw new Error('retirement unavailable'); });
      const adapter: ProviderAdapter = {
        v: 1, adapterVersion: 1, prepare: prepareSpawnEnv,
        materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
      };
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
        if (failure === 'cancelled') controller.abort(new Error('cancelled-during-endpoint-discovery'));
        return new Response(null, { status: failure.startsWith('non-204') ? 403 : 204,
          headers: failure === 'missing declaration' ? {} : { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1',
            ...(failure.startsWith('non-204') ? { [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]:
              failure === 'non-204' ? 'resource_unavailable' : 'private-unknown-reason' } : {}) } });
      }));
      const refused = await openSessionTeamCredentialProviderBinding({
        sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
        agentTargetKey: row.selection.agentTargetKey, modelId: row.selection.modelId,
        binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 3, deliveryMode: 'brokered' },
        lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test', signal: controller.signal,
        // Home catalog and the tunnel HTTP transport are external boundaries.
        readCatalog: async () => [row],
        openBroker: async () => ({ ok: true, authority,
          target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1,
            endpoint: { endpointId: 'b'.repeat(64) } } }),
        openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'direct', retire, close }),
      }).then(() => null, (error: unknown) => error);
      if (failure === 'missing declaration' || failure.startsWith('non-204')) {
        expect(refused).toBeInstanceOf(SessionTeamCredentialLaunchUnavailableError);
        const code = failure === 'missing declaration' ? 'provider_endpoint_unavailable'
          : failure === 'non-204' ? 'resource_unavailable' : 'broker_unavailable';
        expect(refused).toMatchObject({ code });
        if (failure.startsWith('non-204')) {
          const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refused });
          expect(issue).toMatchObject({ source: 'team_credential', code });
          expect(JSON.stringify({ issue, refused })).not.toContain('private-unknown-reason');
        }
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), {
          httpStatus: failure.startsWith('non-204') ? 403 : 204,
          hasEndpointPath: failure !== 'missing declaration',
          brokerReasonCode: failure === 'non-204' ? 'resource_unavailable' : null,
        });
      } else {
        expect(refused).toBeInstanceOf(Error);
        expect(refused).toHaveProperty('message', 'cancelled-during-endpoint-discovery');
      }
      expect(adapter.materialize).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(['refresh before dial', 'refresh socket close', 'refresh HTTP refusal', 'accepted refresh socket close', 'HTTP refusal'] as const)(
    'preserves the discovery refusal through the real carrier: %s', async failure => {
      const diagnostic = vi.spyOn(logger, 'warnLocalFile');
      onTestFinished(() => diagnostic.mockRestore());
      const readFailureDiagnostic = vi.fn(async () => ({ closingSide: 'initiator' as const, closingStage: 'stream_decision' as const }));
      const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
      const payload = { ...authority.payload, issuedAt: 100, expiresAt: 10_000 };
      const signed = { payload, signature: { alg: 'Ed25519' as const, keyId: 'home',
        valueBase64Url: Buffer.from(tweetnacl.sign.detached(
          Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)), key.secretKey,
        )).toString('base64url') } };
      const opened = { ok: true as const, authority: signed,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64),
          endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } };
      let transport: Parameters<DaemonMachineIrohRuntime['openHttpTunnel']>[0] | undefined;
      let homeReads = 0;
      let nativeOpens = 0;
      let endpointReads = 0;
      const close = vi.fn(async () => undefined);
      // Native HTTP forwarding is the transport boundary. Keep signing,
      // verification, refresh, discovery and the Team consumer real.
      const listener = createServer(async (request, response) => {
        endpointReads++;
        try {
          await transport?.handshakeProvider?.();
          if (failure === 'refresh socket close' || failure === 'refresh HTTP refusal') await transport?.handshakeProvider?.();
          if (failure === 'HTTP refusal') {
            writeProviderBrokerApplicationFailure({
              header: (name, value) => response.setHeader(name, value),
              code: status => ({ send: body => response.writeHead(status).end(JSON.stringify(body)) }),
            }, { ok: false, reasonCode: 'resource_unavailable' }, 'resource-1');
            return;
          }
        } catch (error) {
          // Current native forwards the real carrier refusal body with fixed
          // HTTP framing; older native closes the socket instead.
          if (failure === 'refresh HTTP refusal' && error instanceof MachineCarrierError && error.httpRefusal) {
            response.writeHead(403, { 'content-type': 'application/json' }).end(error.httpRefusal.responseBody);
            return;
          }
        }
        request.socket.destroy();
      });
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      onTestFinished(() => new Promise<void>(resolve => listener.close(() => resolve())));
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Missing native HTTP listener');
      const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({
        accountId: 'account-1', localMachineId: 'worker-1', nowMs: () => 200,
        resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }],
        runtime: { endpoint: { endpointId: 'a'.repeat(64) }, openHttpTunnel: async input => {
          nativeOpens++;
          transport = input;
          return { localPort: address.port, localCapability: 'c'.repeat(64), remoteEndpointId: 'b'.repeat(64),
            observedPath: 'direct', readFailureDiagnostic, close };
        } },
        fetchImpl: async () => new Response(null, { status: 204 }),
      });
      const adapter: ProviderAdapter = { v: 1, adapterVersion: 1, prepare: prepareSpawnEnv,
        materialize: vi.fn(materializeBrokerAuthoritySpawnEnv) };
      // Use real loopback fetch, including its UND_ERR_SOCKET cause.
      vi.unstubAllGlobals();
      const refused = await openExactSessionTeamCredentialProviderBinding({
        sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
        selection: { ...row.selection, descriptor: row.descriptor, application: row.application,
          sourceRevision: row.sourceRevision, sourceFacts: row.sourceFacts, brokerMachineId: 'broker-1' },
        lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-refusal',
        signal: new AbortController().signal,
        openBroker: async () => {
          homeReads++;
          return (failure === 'refresh before dial' && homeReads === 2)
            || ((failure === 'refresh socket close' || failure === 'refresh HTTP refusal') && homeReads === 3)
            ? { ok: false, reasonCode: 'resource_unavailable' } : opened;
        },
        openTunnel,
      }).then(() => null, (error: unknown) => error);
      const code = failure === 'accepted refresh socket close' ? 'provider_endpoint_unavailable' : 'resource_unavailable';
      expect(refused).toBeInstanceOf(SessionTeamCredentialLaunchUnavailableError);
      expect(refused).toMatchObject({ code });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refused }))
        .toMatchObject({ source: failure === 'accepted refresh socket close' ? 'agent_session_error' : 'team_credential', code });
      expect(adapter.materialize).not.toHaveBeenCalled();
      // One initial open and one refresh per stream; refusals cause no repolls.
      expect(homeReads).toBe(failure === 'refresh socket close' || failure === 'refresh HTTP refusal' ? 3 : 2);
      expect(endpointReads).toBe(failure === 'refresh before dial' ? 0 : 1);
      expect(nativeOpens).toBe(failure === 'refresh before dial' ? 0 : 2);
      expect(close).toHaveBeenCalledTimes(failure === 'refresh before dial' ? 0 : 2);
      expect(readFailureDiagnostic).toHaveBeenCalledTimes(failure === 'accepted refresh socket close' ? 1 : 0);
      if (failure === 'accepted refresh socket close') expect(diagnostic).toHaveBeenCalledWith(
        '[ProviderBroker] Endpoint discovery refused', expect.objectContaining({
          discoveryCause: 'socket_closed', refreshOutcome: 'accepted',
          closingSide: 'initiator', closingStage: 'stream_decision',
        }),
      );
    },
  );

  it('renews an established tunnel with its prior signed authority whatever the placement was', async () => {
    const close = vi.fn(async () => undefined);
    // An exact-Machine open: the target's origin is not a runtime renewal
    // policy, so this established tunnel presents the same prior authority a
    // Pool-selected one does.
    const openBroker = vi.fn<ExactOpenBroker>(async () => ({ ok: true as const, authority,
      target: {
        custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64),
        endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) },
      } }));
    const refreshedOpen = vi.fn();
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };

    const opened = await openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker,
      openTunnel: async ({ refreshBrokerOpen }) => {
        refreshedOpen(await refreshBrokerOpen());
        return { localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'relay', retire: async () => undefined, close };
      },
    });

    expect(openBroker).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      modelId: 'gpt-5',
      sourceRevision: 'catalog:3',
      application: row.application,
    }), expect.any(AbortSignal));
    expect(openBroker).toHaveBeenCalledTimes(2);
    expect(openBroker.mock.calls[1]?.[0]).toMatchObject({
      resourceId: 'resource-1',
      refreshAuthority: authority,
    });
    expect(refreshedOpen).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(opened.providerBinding).toMatchObject({
      source: { kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 },
      model: row.descriptor,
    });
    await opened.cleanup();
    expect(close).toHaveBeenCalledOnce();
  });

  it('binds an independently owned Execution Run to its exact broker authority', async () => {
    const close = vi.fn(async () => undefined);
    const runAuthority = {
      ...authority,
      payload: {
        ...authority.payload,
        consumer: { kind: 'execution_run' as const, executionRunId: 'run-1' },
        executionRunOccurrenceId: 'occurrence-1',
      },
    };
    const openBroker = vi.fn(async () => ({ ok: true as const, authority: runAuthority,
      target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }));
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };

    const opened = await openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', consumer: { kind: 'execution_run', executionRunId: 'run-1' },
      machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId, brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey, modelId: row.selection.modelId,
        descriptor: row.descriptor, sourceFacts: row.sourceFacts,
        application: row.application, sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal, openBroker,
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'relay', retire: async () => undefined, close }),
    });

    expect(openBroker).toHaveBeenCalledWith(expect.objectContaining({
      consumer: { kind: 'execution_run', executionRunId: 'run-1' },
    }), expect.any(AbortSignal));
    await opened.cleanup();
    expect(close).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent Session cleanup and retains failed tunnel cleanup for retry', async () => {
    let settleClose!: (error?: Error) => void;
    let closeAttempt = 0;
    const close = vi.fn(async () => {
      closeAttempt += 1;
      if (closeAttempt === 1) {
        await new Promise<void>((resolve, reject) => {
          settleClose = (error) => error ? reject(error) : resolve();
        });
      }
    });
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeBrokerAuthoritySpawnEnv),
    };
    const opened = await openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker: async () => ({ ok: true, authority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'relay', retire: async () => undefined, close }),
    });

    const first = opened.cleanup();
    const concurrent = opened.cleanup();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    settleClose(new Error('native tunnel cleanup failed'));
    await expect(first).rejects.toThrow('native tunnel cleanup failed');
    await expect(concurrent).rejects.toThrow('native tunnel cleanup failed');

    await expect(opened.cleanup()).resolves.toBeUndefined();
    await expect(opened.cleanup()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rejects a broker-open response that substituted the sealed broker Machine before opening a tunnel', async () => {
    const openTunnel = vi.fn();
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeEmptySpawnEnv),
    };

    await expect(openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'sealed-broker',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker: async () => ({ ok: true, authority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'substituted-broker', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel: openTunnel as never,
    })).rejects.toThrow('team_credential_provider_broker_machine_changed');
    expect(openTunnel).not.toHaveBeenCalled();
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['resource', { resourceId: 'substituted-resource' }, 'team_credential_provider_selection_changed'],
    ['source revision', { sourceRevision: 'catalog:substituted' }, 'team_credential_provider_selection_changed'],
    ['Session', { consumer: { kind: 'session' as const, sessionId: 'substituted-session' } }, 'team_credential_provider_broker_open_changed'],
    ['worker Machine', { initiator: { ...authority.payload.initiator, machineId: 'substituted-worker' } }, 'team_credential_provider_broker_open_changed'],
    ['custodian Account', { target: { ...authority.payload.target, custodianAccountId: 'substituted-account' } }, 'team_credential_provider_broker_open_changed'],
    ['broker Endpoint', { target: { ...authority.payload.target, endpointId: 'd'.repeat(64) } }, 'team_credential_provider_broker_open_changed'],
    ['application', { application: { ...row.application, endpointTemplateId: 'substituted-endpoint' } }, 'team_credential_provider_selection_changed'],
  ])('rejects a signed broker-open witness that substituted the exact %s', async (_label, payloadPatch, reason) => {
    const openTunnel = vi.fn();
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeEmptySpawnEnv),
    };

    await expect(openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker: async () => ({
        ok: true,
        authority: { ...authority, payload: { ...authority.payload, ...payloadPatch } },
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } },
      }),
      openTunnel: openTunnel as never,
    })).rejects.toThrow(reason);
    expect(openTunnel).not.toHaveBeenCalled();
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  it('does not dial the exact carrier when cancellation arrives during broker open', async () => {
    const controller = new AbortController();
    const openTunnel = vi.fn();
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeEmptySpawnEnv),
    };

    await expect(openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: controller.signal,
      openBroker: async () => {
        controller.abort(new Error('cancelled-after-broker-open'));
        return { ok: true, authority,
          target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } };
      },
      openTunnel: openTunnel as never,
    })).rejects.toThrow('cancelled-after-broker-open');
    expect(openTunnel).not.toHaveBeenCalled();
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  it('rejects incoherent exact Agent/model selections before broker effects', async () => {
    const openBroker = vi.fn();
    const openTunnel = vi.fn();
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn(materializeEmptySpawnEnv),
    };

    await expect(openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        modelId: row.selection.modelId,
        descriptor: { ...row.descriptor, id: 'different-model' },
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker: openBroker as never,
      openTunnel: openTunnel as never,
    })).rejects.toThrow('team_credential_provider_selection_invalid');
    expect(openBroker).not.toHaveBeenCalled();
    expect(openTunnel).not.toHaveBeenCalled();
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  it('closes the exact carrier when Agent materialization fails', async () => {
    const close = vi.fn(async () => undefined);
    const adapter: ProviderAdapter = {
      v: 1, adapterVersion: 1,
      prepare: vi.fn(prepareSpawnEnv),
      materialize: vi.fn<ProviderAdapter['materialize']>(() => { throw new Error('materialization_failed'); }),
    };

    await expect(openExactSessionTeamCredentialProviderBinding({
      sessionId: 'session-1', machineId: 'worker-1', agentId: 'codex',
      selection: {
        resourceId: row.selection.resourceId,
        brokerMachineId: 'broker-1',
        expectedResourceRevision: row.selection.expectedResourceRevision,
        agentTargetKey: row.selection.agentTargetKey,
        modelId: row.selection.modelId,
        descriptor: row.descriptor,
        sourceFacts: row.sourceFacts,
        application: row.application,
        sourceRevision: row.sourceRevision,
      },
      lease: lease(adapter), materializationBaseDir: '/tmp/happier-team-broker-test',
      signal: new AbortController().signal,
      openBroker: async () => ({ ok: true, authority,
        target: { custodianAccountId: 'account-2', brokerMachineId: 'broker-1', endpointId: 'b'.repeat(64), endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } } }),
      openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'direct', retire: async () => undefined, close }),
    })).rejects.toThrow('Agent provider binding materialization failed');
    expect(close).toHaveBeenCalledOnce();
  });
});
