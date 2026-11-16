import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { connect } from 'node:net';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import tweetnacl from 'tweetnacl';
import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createProviderConnectionBrokerSourceOpen, resolveProviderConnectionBrokerSource,
  materializeProviderConnectionBrokerSource } from './providerConnectionSource';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createProviderConnectionCpxBridge } from './providerConnectionCpxBridge';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { startDaemonProviderBrokerRuntime } from './daemonProviderBrokerRuntime';
import { PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from './providerBrokerPrivateProtocol';
import { deleteProviderConnectionV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { ProviderBrokerOpenResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { openExactSessionTeamCredentialProviderBinding } from './sessionTeamCredentialProviderBinding';
import { resolveTeamCredentialModelCompatibility } from './teamCredentialModelCompatibility';
import { PLUGIN_MANIFEST as CODEX_MANIFEST } from '../../../../../packages/plugins/codex/src/manifest';
import { PLUGIN_MANIFEST as OPENCODE_MANIFEST } from '../../../../../packages/plugins/opencode/src/manifest';
import { PLUGIN_MANIFEST as CLAUDE_MANIFEST } from '../../../../../packages/plugins/claude/src/manifest';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../packages/plugins/codex/src/agent/providerBinding/adapter';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema,
  ProviderContributionV1Schema, ProviderSettingsV1Schema, formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1, splitProviderSettingsV1,
} from '@happier-dev/protocol';
import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { resolveTeamCredentialResourceSourceCatalogs, resolveTeamCredentialResourceTestCandidate } from './resourceTestCandidate';
import { CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/cloudflare-ai-gateway/src/provider/contribution';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/cliproxyapi/src/provider/contribution';
import { resolveTeamCredentialExternalRequestPolicy } from './externalRequestPolicy';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

const connectionId = ProviderConnectionIdSchema.parse('pc_cloudflare_team');
const contributionKey = 'happier.provider.cloudflare-ai-gateway/cloudflare-ai-gateway';
const baseUrl = 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai';
const machineId = 'custodian-machine';
const agentTargetKey = 'agent:happier.agent.codex/codex';
const token = 'cf-u3-synthetic-custodian-token';
const application = { agentTargetKey,
  implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
  endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const };
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** Already-admitted DTOs cross both real Home JSON transports in this fixture. */
function throughJsonTransport<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function sourceFixture(sourceMachineId = machineId, encrypted = false, registerAgent: boolean | 'two' = true,
  sourceProtocol: 'openai-responses' | 'openai-chat' | 'anthropic' = 'openai-responses') {
  const machineId = sourceMachineId;
  const sourceUrl = sourceProtocol === 'anthropic' ? 'https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic'
    : sourceProtocol === 'openai-chat' ? 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' : baseUrl;
  const sourceEndpointId = sourceProtocol === 'anthropic' ? 'cloudflare-anthropic'
    : sourceProtocol === 'openai-chat' ? 'cloudflare-chat' : 'cloudflare-responses';
  const directory = await mkdtemp(join(tmpdir(), 'happier-cloudflare-team-'));
  paths.push(directory);
  const definitions = [
    ['happier.provider.cloudflare-ai-gateway', CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION],
    ['happier.provider.cliproxyapi', CLIPROXYAPI_PROVIDER_CONTRIBUTION],
  ] as const;
  const registry: ProviderContributionRegistryView = {
    providersByContributionKey: new Map(definitions.map(([pluginId, raw]) => {
      const definition = ProviderContributionV1Schema.parse(raw);
      return [`${pluginId}/${definition.id}`, { pluginId, identity: { pluginId, localId: definition.id },
        definition, provenance: 'first_party' as const, source: { kind: 'bundled' as const } }];
    })),
    providerActivationOccurrenceIdsByPluginId: new Map([['happier.provider.cloudflare-ai-gateway', 'cloudflare-occurrence']]),
  };
  const dnsEvidenceByEndpointUrl = new Map([[sourceUrl, ['1.1.1.1']]]);
  let settings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
    v: 1, id: connectionId, source: { kind: 'contribution', contributionKey },
    role: 'default', displayName: 'Cloudflare', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
    endpointOverrides: [{ endpointTemplateId: sourceEndpointId, baseUrl: sourceUrl,
      ...(sourceProtocol === 'openai-chat' ? { publicHeaders: { 'cf-aig-gateway-id': 'gateway' } } : {}) }],
  }], manualModelsByConnectionId: { [connectionId]: [{ id: sourceProtocol === 'anthropic' ? 'claude-sonnet'
    : sourceProtocol === 'openai-chat' ? 'workers/model' : 'gpt-5.1', addedAt: 1 }] },
  secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: formatSharedSavedSecretRefV1('cloudflare-secret'),
    ...(sourceProtocol === 'anthropic' ? { anthropicApiKey: formatSharedSavedSecretRefV1('cloudflare-secret') } : {}) }, byMachineId: {} } } });
  const resolve = () => resolveProviderConnectionForMachine({ connectionId, machineId,
    providerSettings: settings, registry, dnsEvidenceByEndpointUrl });
  const initial = resolve();
  if (initial.status !== 'resolved') throw new Error('Expected resolved Cloudflare connection');
  settings = ProviderSettingsV1Schema.parse({ ...settings, accountGrants: [{ v: 1, connectionId,
    connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint, confirmedAt: 1 }] });
  const source = { v: 1 as const, kind: 'provider_connection' as const, connectionId,
    connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint, credentialSlotId: 'apiKey' };
  let secretPresent = true;
  let keyAvailable = true;
  const resourceDataKey = encrypted ? new Uint8Array(32).fill(7) : undefined;
  const secretContent = { v: 1 as const, name: 'Cloudflare key', kind: 'apiKey' as const, value: token };
  const storedContent = resourceDataKey
    ? sealSavedSecretResourceStoredContentV1({ resourceId: 'cloudflare-secret', mode: 'e2ee', resourceDataKey,
      randomBytes: length => new Uint8Array(length).fill(19), content: secretContent })
    : sealSavedSecretResourceStoredContentV1({ resourceId: 'cloudflare-secret', mode: 'plain', content: secretContent });
  const buildSnapshot = (): ActiveAccountSettingsSnapshot => ({ source: 'cache', scopeKey: 'cloudflare-custodian',
    settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
    savedSecretCatalogState: 'ready', savedSecretResources: secretPresent ? [{ resourceId: 'cloudflare-secret',
      ownerAccountId: 'custodian', displayName: 'Cloudflare key', kind: 'apiKey', encryptionMode: encrypted ? 'e2ee' : 'plain', revision: 1,
      ...(resourceDataKey && keyAvailable ? { resourceDataKey } : {}), storedContent, materialStatus: 'ready' }] : [],
  });
  let currentSnapshot = buildSnapshot();
  const snapshot = () => currentSnapshot;
  const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir: directory, machineId });
  let probeRequests = 0;
  const client = createProviderProbeHttpClient({ transport: async () => {
    probeRequests += 1;
    throw new Error('Manual Cloudflare catalog must not contact a vendor');
  } });
  // Loaded-plugin registry is a fixture boundary; source discovery and exact selection remain real.
  let leaseReleases = 0;
  let heldLease: Promise<PluginRuntimeRegistryLease> | undefined;
  const lease: PluginRuntimeRegistryLease = { source: 'active', durableRevision: 1, release: async () => { leaseReleases++; },
    registry: { generation: 1, contributes: { providersByContributionKey: registry.providersByContributionKey,
      agentDefinitionsById: new Map([
        ...(registerAgent === 'two' ? [['claude', { definition: CLAUDE_MANIFEST.contributes.agents[0], identity: { pluginId: CLAUDE_MANIFEST.id, localId: 'claude' } }]]
          : registerAgent ? [['codex', { definition: CODEX_MANIFEST.contributes.agents[0], identity: { pluginId: CODEX_MANIFEST.id, localId: 'codex' } }]] : []),
        ...(registerAgent === 'two' ? [['opencode', { definition: OPENCODE_MANIFEST.contributes.agents[0], identity: { pluginId: OPENCODE_MANIFEST.id, localId: 'opencode' } }]] : []),
      ]) },
      agentRuntimesByAgentId: new Map(registerAgent === true ? [['codex', { pluginId: CODEX_MANIFEST.id,
        providerBinding: CODEX_PROVIDER_BINDING_ADAPTER_V1, isCurrent: () => true,
        retirementSignal: new AbortController().signal }]] : []),
      readPluginOccurrenceId: (pluginId: string) => registry.providerActivationOccurrenceIdsByPluginId?.get(pluginId) ?? null,
    } as unknown as ResolvedExecutablePluginRuntimeRegistry };
  const models = createRuntimeProviderModelManagementServices({ machineId, registry, runtimeStore, client,
    getAccountSettingsSnapshot: snapshot, featureGate: { isEnabled: () => true },
    resolveAddresses: async () => ['1.1.1.1'], acquireRuntimeLease: async () => heldLease ?? lease,
    modelSettingsMutation: async () => { throw new Error('Source read must not mutate settings'); } });
  const projectModels = models.projectModels;
  const catalog = async (teamId = 'team', resourceId = 'resource') => (await resolveTeamCredentialResourceSourceCatalogs({ machineId, teamId, resourceId,
    expectedResourceRevision: 1, source, application, readSourceModelCatalogs: models.readSourceModelCatalogs }))[0] ?? null;
  return { registry, source, snapshot, resolve, catalog, projectModels, dnsEvidenceByEndpointUrl, models, lease, directory,
    probeRequests: () => probeRequests,
    leaseReleases: () => leaseReleases,
    holdRuntimeLease() {
      let release!: (lease: PluginRuntimeRegistryLease) => void;
      heldLease = new Promise(resolve => { release = resolve; });
      return () => { heldLease = undefined; release(lease); };
    },
    update(change: (current: ProviderSettingsV1) => ProviderSettingsV1) { settings = change(settings); currentSnapshot = buildSnapshot(); },
    rotateSecret(value: string) {
      currentSnapshot = { ...currentSnapshot, savedSecretResources: currentSnapshot.savedSecretResources?.map(resource => ({
        ...resource, revision: resource.revision + 1,
        storedContent: resourceDataKey
          ? sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'e2ee', resourceDataKey,
            randomBytes: length => new Uint8Array(length).fill(23), content: { ...secretContent, value } })
          : sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', content: { ...secretContent, value } }),
      })) };
    },
    revokeSecret() { secretPresent = false; currentSnapshot = buildSnapshot(); },
    withdrawDecryptionKey() { keyAvailable = false; currentSnapshot = buildSnapshot(); } };
}

describe('Cloudflare Provider source shared through the existing Team broker', () => {
  it('cancels a source read during registry acquisition and releases its late lease', async () => {
    const fixture = await sourceFixture(machineId, false, false);
    const releaseLease = fixture.holdRuntimeLease();
    const abort = new AbortController();
    let settled = false;
    const read = fixture.models.readSourceModelCatalogs({ machineId, source: fixture.source }, abort.signal)
      .then(value => { settled = true; return { kind: 'success' as const, value }; },
        error => { settled = true; return { kind: 'failure' as const, error: error as unknown }; });
    try {
      abort.abort();
      // Cancellation settles on the signal, not on the unrelated loader's eventual completion.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(await read).toMatchObject({ kind: 'failure', error: { reason: 'cancelled' } });
      expect(fixture.leaseReleases()).toBe(0);
    } finally {
      releaseLease();
      await read;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(fixture.leaseReleases()).toBe(1);
  });
  it('admits source and worker-labelled applications from the same source without a broker Agent', async () => {
    const fixture = await sourceFixture(machineId, false, false);
    const observed = await fixture.models.readSourceModelCatalogs({ machineId, source: fixture.source });
    const labelled = await fixture.models.readSourceModelCatalogs({ machineId, source: fixture.source, application });
    if (observed.status !== 'success' || labelled.status !== 'success') throw new Error('Expected current source catalogs');
    expect(observed.catalogs).toHaveLength(1);
    expect(labelled.catalogs).toHaveLength(1);
    expect(labelled.catalogs[0]!.sourceRevision).toBe(observed.catalogs[0]!.sourceRevision);
    expect(labelled.catalogs[0]!.rows.map(row => row.descriptor)).toEqual(observed.catalogs[0]!.rows.map(row => row.descriptor));
    const input = { machineId, teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1, source: fixture.source,
      modelId: 'gpt-5.1', sourceRevision: labelled.catalogs[0]!.sourceRevision, application };
    expect(await fixture.models.resolveTeamCredentialBrokerEligibility(input)).toEqual({ status: 'eligible' });
    expect(await fixture.models.resolveTeamCredentialBrokerEligibility({ ...input, modelId: 'other-model' }))
      .toEqual({ status: 'unavailable', reason: 'model_unavailable' });
    expect(await fixture.models.resolveTeamCredentialBrokerEligibility({ ...input, sourceRevision: 'older-observation' }))
      .toEqual({ status: 'unavailable', reason: 'source_changed' });
    fixture.update(current => ProviderSettingsV1Schema.parse({ ...current, accountGrants: [] }));
    expect(await fixture.models.resolveTeamCredentialBrokerEligibility(input))
      .toEqual({ status: 'unavailable', reason: 'source_unavailable' });
  });
  it('lists and routes one Messages source with two registered Agents and refuses its withdrawal', async () => {
    const fixture = await sourceFixture(machineId, false, 'two', 'anthropic');
    expect(fixture.lease.registry.contributes.agentDefinitionsById.size).toBe(2);
    const binding = { v: 1, kind: 'external_api_key', teamId: 'team', resourceId: 'resource', requestId: 'external-request',
      externalApiKeyId: '550e8400-e29b-41d4-a716-446655440000', operationId: null,
      brokerPlacementFingerprint: 'a'.repeat(64), assignedAccountId: 'recipient', assignedTeamMembershipId: 'membership' } as const;
    const resource = { id: 'resource', teamId: 'team', revision: 1, enabled: true,
      brokerPlacement: { kind: 'machine' as const, machineId }, source: fixture.source, requestPolicy: null };
    let sourceReads = 0;
    const resolve = (request: ManagedServiceRequest) => resolveTeamCredentialExternalRequestPolicy({ machineId, binding, request,
      readResource: async () => resource,
      readSourceModelCatalogs: (request, signal) => { sourceReads += 1; return fixture.models.readSourceModelCatalogs(request, signal); },
    });
    const listed = await resolve({ method: 'GET', pathAndQuery: '/v1/models' });
    expect(listed).toMatchObject({ kind: 'model_catalog', modelCatalog: { models: [{ id: 'claude-sonnet' }] } });
    const request = { method: 'POST', pathAndQuery: '/v1/messages', headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 })) };
    const routed = await resolve(request);
    expect(routed).toMatchObject({ kind: 'application', application: { protocol: 'anthropic' } });
    if (routed?.kind !== 'application') throw new Error('Expected Messages source application');
    expect(routed.application).not.toHaveProperty('agentTargetKey');
    expect(routed.modelCatalog.resolveCanonicalModelId('claude-sonnet')).toBe('claude-sonnet');
    expect(sourceReads).toBe(2);
    fixture.update(current => ProviderSettingsV1Schema.parse({ ...current, accountGrants: [] }));
    await expect(resolve(request)).rejects.toMatchObject({ failure: { reasonCode: 'provider_connection_disabled' } });
    await expect(resolve({ method: 'GET', pathAndQuery: '/v1/models' })).rejects.toMatchObject({
      failure: { reasonCode: 'provider_connection_disabled' },
    });
    expect(fixture.probeRequests()).toBe(0);
  });
  it('uses the route source for resource Test even when the broker has no registered Agent', async () => {
    const fixture = await sourceFixture(machineId, false, false);
    const candidate = await fixture.models.resolveTeamCredentialResourceTestCandidate({ machineId,
      teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1, source: fixture.source });
    expect(candidate).toMatchObject({ status: 'success', application: {
      implementationIdentity: application.implementationIdentity, protocol: 'openai-responses',
    }, request: { route: 'responses' } });
    if (candidate.status !== 'success') throw new Error(candidate.reason);
    expect(candidate.application).not.toHaveProperty('agentTargetKey');
    fixture.update(current => ProviderSettingsV1Schema.parse({ ...current, manualModelsByConnectionId: {
      [connectionId]: [{ id: 'model-z', addedAt: 1 }, { id: 'model-a', addedAt: 1 }],
    } }));
    const ordered = await fixture.models.resolveTeamCredentialResourceTestCandidate({ machineId,
      teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1, source: fixture.source });
    if (ordered.status !== 'success') throw new Error(ordered.reason);
    expect(JSON.parse(Buffer.from(ordered.request.bodyBase64, 'base64').toString('utf8')))
      .toMatchObject({ model: 'model-a', input: 'Reply with OK.', max_output_tokens: 16 });
    expect(fixture.probeRequests()).toBe(0);
  });
  it.each(['anthropic', 'openai-chat'] as const)('builds resource Test from the actual %s source route', async protocol => {
    const fixture = await sourceFixture(machineId, false, false, protocol);
    const candidate = await fixture.models.resolveTeamCredentialResourceTestCandidate({ machineId,
      teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1, source: fixture.source });
    expect(candidate.status).toBe('success');
    if (candidate.status !== 'success') throw new Error(candidate.reason);
    expect(candidate.application.protocol).toBe(protocol);
    const body = JSON.parse(Buffer.from(candidate.request.bodyBase64, 'base64').toString('utf8'));
    if (protocol === 'anthropic') {
      expect(candidate.request).toMatchObject({ route: 'messages', pathAndQuery: '/v1/messages',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } });
      expect(body).toMatchObject({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 });
    } else {
      expect(candidate.request).toMatchObject({ route: 'chat_completions', pathAndQuery: '/v1/chat/completions' });
      expect(body).toMatchObject({ model: 'workers/model', messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 16 });
    }
    expect(fixture.probeRequests()).toBe(0);
  });
  it('distinguishes an empty source from an unavailable exact source and preserves cancellation', async () => {
    const fixture = await sourceFixture(machineId, false, false);
    const request = { machineId, teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1, source: fixture.source,
      refreshPolicy: 'current_only' as const };
    const abort = new AbortController();
    abort.abort(new Error('cancelled source operation'));
    await expect(fixture.models.resolveTeamCredentialResourceTestCandidate(request, abort.signal)).rejects.toThrow('cancelled source operation');
    const wrongSource = { ...fixture.source, connectionSecurityFingerprint: 'connection-security:v1:stale' };
    expect(await fixture.models.resolveTeamCredentialResourceTestCandidate({ ...request, source: wrongSource }))
      .toEqual({ status: 'unavailable', reason: 'source_unavailable' });
    fixture.update(current => ProviderSettingsV1Schema.parse({ ...current, manualModelsByConnectionId: {} }));
    expect(await fixture.models.resolveTeamCredentialResourceTestCandidate(request))
      .toEqual({ status: 'unavailable', reason: 'model_unavailable' });
  });
  it('refuses encrypted source material when its key becomes unavailable without treating it as plain', async () => {
    const fixture = await sourceFixture(machineId, true);
    const snapshot = fixture.snapshot();
    const resolved = resolveProviderConnectionBrokerSource({ source: fixture.source, machineId,
      endpointTemplateId: 'cloudflare-responses', protocol: 'openai-responses', registry: fixture.registry,
      dnsEvidenceByEndpointUrl: fixture.dnsEvidenceByEndpointUrl, accountSettings: snapshot.settings,
      providerSettings: readProviderSettingsForCli(snapshot).settings,
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot) });
    if (!resolved.ok) throw new Error(resolved.error.code);
    const materialize = () => materializeProviderConnectionBrokerSource({ expected: resolved.snapshot,
      registry: fixture.registry, dnsEvidenceByEndpointUrl: fixture.dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: fixture.snapshot });
    const admitted = await materialize();
    if (!admitted.ok) throw new Error(admitted.error.code);
    expect(admitted.lease.credential).toMatchObject({ name: 'cf-aig-authorization', value: `Bearer ${token}` });
    admitted.lease.close();
    fixture.withdrawDecryptionKey();
    expect(fixture.snapshot().savedSecretResources?.[0]?.encryptionMode).toBe('e2ee');
    expect(await materialize()).toMatchObject({ ok: false });
  });

  it('uses the custodian source after real Home admission and refuses withdrawn audience before another process request', async () => {
    const server = '../../../../server/sources/';
    const { createLightSqliteHarness }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
    const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
    const { inTx }: typeof import('../../../../server/sources/storage/inTx') = await import(server + 'storage/inTx');
    const { createPlannedSessionTeamCredentialFixture, TEST_AUTHENTICATION }: typeof import('../../../../server/sources/app/teams/credentials/sessionBinding.testkit') = await import(server + 'app/teams/credentials/sessionBinding.testkit');
    const { writeSessionTeamCredentialBindingsInTx }: typeof import('../../../../server/sources/app/teams/credentials/sessionBinding') = await import(server + 'app/teams/credentials/sessionBinding');
    const { openTeamCredentialProviderBroker, admitTeamCredentialProviderBrokerRequest, authorizeTeamCredentialProviderModelCatalog }: typeof import('../../../../server/sources/app/teams/credentials/providerBrokerAdmission') = await import(server + 'app/teams/credentials/providerBrokerAdmission');
    const { readTeamCredentialBrokerPlacement }: typeof import('../../../../server/sources/app/teams/credentials/brokerPlacementResolver') = await import(server + 'app/teams/credentials/brokerPlacementResolver');
    const { readTeamCredentialSourceBinding }: typeof import('../../../../server/sources/app/teams/credentials/sourceBindingRead') = await import(server + 'app/teams/credentials/sourceBindingRead');
    const { applySessionTurnMutation }: typeof import('../../../../server/sources/app/session/sessionWriteService') = await import(server + 'app/session/sessionWriteService');
    const { createTeamCredentialResourceInTx }: typeof import('../../../../server/sources/app/teams/credentials/resourceCreate') = await import(server + 'app/teams/credentials/resourceCreate');
    const { setTeamCredentialAudienceInTx }: typeof import('../../../../server/sources/app/teams/credentials/resourceAudience') = await import(server + 'app/teams/credentials/resourceAudience');
    const { readTeamOperationAuthenticationFromRequest }: typeof import('../../../../server/sources/app/teams/actorContext') = await import(server + 'app/teams/actorContext');
    const { projectTeamCredentialProviderModels }: typeof import('../../../../server/sources/app/teams/credentials/providerModelProjection') = await import(server + 'app/teams/credentials/providerModelProjection');
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-cloudflare-team-db-', initAuth: true, env: {
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_PROVIDERS__ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
      HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
    } });
    onTestFinished(harness.close);
    const teamAuthentication = readTeamOperationAuthenticationFromRequest({ authAuthority: 'present_user', authTokenAuthenticationEvidence: [] });
    const home = await createPlannedSessionTeamCredentialFixture('personal_allowed');
    await db.machine.update({ where: { id: home.broker.id }, data: { operationProtocolCapabilities: {
      providerBrokerIngress: { protocolVersions: [1] }, irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) },
    } } });
    const worker = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: home.creator.id,
      active: true, kind: 'persistent', metadata: '{}', operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) } } } });
    const fixture = await sourceFixture(home.broker.id);
    const shared = await inTx(tx => createTeamCredentialResourceInTx(tx, { actorAccountId: home.custodian.id,
      authentication: teamAuthentication, resourceId: crypto.randomUUID(), teamId: home.team.id,
      displayName: 'Cloudflare source', source: fixture.source, deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      brokerPlacement: { kind: 'machine', machineId: home.broker.id }, sessionUsePolicy: 'personal_allowed',
      requestPolicy: null, allMembersAllowedRoutes: null, groupGrants: [],
      memberGrants: [{ teamMembershipId: home.creatorMembership.id, allowedRoutes: ['brokered'] }], usageLimits: [],
    }));
    if (!shared.ok) throw new Error(`Team credential create refused: ${shared.error}`);
    const resource = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: shared.resourceId } });
    const session = await db.session.create({ data: { id: crypto.randomUUID(), tag: crypto.randomUUID(),
      accountId: home.creator.id, metadata: '{}', active: true } });
    await db.accessKey.create({ data: { accountId: home.creator.id, machineId: worker.id, sessionId: session.id, data: '{}' } });
    expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { accountId: home.creator.id, sessionId: session.id,
      intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id, teamId: home.team.id,
        expectedResourceRevision: resource.revision, deliveryMode: 'brokered' }], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
    expect(await applySessionTurnMutation({ actorUserId: home.creator.id, authentication: TEST_AUTHENTICATION,
      mutation: { v: 1, sessionId: session.id, mutationId: 'cf-u3-begin', turnId: 'cf-u3-turn', action: 'begin', observedAt: 1 },
    })).toMatchObject({ ok: true, didApply: true });
    const catalog = await fixture.catalog(home.team.id, resource.id);
    if (!catalog) throw new Error('Expected Cloudflare source catalog');
    const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43));
    const brokerPresence = () => ({ state: 'partial' as const, machineIds: new Set([home.broker.id]) });
    const opened = await openTeamCredentialProviderBroker({ actorAccountId: home.creator.id,
      authentication: { ...TEST_AUTHENTICATION, tokenEpoch: 0 },
      request: { v: 1, resourceId: resource.id, expectedResourceRevision: resource.revision,
        modelId: 'gpt-5.1', sourceRevision: catalog.sourceRevision, initiatorMachineId: worker.id,
        consumer: { kind: 'session', sessionId: session.id }, application },
      readCurrentPresence: async () => ({ initiatorPresence: { state: 'partial', machineIds: new Set([worker.id]) }, brokerPresence: brokerPresence() }),
      nowMs: 100, grantId: crypto.randomUUID(), signingKey: { keyId: 'cf-u3-home', secretKey: signingKey.secretKey },
      readProviderProjection: async () => fixture.projectModels({ machineId: home.broker.id, agentTargetKey, application,
        sourceCatalog: true, providerConnection: { connectionId, expectedConnectionSecurityFingerprint: fixture.source.connectionSecurityFingerprint } }),
    });
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error(opened.reasonCode);
    expect(opened.authority.payload.initiator.accountId).toBe(home.creator.id);
    expect(opened.authority.payload.target.custodianAccountId).toBe(home.custodian.id);
    expect(JSON.stringify(opened)).not.toContain(token);

    const processRequests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
    // Only the managed OS process is replaced. It receives the real private CPX
    // envelope over HTTP; the Go final-hop conformance exercises its interpreter.
    let upstreamStatus = 200;
    let rotateOnUnauthorized = false;
    const rotatedToken = 'cf-u3-synthetic-rotated-token';
    const processBoundary = createServer(async (request, response) => {
      if (request.url === '/v1/_happier/provider-broker/endpoint') {
        response.writeHead(204, { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' });
        response.end();
        return;
      }
      processRequests.push({ path: request.url ?? '', headers: request.headers });
      for await (const _chunk of request) { /* drain request at the process boundary */ }
      const status = upstreamStatus;
      if (rotateOnUnauthorized) {
        rotateOnUnauthorized = false;
        fixture.rotateSecret(rotatedToken);
        upstreamStatus = 200;
      }
      response.writeHead(status, { 'content-type': 'text/event-stream', 'x-echo-secret': token });
      response.end('data: {"type":"response.completed","response":{"model":"gpt-5.1","output_text":"done"}}\n\n');
    });
    processBoundary.listen(0, '127.0.0.1');
    await once(processBoundary, 'listening');
    onTestFinished(async () => { processBoundary.closeAllConnections(); await new Promise<void>(resolve => processBoundary.close(() => resolve())); });
    const address = processBoundary.address();
    if (!address || typeof address === 'string') throw new Error('Missing process boundary');
    const processOrigin = `http://127.0.0.1:${address.port}`;
    const recipientCatalog = projectTeamCredentialProviderModels({ resourceId: resource.id, teamId: home.team.id,
      resourceRevision: resource.revision, agentTargetKey, application, allowedModelIds: null, source: fixture.source,
      deliveryMode: 'brokered', response: await fixture.projectModels({ machineId: home.broker.id, agentTargetKey, application,
        sourceCatalog: true, providerConnection: { connectionId, expectedConnectionSecurityFingerprint: fixture.source.connectionSecurityFingerprint } }) });
    expect(recipientCatalog.status).toBe('success');
    expect(recipientCatalog.models).toHaveLength(1);
    expect(JSON.stringify(recipientCatalog)).not.toContain(token);
    const row = throughJsonTransport(recipientCatalog.models[0]!);
    expect({ resourceId: opened.authority.payload.resourceId, sourceRevision: opened.authority.payload.sourceRevision,
      application: opened.authority.payload.application }).toEqual({ resourceId: row.selection.resourceId,
      sourceRevision: row.sourceRevision, application: row.application });
    const recipientSettings = ProviderSettingsV1Schema.parse(DEFAULT_PROVIDER_SETTINGS_V1);
    const { compatibility: recipientCompatibility } = await resolveTeamCredentialModelCompatibility({ model: { ...row, deliveryMode: 'brokered' },
      lease: fixture.lease, agentId: 'codex' });
    expect(recipientCompatibility).toMatchObject({ confirmed: true, result: { status: 'experimental' } });
    // D23: Team experimental compatibility is informational; neither Account confirms it.
    expect(recipientSettings.experimentalBindingConfirmations).toEqual([]);
    expect(readProviderSettingsForCli(fixture.snapshot()).settings.experimentalBindingConfirmations).toEqual([]);
    const openRecipient = () => openExactSessionTeamCredentialProviderBinding({ sessionId: session.id, machineId: worker.id,
      agentId: 'codex', lease: fixture.lease, materializationBaseDir: fixture.directory, signal: new AbortController().signal,
      selection: { ...row.selection, ...row, brokerMachineId: home.broker.id },
      // The Home response crosses a JSON transport in production, too.
      openBroker: async () => throughJsonTransport(ProviderBrokerOpenResponseV1Schema.parse(opened)),
      // Iroh is the genuine transport boundary; the real endpoint reader and
      // native Codex materializer consume its local-only capability.
      openTunnel: async () => ({ localPort: address.port, localCapability: 'c'.repeat(64), observedPath: 'relay',
        close: async () => {}, retire: async () => {} }),
    });
    const recipient = await openRecipient();
    expect(recipient.providerBinding.source).toMatchObject({ kind: 'team_resource', resourceId: resource.id });
    expect(recipient.providerBinding.upstream.normalizedUrl).toBe(processOrigin + '/v1');
    expect(JSON.stringify(recipient)).not.toContain(token);
    expect(JSON.stringify(recipient)).not.toContain('gateway.ai.cloudflare.com');
    await recipient.cleanup();
    const managed = createManagedServicesOwner({
      processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
      dependencies: () => { throw new Error('Unexpected managed process dependency'); }, resolveScope: scope => scope,
    });
    onTestFinished(async () => await managed.dispose());
    const operationIdentity = (request: Parameters<ManagedProviderExplicitStartCustody['retire']>[0]) => ({
      operationId: JSON.stringify(request.operationClaim), pluginId: request.identity.pluginId,
      contributionQualifiedId: `${request.identity.pluginId}/providers/${request.identity.localId}`,
    });
    const custody: ManagedProviderExplicitStartCustody = {
      acquire: async request => {
        const joined = await managed.runManagedProviderExplicitStart({ ...operationIdentity(request),
          occurrenceId: 'cloudflare-process', purposeBindingsEqualityKey: JSON.stringify(request.purposeBindings),
          lifecycleKind: 'providerBroker', signal: request.signal, isCurrent: request.isAuthorizationCurrent,
          revalidateRetainedCurrentness: request.revalidateRetainedCurrentness,
          establish: async () => ({ status: 'running', projection: { access: { endpointUrl: () => processOrigin + '/v1',
        request: async (request: ManagedServiceRequest): Promise<ManagedServiceResponse> => {
          const response = await fetch(processOrigin + request.pathAndQuery, { method: request.method,
            headers: request.headers, body: request.body ? Buffer.from(request.body) : undefined, signal: request.signal });
          return { ok: response.ok, status: response.status, statusText: response.statusText,
            headers: Object.fromEntries(response.headers), body: response.body };
        } }, isCurrent: () => true, cleanup: async () => {} } }),
        });
        return joined.status === 'established' ? joined.value.projection : null;
      },
      retire: async request => await managed.retireManagedProviderExplicitStart(operationIdentity(request)),
      retireExternalApiKey: async () => true,
      revalidateRetainedClaims: async (signal, selector, invalidation) => await managed.revalidateManagedProviderExplicitStarts(
        signal, selector ? operationIdentity(selector) : undefined, invalidation),
      retireAll: async () => await managed.retireManagedProviderExplicitStarts('providerBroker'),
    };
    const bridge = createProviderConnectionCpxBridge({ custody });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({ machineId: home.broker.id, custody,
      selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null,
      openProviderConnectionSource: createProviderConnectionBrokerSourceOpen({ machineId: home.broker.id,
        withRegistry: async read => read(fixture.registry), getAccountSettingsSnapshot: fixture.snapshot,
        collectDnsEvidence: async () => fixture.dnsEvidenceByEndpointUrl,
        resolveExactSelection: fixture.models.resolveTeamCredentialBrokerSourceSelection,
        openCpxProviderConnection: bridge.open,
        readResource: async () => {
          const current = await db.teamCredentialResource.findUnique({ where: { id: resource.id } });
          if (!current) return null;
          const placement = readTeamCredentialBrokerPlacement(current);
          const source = readTeamCredentialSourceBinding(current.sourceBindingJson);
          if (!placement.ok || !source.success) return null;
          return { ...current, source: source.data, brokerPlacement: placement.placement };
        },
      }),
    });
    expect(await fixture.models.resolveTeamCredentialBrokerSourceSelection({ machineId: home.broker.id,
      teamId: home.team.id, resourceId: resource.id, expectedResourceRevision: resource.revision,
      source: fixture.source, application, modelId: 'gpt-5.1', sourceRevision: catalog.sourceRevision,
      signal: new AbortController().signal,
    })).toMatchObject({ endpointTemplateId: 'cloudflare-responses', protocol: 'openai-responses' });
    expect(await sourceOwner.selectSourceMember({ source: fixture.source, application,
      signal: new AbortController().signal })).not.toBeNull();
    let sequence = 0;
    const runtime = await startDaemonProviderBrokerRuntime({ machineId: home.broker.id,
      sourceOwner, nowMs: () => 150, createRequestId: () => `cf-u3-${++sequence}`,
      resolveTrustRoots: () => [{ keyId: 'cf-u3-home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }],
      resolveRequestPolicy: async () => ({ resourceRevision: resource.revision, sourceRevision: catalog.sourceRevision,
        source: fixture.source, application, modelCatalog: catalog, policy: null }),
      admitRequest: async request => admitTeamCredentialProviderBrokerRequest({ authenticatedBrokerAccountId: home.custodian.id,
        request: { v: 1, authority: request.authority, expectedResourceRevision: request.expectedResourceRevision,
          sourceMemberKey: request.sourceMemberKey, requestId: request.requestId, requestFacts: request.requestFacts },
        observedAt: new Date(),
        verifyAuthority: candidate => candidate.signature.valueBase64Url === opened.authority.signature.valueBase64Url }),
      authorizeModelCatalog: async request => authorizeTeamCredentialProviderModelCatalog({ authenticatedBrokerAccountId: home.custodian.id,
        authority: opened.authority, expectedResourceRevision: request.expectedResourceRevision,
        verifyAuthority: () => true }),
    });
    onTestFinished(runtime.close);
    const send = async () => {
      const target = await runtime.resolveProviderBrokerApplicationTarget({
        handshake: { v: 1, kind: 'provider_broker', authority: opened.authority }, authority: opened.authority,
        authenticatedRemoteEndpointId: 'a'.repeat(64), localEndpointId: 'b'.repeat(64), signal: new AbortController().signal });
      if (!target) throw new Error('Broker application target unavailable');
      const body = JSON.stringify({ model: 'gpt-5.1', input: 'reply', stream: true });
      return new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: target.port });
        const chunks: Buffer[] = [];
        socket.once('connect', () => socket.write(target.localCapability + [
          'POST /v1/responses HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close', 'Content-Type: application/json',
          'Authorization: Bearer actor-must-not-cross', `Content-Length: ${Buffer.byteLength(body)}`, '', body,
        ].join('\r\n')));
        socket.on('data', chunk => chunks.push(chunk));
        socket.once('error', reject);
        socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
    };
    expect(processRequests).toHaveLength(0);
    const permitted = await send();
    expect(permitted).toContain('HTTP/1.1 200');
    expect(permitted).toContain('response.completed');
    expect(permitted).not.toContain(token);
    expect(processRequests).toHaveLength(1);
    const sent = processRequests[0]!;
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers['x-api-key']).toBeUndefined();
    expect(sent.path).toBe('/v1/responses');
    expect(sent.headers['x-happier-provider-source-credential']).toBe(`Bearer ${token}`);
    expect(JSON.parse(Buffer.from(String(sent.headers['x-happier-provider-source']), 'base64url').toString())).toMatchObject({
      baseUrl, credentialHeaderName: 'cf-aig-authorization', publicHeaders: {
        'cf-aig-collect-log': 'false', 'cf-aig-no-wholesale': 'true', 'cf-aig-skip-cache': 'true',
      } });
    upstreamStatus = 401;
    rotateOnUnauthorized = true;
    expect(await send()).toContain('HTTP/1.1 401');
    expect(processRequests).toHaveLength(2);
    expect(processRequests[1]!.headers['x-happier-provider-source-credential']).toBe(`Bearer ${token}`);
    expect(await send()).toContain('HTTP/1.1 200');
    expect(processRequests).toHaveLength(3);
    expect(processRequests[2]!.headers['x-happier-provider-source-credential']).toBe(`Bearer ${rotatedToken}`);
    // Tightening the Team sign-in policy is decided at admission only; a
    // Team wake does not re-evaluate this route (the opening credential
    // presented no evidence and would not qualify now).
    await db.team.update({ where: { id: home.team.id }, data: { authenticationPolicy: {
      v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'email_password' }] } } });
    expect(await custody.revalidateRetainedClaims(undefined, undefined, { facts: ['teams'] })).toBe(0);
    expect(await send()).toContain('HTTP/1.1 200');
    expect(processRequests).toHaveLength(4);
    await db.team.update({ where: { id: home.team.id }, data: { authenticationPolicy: { v: 1, mode: 'inherit' } } });
    // Audience withdrawal must make the admitted lease inactive at the next
    // request while a response already in flight can finish.
    expect(await inTx(tx => setTeamCredentialAudienceInTx(tx, { actorAccountId: home.custodian.id,
      authentication: teamAuthentication, input: { resourceId: resource.id, expectedRevision: resource.revision,
        allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [] },
    }))).toMatchObject({ ok: true });
    expect(await custody.revalidateRetainedClaims(undefined, undefined, { facts: ['teams'] })).toBe(0);
    const withdrawn = await send();
    expect(withdrawn).toContain('HTTP/1.1 403');
    expect(withdrawn).toContain('"code":"operation_not_current"');
    expect(processRequests).toHaveLength(4);
    const currentResource = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(await openTeamCredentialProviderBroker({ actorAccountId: home.creator.id,
      authentication: { ...TEST_AUTHENTICATION, tokenEpoch: 0 },
      request: { v: 1, resourceId: resource.id, expectedResourceRevision: currentResource.revision,
        modelId: 'gpt-5.1', sourceRevision: catalog.sourceRevision, initiatorMachineId: worker.id,
        consumer: { kind: 'session', sessionId: session.id }, application },
      readCurrentPresence: async () => ({ initiatorPresence: { state: 'partial', machineIds: new Set([worker.id]) }, brokerPresence: brokerPresence() }),
      nowMs: 200, grantId: crypto.randomUUID(), signingKey: { keyId: 'cf-u3-home', secretKey: signingKey.secretKey },
      readProviderProjection: async () => fixture.projectModels({ machineId: home.broker.id, agentTargetKey, application,
        sourceCatalog: true, providerConnection: { connectionId, expectedConnectionSecurityFingerprint: fixture.source.connectionSecurityFingerprint } }),
    })).toMatchObject({ ok: false });
    expect(fixture.probeRequests()).toBe(0);
    expect(await db.usageEvent.findFirst({ where: { teamCredentialResourceId: resource.id, externalKey: 'cf-u3-1' },
      select: { accountId: true, sessionId: true, brokerMachineId: true },
    })).toEqual({ accountId: home.creator.id, sessionId: session.id, brokerMachineId: home.broker.id });
  }, 180_000);

  it.each(['endpoint', 'billing policy', 'secret source', 'disabled', 'deleted', 'secret revoked'] as const)(
    'refuses the retained source credential after %s changes', async change => {
      const fixture = await sourceFixture();
      const snapshot = fixture.snapshot();
      const resolved = resolveProviderConnectionBrokerSource({ source: fixture.source, machineId,
        endpointTemplateId: 'cloudflare-responses', protocol: 'openai-responses', registry: fixture.registry,
        dnsEvidenceByEndpointUrl: fixture.dnsEvidenceByEndpointUrl, accountSettings: snapshot.settings,
        providerSettings: readProviderSettingsForCli(snapshot).settings,
        savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot) });
      if (!resolved.ok) throw new Error(resolved.error.code);
      const materialize = () => materializeProviderConnectionBrokerSource({ expected: resolved.snapshot,
        registry: fixture.registry, dnsEvidenceByEndpointUrl: fixture.dnsEvidenceByEndpointUrl,
        getAccountSettingsSnapshot: fixture.snapshot });
      const admitted = await materialize();
      expect(admitted).toMatchObject({ ok: true });
      if (!admitted.ok) throw new Error(admitted.error.code);
      expect(admitted.lease.credential).toMatchObject({ name: 'cf-aig-authorization', value: `Bearer ${token}` });
      admitted.lease.close();
      if (change === 'secret revoked') fixture.revokeSecret();
      else if (change === 'deleted') fixture.update(current => deleteProviderConnectionV1(current, connectionId, 2));
      else if (change === 'disabled') fixture.update(current => ProviderSettingsV1Schema.parse({ ...current, accountGrants: [] }));
      else fixture.update(current => ProviderSettingsV1Schema.parse({ ...current,
        ...(change === 'secret source' ? { secretBindingsByConnectionId: { [connectionId]: {
          account: { apiKey: formatSharedSavedSecretRefV1('replacement-secret') }, byMachineId: {} } } } : {}),
        connections: current.connections.map(connection => ({ ...connection,
          ...(change === 'endpoint' ? { endpointOverrides: [{ endpointTemplateId: 'cloudflare-responses',
            baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/other/openai' }] } : {}),
          ...(change === 'billing policy' ? { endpointOverrides: [{ endpointTemplateId: 'cloudflare-responses', baseUrl,
            publicHeaders: { 'cf-aig-no-wholesale': 'false' } }] } : {}),
        })),
      }));
      expect(await materialize()).toMatchObject({ ok: false });
    },
  );

  it('offers the exact manual Responses source without custodian consent, private catalog or secret export', async () => {
    const fixture = await sourceFixture();
    const catalog = await fixture.catalog();
    expect(catalog?.rows).toHaveLength(1);
    expect(catalog?.rows[0]).toMatchObject({ descriptor: { id: 'gpt-5.1' }, application,
      compatibility: { confirmed: false }, sourceFacts: { endpoint: { modelIdPattern: '^(?!claude-)[^/\\s]+$' } } });
    expect(JSON.stringify(catalog)).not.toContain(token);
    const candidate = await resolveTeamCredentialResourceTestCandidate({ machineId, teamId: 'team', resourceId: 'resource',
      expectedResourceRevision: 1, source: fixture.source,
      readSourceModelCatalogs: fixture.models.readSourceModelCatalogs, createRequestId: () => 'resource-test' });
    expect(candidate).toMatchObject({ application: { implementationIdentity: application.implementationIdentity,
      protocol: application.protocol }, request: { route: 'responses' } });
    expect(candidate?.application).not.toHaveProperty('agentTargetKey');
    expect(fixture.probeRequests()).toBe(0);
    const stale = { ...fixture.source, connectionSecurityFingerprint: 'connection-security:v1:stale' };
    await expect(resolveTeamCredentialResourceSourceCatalogs({ machineId, teamId: 'team', resourceId: 'resource',
      expectedResourceRevision: 1, source: stale, application, readSourceModelCatalogs: fixture.models.readSourceModelCatalogs }))
      .rejects.toMatchObject({ status: 'unavailable' });
  });
});
