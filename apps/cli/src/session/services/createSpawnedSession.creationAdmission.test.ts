import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { markRpcRequestDisposition, socketRpcCodec } from '@happier-dev/sync-client';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { ConnectedAccountCatalogRowReadResponseV1Schema, ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import {
  buildSessionSpawnInitialInputLocalIdV1,
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
  SessionCreationKeyV1Schema,
  SessionInitialTriggerAdmissionV1Schema,
  SPAWN_SESSION_ERROR_CODES,
  createActionExecutor,
  SessionSpawnNewInputV2Schema,
  accountSettingsParse,
  FeaturesResponseSchema,
  McpServersSettingsV1Schema,
  projectMcpServerMaterializationV1,
  resolveSessionCapabilitiesV1,
  SessionInputRequestV1Schema,
  settleSessionInputRequestV1,
} from '@happier-dev/protocol';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionSpawnNewActionResultV1Schema, SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { SessionSpawnNewInitialInputV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot, createSessionCreationTargetPreparationRpcResult,
  resolveApiSessionSocketDefaultAck, respondToExactMachineSessionSpawnRpc } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { CapabilitiesDetectResponse } from '@/capabilities/types';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { configuration } from '@/configuration';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createSpawnedSession } from './createSpawnedSession';
import { submitSpawnInitialInput } from './submitSpawnInitialInput';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from './sessionInputAdmissionIdentity';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createWorkflowRequesterCustody, listWorkflowRequesterCredentialScopes } from '@/daemon/workflows/requesterCustody';

// Only HTTP/authentication and exact-machine transport boundaries are replaced;
// lookup decoding, creation settlement and Message admission remain real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: vi.fn(), get: vi.fn(), request: vi.fn(), isAxiosError: actual.default.isAxiosError } };
});
vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: vi.fn(async () => ({ state: 'valid' })),
}));
const fetchSessionById = vi.hoisted(() => vi.fn());
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
}));
const fetchAccountEncryptionCurrentness = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness,
}));
const socketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => socketBoundary.create() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  resetActiveAccountSettingsSnapshotForTests(); resetServerFeaturesClientForTests(); });

const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'admission-test' });
const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
  v: 1,
  sessionCreationTag,
  recipe: {
    execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
    organization: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
    configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
    terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
  },
});

// Exact-machine RPC and opened Machine metadata are external daemon boundaries.
function creationAdmissionReadinessReply(method: string): unknown {
  if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', capabilities: { sessions: {
          open: ['create'], delivery: ['newTurn'], cancel: true,
        } } },
      } } });
  }
  if (method === RPC_METHODS.CAPABILITIES_DETECT) return {
    protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
      installed: true, version: '1.2.3', latestVersion: null, update: { supported: false, command: null },
      signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
      install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
    } } },
  } satisfies CapabilitiesDetectResponse;
  return undefined;
}

function createCreationAdmissionMachineTransport(machineId: string) {
  const transport = createLocalMachineActionTransportFixture(machineId);
  return { ...transport, invoke: async (...args: Parameters<typeof transport.invoke>) => {
    const [method, request] = args;
    const readiness = creationAdmissionReadinessReply(method);
    if (readiness !== undefined) return readiness;
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
      || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) {
      return createSessionCreationTargetPreparationRpcResult(SessionCreationTargetPreparationRequestV1Schema.parse(request));
    }
    return transport.invoke(...args);
  } };
}

describe('canonical Session creation admission', () => {
  const spawn = vi.fn();
  const resolveSpawnSessionByNonce = vi.fn();
  const params = {
    credentials: { token: 'test-token', encryption: null },
    directory: '/repo', machineId: 'machine-1',
    agentTarget: sessionCreationCorrespondence.recipe.agentTarget,
    sessionCreationTag, sessionCreationCorrespondence,
    directTransport: { spawn, resolveSpawnSessionByNonce },
  };
  const machineSnapshot = { ...createAvailableSessionSpawnMachineSnapshot('machine-1'),
    ...ExternalActionMachineBootstrapV1Schema.parse({ id: 'machine-1', kind: 'persistent', active: true,
      managedMachineRef: null, revokedAt: null, replacedByMachineId: null }), storageMode: 'plain' };

  beforeEach(() => {
    vi.clearAllMocks();
    // The installed Account owns this already-authenticated defaults snapshot.
    // A separate admitted requester still opens its own network snapshot.
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(params.credentials), connectedPurposeCatalog: {
        status: 'ready', revision: 1, record: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) },
      } });
    vi.mocked(axios.request).mockReset().mockImplementation(async request => {
      if (String(request.url).endsWith('/v1/home/governance/get')) return { status: 200, data: { homeDefaults: null } };
      throw new Error(`Unexpected creation Home request ${String(request.url)}`);
    });
    vi.mocked(axios.get).mockReset().mockImplementation(async url => {
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: machineSnapshot } };
      throw new Error(`Unexpected creation HTTP read ${url}`);
    });
    socketBoundary.create.mockImplementation(() => createApiSessionSocketStub({
      emitWithAck: async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return resolveApiSessionSocketDefaultAck(event, payload);
        const call = payload as SocketRpcRequestPayload;
        const content = { mode: 'plain' as const };
        const decoded = await socketRpcCodec.decodeRequestParams(content, call.params, call.method);
        const method = call.method.startsWith('machine-1:') ? call.method.slice('machine-1:'.length) : call.method;
        const readiness = creationAdmissionReadinessReply(method);
        const result = readiness ?? (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
          || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE
          ? createSessionCreationTargetPreparationRpcResult(SessionCreationTargetPreparationRequestV1Schema.parse(decoded.params))
          : undefined);
        if (result === undefined) throw new Error(`Unexpected creation Machine RPC ${method}`);
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
      },
      emit: (event, args) => {
        if (respondToExactMachineSessionSpawnRpc({ event, args, machineId: 'machine-1', sessionId: 'session-created',
          onSpawnRequest: () => { throw new Error('Unexpected remote spawn after local target preparation'); } })) return;
      },
    }));
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { sessions: [] } });
    spawn.mockResolvedValue({
      success: true, sessionId: 'session-created',
      sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } },
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-created', createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadataVersion: 1, metadataLayoutVersion: 1, encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }),
    });
    fetchAccountEncryptionCurrentness.mockRejectedValue(new Error('Account currentness unavailable'));
  });

  it.each([
    { origin: 'machine_policy', authored: 'same', rejoined: true },
    { origin: 'machine_policy', authored: 'derived-native', rejoined: true },
    { origin: 'machine_policy', authored: 'added-native-same-value', rejoined: false },
    { origin: 'machine_policy', authored: 'changed-permission', rejoined: false },
    { origin: 'machine_policy', authored: 'changed-project-files', rejoined: false },
    { origin: 'machine_policy', authored: 'added-managed', rejoined: false },
    { origin: undefined, authored: 'same', rejoined: false },
    { origin: undefined, authored: 'explicit-managed', rejoined: true },
  ] as const)('retains only internally derived placement across current policy refusal ($origin, $authored)', async scenario => {
    const nativeConfiguration = { mode: { value: null, updatedAtMs: 0 },
      model: { value: null, updatedAtMs: 0, selectionSource: 'inherited' as const },
      permissionIntent: { value: null, updatedAtMs: 0 }, options: {}, nativeSandbox: 'off' as const };
    const nativeDerived = scenario.authored === 'derived-native' || scenario.authored === 'added-native-same-value';
    const retained = { ...sessionCreationCorrespondence,
      recipe: { ...sessionCreationCorrespondence.recipe, managedCreation: { homeId: 'home', managedId: 'shared-original',
        controller: { machineId: 'machine-1', installationId: 'install' } },
        ...(scenario.origin ? { managedCreationOrigin: scenario.origin } : {}),
        ...(scenario.authored === 'changed-project-files'
          ? { projectFiles: { kind: 'sync' as const, mode: 'keep_synced' as const } } : {}),
        ...(nativeDerived ? { configuration: nativeConfiguration, nativeSandboxOrigin: 'machine_policy' as const } : {}) } };
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { path: '/repo', host: 'host', machineId: 'machine-1', sessionCreationCorrespondenceV1: retained } });
    const session = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture('session-created'),
      encryptionMode: 'plain', share: null, active: true, archivedAt: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1 });
    vi.mocked(axios.post).mockImplementation(async url => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [session] } };
      throw new Error(`Unexpected creation request ${url}`);
    });
    let allocations = 0;
    const authored = { ...sessionCreationCorrespondence, recipe: { ...sessionCreationCorrespondence.recipe,
      ...(scenario.authored === 'changed-permission' ? { requestedPermissionMode: 'read-only' } : {}),
      ...(scenario.authored === 'changed-project-files' ? { projectFiles: { kind: 'copy_once' as const } } : {}),
      ...(scenario.authored === 'added-native-same-value' ? { configuration: nativeConfiguration } : {}),
      ...(scenario.authored === 'added-managed' || scenario.authored === 'explicit-managed'
        ? { managedCreation: retained.recipe.managedCreation } : {}) } };
    const pending = createSpawnedSession({ ...params, sessionCreationCorrespondence: authored,
      ...(scenario.authored === 'added-native-same-value' ? { authoredNativeSandbox: 'off' as const } : {}),
      prepareSessionIsolation: async () => {
        allocations += 1;
        throw Object.assign(new Error('Current Machine policy is unreadable'), { code: 'target_unavailable' });
      } });
    if (scenario.rejoined) await expect(pending).resolves.toMatchObject({ disposition: 'rejoined', sessionId: session.id });
    else await expect(pending).rejects.toMatchObject({ code: 'creation_conflict' });
    expect(allocations).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves policy placement once after the fresh creation lookup before native dispatch', async () => {
    const refusal = Object.assign(new Error('Native boundary refused launch'), { code: 'native_fixture_refused' });
    spawn.mockRejectedValue(refusal);
    let allocations = 0;
    await expect(createSpawnedSession({ ...params, prepareSessionIsolation: async () => {
      allocations += 1;
      const managedCreation = { homeId: 'home', managedId: 'fresh-bound' };
      return { sessionCreationCorrespondence: { ...sessionCreationCorrespondence,
        recipe: { ...sessionCreationCorrespondence.recipe, managedCreation } },
        managedTargetPlacement: { managedId: managedCreation.managedId, workspaceRoot: '/repo' } };
    } })).rejects.toMatchObject({ code: 'native_fixture_refused' });
    expect(allocations).toBe(1);
    expect(SpawnDaemonSessionRequestSchema.parse(spawn.mock.calls[0]?.[0])).toMatchObject({
      managedTargetPlacement: { managedId: 'fresh-bound', workspaceRoot: '/repo' },
      sessionCreationCorrespondence: { recipe: { managedCreation: { managedId: 'fresh-bound' } } },
    });
  });

  it.each(['explicit', 'implicit'] as const)('retries failed target preparation with the retained %s copy source', async source => {
    const managedCreation = { homeId: 'home', managedId: 'retained-after-preparation-failure',
      controller: { machineId: 'machine-1', installationId: 'installation' } };
    const projectFilesSource = { target: { serverId: 'server-1', machineId: 'original-machine' }, directory: '/original/project' };
    const sourceWorkspace = { serverId: 'server-1', machineId: 'original-machine', workspaceId: 'source-workspace', rootPath: '/original/project' };
    const recipeSource = source === 'explicit' ? { projectFilesSource } : {};
    const placementSource = source === 'explicit' ? { projectFilesSource, projectFilesSourceWorkspace: sourceWorkspace } : {};
    const correspondence = { ...sessionCreationCorrespondence, recipe: { ...sessionCreationCorrespondence.recipe,
      managedCreation, managedCreationOrigin: 'machine_policy' as const,
      ...recipeSource,
      projectFilesOrigin: { sourceWorkspace, targetWorkspace: { v: 2 as const, kind: 'managed' as const,
        serverId: 'server-1', workspaceId: 'target-workspace', managedId: managedCreation.managedId,
        controller: managedCreation.controller, rootPath: '/target/project' } },
      projectFiles: { kind: 'copy_once' as const } } };
    const envelopes = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { path: '/repo', host: 'host', sessionCreationCorrespondenceV1: correspondence } });
    const unstarted = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture('session-target-retry'),
      encryptionMode: 'plain', share: null, active: false, archivedAt: null, runtimeActivityRevision: 0,
      runtimeActivityState: 'unknown', runtimeActivityActiveCount: 0, runtimeActivityObservedAt: null,
      metadataLayoutVersion: envelopes.metadataLayoutVersion, metadata: envelopes.sharedMetadata.ciphertext,
      ownerMetadata: envelopes.ownerMetadata, dataEncryptionKey: null });
    let birthCommitted = false;
    let allocations = 0;
    let attempts = 0;
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: { data: 'bound-key' } } };
      throw new Error(`Unexpected retry HTTP read ${url}`);
    });
    vi.mocked(axios.post).mockImplementation(async url => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: birthCommitted ? [unstarted] : [] } };
      throw new Error(`Unexpected retry HTTP write ${url}`);
    });
    spawn.mockImplementation(async request => {
      const parsed = SpawnDaemonSessionRequestSchema.parse(request);
      expect(parsed).toMatchObject({ managedTargetPlacement: { managedId: managedCreation.managedId,
        ...placementSource,
        projectFiles: correspondence.recipe.projectFiles },
        sessionCreationCorrespondence: { recipe: { managedCreation, managedCreationOrigin: 'machine_policy', ...recipeSource } } });
      if (source === 'implicit') expect(parsed.managedTargetPlacement?.projectFilesSourceWorkspace).toBeUndefined();
      attempts += 1;
      if (!birthCommitted) {
        birthCommitted = true;
        throw Object.assign(new Error('Target preparation refused after Session birth'), { code: 'target_prepare_failed' });
      }
      expect(parsed).toMatchObject({ existingSessionId: unstarted.id, freshSessionCreation: false });
      return { type: 'success', sessionId: unstarted.id };
    });
    fetchSessionById.mockResolvedValue({ ...unstarted, active: true, archivedAt: null, runtimeActivityRevision: 1 });
    const request = { ...params, prepareSessionIsolation: async () => {
      allocations += 1;
      return { sessionCreationCorrespondence: correspondence,
        managedTargetPlacement: { managedId: managedCreation.managedId, workspaceRoot: '/repo',
          ...placementSource,
          projectFiles: correspondence.recipe.projectFiles } };
    } };
    await expect(createSpawnedSession(request)).rejects.toMatchObject({ code: 'target_prepare_failed' });
    await expect(createSpawnedSession(request)).resolves.toMatchObject({ disposition: 'rejoined', sessionId: unstarted.id });
    expect(allocations).toBe(1);
    expect(attempts).toBe(2);
  });

  it.each([false, true])('commits ordinary Bot birth and awaits content preparation before dispatching its runner (retry: %s)', async retry => {
    const committedSessionId = retry ? 'session-retry-created' : 'session-created';
    fetchSessionById.mockResolvedValue({ id: committedSessionId, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadataVersion: 1, metadataLayoutVersion: 1, encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }) });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    const events: string[] = [];
    let committed: Record<string, unknown> | null = null;
    let machineBound = false;
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: machineBound ? { data: 'bound-key' } : null } };
      throw new Error(`Unexpected HTTP read ${url}`);
    });
    vi.mocked(axios.post).mockImplementation(async (url, raw, config) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      if (String(url).includes('/v1/access-keys/')) {
        expect(config?.headers?.Authorization).toBe(`Bearer ${params.credentials.token}`);
        expect(raw).toMatchObject({ data: expect.any(String) });
        machineBound = true;
        events.push('machine-binding');
        return { status: 200, data: { success: true } };
      }
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected HTTP write ${url}`);
      expect(config?.headers?.Authorization).toBe(`Bearer ${params.credentials.token}`);
      const input = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>;
      events.push('birth');
      committed = {
        id: committedSessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        runtimeActivityState: 'unknown', runtimeActivityActiveCount: 0, runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0, archivedAt: null,
        metadataVersion: 1, metadataLayoutVersion: 1, metadata: input.sharedMetadata.ciphertext,
        ownerMetadata: input.ownerMetadata, encryptionMode: 'plain', agentState: null, agentStateVersion: 0,
        dataEncryptionKey: null, share: null,
      };
      return { status: 200, data: { created: true, session: committed } };
    });
    spawn.mockImplementation(async request => {
      events.push('launch');
      expect(request).toMatchObject({ existingSessionId: committedSessionId, freshSessionCreation: !retry });
      expect(events).toEqual(retry ? ['birth', 'machine-binding', 'content', 'content', 'launch']
        : ['birth', 'machine-binding', 'content', 'launch']);
      return { type: 'success', sessionId: committedSessionId };
    });
    let failPreparation = retry;
    const preparedParams = { ...params,
      beforeLaunch: async birth => {
        expect(birth).toMatchObject({ sessionId: committedSessionId, metadataRevision: 1 });
        expect(machineBound).toBe(true);
        await Promise.resolve();
        events.push('content');
        if (failPreparation) throw new Error('Content boundary unavailable');
      },
    } satisfies Parameters<typeof createSpawnedSession>[0];
    if (retry) {
      await expect(createSpawnedSession(preparedParams)).rejects.toMatchObject({ details: { sessionId: committedSessionId } });
      expect(spawn).not.toHaveBeenCalled();
      failPreparation = false;
    }
    const result = await createSpawnedSession(preparedParams);
    expect(result).toMatchObject({ disposition: retry ? 'rejoined' : 'created', sessionId: committedSessionId });
    expect(events.filter(event => event === 'birth')).toHaveLength(1);
  });

  it('commits an asleep managed Bot through ordinary birth and rejoin without dispatching a runner', async () => {
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    const sessionId = 'session-deferred-birth';
    let committed: Record<string, unknown> | null = null;
    let births = 0;
    let requests = 0;
    let machineBound = false;
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).includes('/v1/access-keys/')) {
        return { status: 200, data: { accessKey: machineBound ? 'existing' : null } };
      }
      throw new Error(`Unexpected HTTP read ${url}`);
    });
    vi.mocked(axios.post).mockImplementation(async (url, raw, config) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      if (String(url).includes('/v1/access-keys/')) {
        expect(config?.headers?.Authorization).toBe(`Bearer ${params.credentials.token}`);
        machineBound = true;
        return { status: 200, data: { success: true } };
      }
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected HTTP write ${url}`);
      requests++;
      expect(raw).not.toHaveProperty('templateRequesterAuthorization');
      if (committed) return { status: 200, data: { created: false, session: committed } };
      births++;
      const body = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>;
      expect(body.ownerMetadata).toMatchObject({ t: 'plain', v: { workspace: { sessionDirectoryV1: { v: 1, kind: 'managed' } } } });
      expect(body.ownerMetadata.t === 'plain' && body.ownerMetadata.v.workspace?.path).toBeUndefined();
      expect(body.ownerMetadata.t === 'plain' && body.ownerMetadata.v.workspace?.host).toBeUndefined();
      committed = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture(sessionId),
        id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
        metadata: body.sharedMetadata.ciphertext, ownerMetadata: body.ownerMetadata, encryptionMode: 'plain',
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null });
      return { status: 200, data: { created: true, session: committed } };
    });
    const deferred = { ...params, directory: undefined, directoryKind: 'managed' as const, deferLaunch: true as const,
      sessionCreationCorrespondence: SessionCreationCorrespondenceV1Schema.parse({ ...sessionCreationCorrespondence,
        recipe: { ...sessionCreationCorrespondence.recipe, execution: { machineId: 'machine-1', directory: { kind: 'managed' } } } }),
      beforeLaunch: async () => { expect(machineBound).toBe(true); },
    };
    const first = await createSpawnedSession(deferred);
    const second = await createSpawnedSession(deferred);
    expect(first).toMatchObject({ disposition: 'created', sessionId });
    expect(second).toMatchObject({ disposition: 'rejoined', sessionId });
    expect(births).toBe(1);
    expect(requests).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'plain', custody: 'pending' }, { mode: 'e2ee', custody: 'pending' },
    { mode: 'plain', custody: 'transcript' }, { mode: 'e2ee', custody: 'transcript' },
  ] as const)('rejoins the original $mode first input from $custody across CLI and UI without another admission', async ({ mode, custody }) => {
    const secret = new Uint8Array(32).fill(9);
    const credentials = { token: 'test-token', encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: mode,
      ...(mode === 'plain' ? { storedContentMode: mode } : { storedContentMode: mode, encryptionKey: secret, encryptionVariant: 'legacy' }),
      agentState: null, metadata: { path: '/repo', host: 'host', machineId: 'machine-1',
        permissionMode: 'read-only', sessionCreationCorrespondenceV1: sessionCreationCorrespondence } });
    const session = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture('session-created'),
      encryptionMode: mode, share: null, active: true, archivedAt: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
    fetchSessionById.mockResolvedValue(session);
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: mode } } }))));
    let saved: import('@/api/types').SessionMessageContent | null = null;
    let savedEquality: unknown;
    let admissions = 0;
    vi.mocked(axios.post).mockImplementation(async (url, body: unknown) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: saved ? [session] : [] } };
      if (String(url).endsWith('/pending')) {
        admissions += 1;
        if (!body || typeof body !== 'object') throw new Error('Missing Pending request');
        const candidate = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
        if (saved) {
          if (isDeepStrictEqual(saved, candidate)) return { status: 200, data: { didWrite: false } };
          throw new AxiosError('Conflict', 'ERR_BAD_REQUEST', undefined, undefined,
            { status: 400, data: { error: 'invalid-params', code: 'session_input_idempotency_conflict' }, statusText: 'Bad request', headers: {}, config: { headers: new AxiosHeaders() } });
        }
        saved = candidate;
        return { status: 200, data: { didWrite: true } };
      }
      throw new Error(`Unexpected creation request ${url}`);
    });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/pending')) return { status: 200, data: { pending: saved && custody === 'pending'
        ? [{ localId: firstLocalId, content: saved }] : [] } };
      if (String(url).includes('/messages/by-local-id/')) {
        if (saved && custody === 'transcript') return { status: 200, data: { message: { id: 'committed-first-input',
          seq: 1, localId: firstLocalId, createdAt: 1, updatedAt: 1, content: saved } } };
        throw new AxiosError('Not found', 'ERR_BAD_REQUEST', undefined, undefined,
          { status: 404, data: { error: 'Message not found' }, statusText: 'Not found', headers: {}, config: { headers: new AxiosHeaders() } });
      }
      throw new Error('Mutable organization placement unavailable');
    });
    const firstLocalId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag });
    const invoke = (surface: 'cli' | 'ui', text = 'QA failure fixture prompt.', structuredInput?: SessionSpawnNewInitialInputV1['structuredInput']) => createSpawnedSession({ ...params, credentials,
      initialInput: { text, ...(structuredInput ? { structuredInput } : {}) }, buildInitialInputHandoff: localId => ({
        ...buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller: { kind: 'host' }, callerSurface: surface, localId }),
        ...(structuredInput ? { meta: { happierStructuredInputV1: structuredInput } } : {}),
      }),
      machineAdmissionTransport: async request => {
        admissions += 1;
        if (saved) return isDeepStrictEqual(savedEquality, request.requestEqualityEvidenceV1)
          ? { status: 'alreadyAccepted', localId: request.localId }
          : { status: 'rejected', code: 'session_input_idempotency_conflict' };
        saved = request.content;
        savedEquality = request.requestEqualityEvidenceV1;
        return { status: 'accepted', localId: request.localId };
      } });
    expect(await invoke('cli')).toMatchObject({ disposition: 'created', initialInput: { status: 'accepted', localId: firstLocalId } });
    const original = saved;
    expect(await invoke('cli')).toMatchObject({ disposition: 'rejoined', initialInput: { status: 'alreadyAccepted', localId: firstLocalId } });
    expect(await invoke('ui')).toMatchObject({ disposition: 'rejoined', initialInput: { status: 'alreadyAccepted', localId: firstLocalId } });
    expect(await invoke('ui', 'A different prompt')).toMatchObject({ disposition: 'rejoined', initialInput: {
      status: 'rejected', code: 'session_input_idempotency_conflict' } });
    expect(await invoke('ui', undefined, { v: 1, mentions: [{ kind: 'partner.reference', ref: 'partner:changed', token: 'fixture' }] }))
      .toMatchObject({ disposition: 'rejoined', initialInput: { status: 'rejected', code: 'session_input_idempotency_conflict' } });
    vi.mocked(axios.get).mockRejectedValue(new Error('Retained input read unavailable'));
    expect(await invoke('ui')).toMatchObject({ disposition: 'rejoined', initialInput: {
      status: 'outcomeUnknown', localId: firstLocalId, code: 'session_input_rejoin_unavailable' } });
    expect(admissions).toBe(1);
    expect(saved).toBe(original);
  });

  it('admits a rejoined first input whose canonical request omits the optional caller', async () => {
    const credentials = { token: 'test-token', encryption: null };
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', agentState: null, metadata: { path: '/repo', host: 'host', machineId: 'machine-1',
        permissionMode: 'read-only', sessionCreationCorrespondenceV1: sessionCreationCorrespondence } });
    const session = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture('session-created'),
      encryptionMode: 'plain', share: null, active: true, archivedAt: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
    fetchSessionById.mockResolvedValue(session);
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    let persisted: import('@/api/types').SessionMessageContent | null = null;
    vi.mocked(axios.post).mockImplementation(async (url, body: unknown) => {
      if (!String(url).endsWith('/pending')) throw new Error(`Unexpected input request ${url}`);
      if (!body || typeof body !== 'object') throw new Error('Missing Pending request');
      persisted = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
      return { status: 200, data: { didWrite: true } };
    });
    const localId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag });
    const handoff = buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller: { kind: 'host' }, callerSurface: 'cli', localId });
    const { caller: _optionalCaller, ...requestWithoutCaller } = handoff.inputAdmission.request;
    const request = SessionInputRequestV1Schema.parse(requestWithoutCaller);
    expect(request).not.toHaveProperty('caller');
    expect(await submitSpawnInitialInput({ credentials, sessionId: session.id, targetMachineId: 'machine-1', localId,
      rejoinSession: session, initialInput: { text: 'First input after reconnect' },
      initialInputHandoff: { ...handoff, inputAdmission: { ...handoff.inputAdmission, request } },
    })).toEqual({ status: 'accepted', localId });
    expect(persisted).not.toBeNull();
  });

  it('retains the spawn nonce after an uncoded post-dispatch disconnect', async () => {
    spawn.mockRejectedValue(markRpcRequestDisposition(new Error('Connection lost after submission'), 'outcomeUnknown'));
    const failure = await createSpawnedSession(params).catch((error: unknown) => error);
    const submittedNonce = spawn.mock.calls[0]![0].spawnNonce;
    expect(submittedNonce).toEqual(expect.any(String));
    expect(failure).toMatchObject({ details: { spawnNonce: submittedNonce } });
  });

  it.each([
    { disposition: 'outcomeUnknown', cancel: false, expected: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } },
    { disposition: 'notSent', cancel: false, expected: { type: 'error', code: 'spawn_failed', retryable: true } },
    { disposition: 'notSent', cancel: true, expected: { type: 'error', code: 'cancelled', retryable: true } },
  ] as const)('projects an uncoded post-dispatch disconnect truthfully ($disposition, cancel=$cancel)', async ({ disposition, cancel, expected }) => {
    // The authenticated daemon transport is the boundary; Action projection and creator stay real.
    const controller = new AbortController();
    spawn.mockImplementation(async () => {
      if (cancel) controller.abort();
      throw markRpcRequestDisposition(new Error('Connection failed'), disposition);
    });
    const executor = createActionExecutor(createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
      machineActionDirectTargetTransport: createCreationAdmissionMachineTransport('machine-1'),
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'disconnected-creation', executionTarget: { serverId: 'home-a', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: params.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
    });
    expect(await executor.execute('session.spawn_new', input, {
      surface: 'cli', authority: 'present_user', serverId: 'home-a',
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: 'disconnected-creation', signal: controller.signal,
    })).toMatchObject({ ok: true, result: expected });
  });

  it('refuses a recognized unavailable tag lookup before any provider spawn', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 404,
      data: { statusCode: 404, error: 'Not Found', message: 'Route POST:/v2/sessions/lookup-by-tags not found' },
    });
    await expect(createSpawnedSession(params)).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      details: { incompatibleTarget: { reason: 'creation_lookup_unavailable' } } });
    expect(spawn).not.toHaveBeenCalled();
    expect(resolveSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('preserves the exact private requester-bootstrap predicate through spawn settlement', async () => {
    spawn.mockResolvedValue({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      errorMessage: 'Requester Session credential unavailable',
      incompatibleTarget: { reason: 'requester_credentials_unavailable' } });
    await expect(createSpawnedSession(params)).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      details: { incompatibleTarget: { reason: 'requester_credentials_unavailable' } },
    });
  });

  it('R41 authenticates the retained Global Codex recipe before rejoining a changed Account authentication default', async () => {
    const retained = SessionCreationCorrespondenceV1Schema.parse({ ...sessionCreationCorrespondence,
      recipe: { ...sessionCreationCorrespondence.recipe, connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'previous-pool' },
      } } } });
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { path: '/repo', host: 'fixture', sessionCreationCorrespondenceV1: retained } });
    const row = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture('retained-global-codex'), createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      archivedAt: null, metadataVersion: 1, metadataLayoutVersion: fields.metadataLayoutVersion,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      encryptionMode: 'plain', agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null });
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { sessions: [row] } });
    vi.mocked(axios.get).mockRejectedValue(new Error('Mutable organization unavailable'));
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    await expect(createSpawnedSession(params)).rejects.toMatchObject({ code: 'creation_conflict',
      details: { sessionId: row.id } });
    await expect(createSpawnedSession({ ...params, sessionCreationCorrespondence: retained }))
      .resolves.toMatchObject({ disposition: 'rejoined', sessionId: row.id });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('delivers sealed initial triggers to the exact daemon birth owner', async () => {
    const initialTriggers = [SessionInitialTriggerAdmissionV1Schema.parse({
      automationId: 'automation-initial', name: 'Prepare workspace', enabled: true,
      workflowDefinitionId: 'builtin:review-and-converge', assignments: [{ machineId: 'machine-1', enabled: true }],
      executionRecipe: { v: 2, templateVersion: 0, triggerEvidence: null,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } },
      triggers: [{ triggerId: 'trigger-initial', trigger: { kind: 'sessionLifecycle', enabled: true,
        events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    })];
    let sealedForSessionId: string | undefined;
    await expect(createSpawnedSession({ ...params, prepareInitialTriggers: async (preparedFinalSessionId?: string) => {
      sealedForSessionId = preparedFinalSessionId;
      return initialTriggers;
    } })).resolves.toMatchObject({
      sessionId: 'session-created', disposition: 'created',
    });
    expect(sealedForSessionId).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
    expect(spawn.mock.calls[0]![0]).toMatchObject({ initialTriggers, preparedFinalSessionId: sealedForSessionId });
  });

  it.each(['returned', 'thrown'] as const)('preserves a confirmed Home rollback through plugin spawn and rejoins the same birth after retry (%s)', async responseKind => {
    const attestedContext = { externalPrincipalId: 'principal-rollback', sourceMessageId: 'message-rollback' };
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })),
    { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: machineSnapshot } };
      if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
      throw new Error(`Unexpected HTTP read ${url}`);
    });
    let refuse = true;
    const rows = new Map<string, Record<string, unknown>>();
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [...rows.values()] } };
      if (String(url).endsWith('/v1/sessions')) {
        if (refuse) {
          const response = { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
          if (responseKind === 'thrown') throw Object.assign(new Error('Home rollback'), { isAxiosError: true, response });
          return response;
        }
        const input = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields> & { tag: string };
        SessionOwnerMetadataEnvelopeV1Schema.parse(input.ownerMetadata);
        let row = rows.get(input.tag);
        if (!row) {
          row = { id: 'session-created', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            metadataVersion: 1, metadataLayoutVersion: 1, metadata: input.sharedMetadata.ciphertext,
            ownerMetadata: input.ownerMetadata, encryptionMode: 'plain', agentState: null, agentStateVersion: 0,
            dataEncryptionKey: null, share: null };
          rows.set(input.tag, row);
        }
        return { status: 200, data: { session: row, created: true } };
      }
      throw new Error(`Unexpected HTTP write ${url}`);
    });
    spawn.mockResolvedValue({ type: 'success', sessionId: 'session-created' });
    const executor = createActionExecutor(createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
      machineActionDirectTargetTransport: createCreationAdmissionMachineTransport('machine-1'),
      sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce } },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'channel-thread:rollback-router:rollback-root',
      executionTarget: { serverId: 'home-a', machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: params.agentTarget, connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false, attestedContext });
    const context = { surface: 'plugin' as const, authority: 'account_automation' as const, serverId: 'home-a',
      actionCaller: { kind: 'plugin' as const, pluginId: 'happier.channels' } };
    expect(await executor.execute('session.spawn_new', input, context)).toMatchObject({ ok: true,
      result: { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { code: 'database_transaction_conflict_exhausted' } } });
    expect(rows.size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    refuse = false;
    spawn.mockResolvedValueOnce({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Runner refused after the Home committed the Session' });
    expect(await executor.execute('session.spawn_new', input, context)).toMatchObject({ ok: true,
      result: { type: 'error', code: 'spawn_failed' } });
    expect(rows.size).toBe(1);
    // The child binding may be missing after Session birth. A replay recovers
    // that birth through the real tag/correspondence reader without relaunch.
    expect(await executor.execute('session.spawn_new', input, context)).toMatchObject({ ok: true,
      result: { type: 'success', disposition: 'rejoined', sessionId: 'session-created', attestedContext } });
    expect(rows.size).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('composes plugin spawn private birth and rejoin with real attested HTTP MCP calls', async () => {
    const attestedContext = { externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>' };
    const cause = { requestRef: 'parent-question', requester: { serverId: 'home-a', accountId: 'requester' },
      persona: { serverId: 'home-a', sessionId: 'parent-session' }, origin: null };
    const admittedCauses: unknown[] = [];
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    resetServerFeaturesClientForTests();
    // Features use fetch; Session creation uses axios. Both HTTP boundaries
    // describe the same current plain-capable Home, with real policy parsing.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })),
    { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: machineSnapshot } };
      if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
      throw new Error(`Unexpected HTTP read ${url}`);
    });
    let committed = false;
    let createdRow: Record<string, unknown> | null = null;
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: createdRow ? [createdRow] : [] } };
      if (String(url).endsWith('/v1/sessions')) {
        const input = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>;
        const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(input.ownerMetadata);
        expect(owner.t).toBe('plain');
        expect(input.ownerMetadata).toMatchObject({ t: 'plain', v: { system: { attestedContext } } });
        expect(input.sharedMetadata.ciphertext).not.toContain('sales@batiplus.ch');
        committed = true;
        createdRow = { id: 'session-created', seq: 0, createdAt: 1, updatedAt: 1,
          active: false, activeAt: 1, metadataVersion: 1, metadataLayoutVersion: 1,
          metadata: input.sharedMetadata.ciphertext, ownerMetadata: input.ownerMetadata, encryptionMode: 'plain',
          agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
        return { status: 200, data: { session: createdRow, created: true } };
      }
      throw new Error(`Unexpected HTTP write ${url}`);
    });
    spawn.mockImplementation(async (request) => {
      expect(committed).toBe(true);
      expect(request).not.toHaveProperty('attestedContext');
      expect(request).toMatchObject({ existingSessionId: 'session-created' });
      return { type: 'success', sessionId: 'session-created' };
    });
    const executor = createActionExecutor(createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}) }),
      machineAdmissionTransport: async request => {
        if (request.content.t !== 'plain') throw new Error('Expected plain fixture input');
        const message = UserMessageSchema.parse(request.content.v);
        const inputAdmissionReceipt = { v: 1, issuer: 'authenticatedMachine' } as const;
        const inputAuthority = settleSessionInputRequestV1({
          request: SessionInputRequestV1Schema.parse(message.meta?.happierInputRequestV1),
          currentSessionPermissionCeiling: 'default', inputAdmissionReceipt,
        });
        admittedCauses.push(deriveSessionInputActionRequestAttributionV1({ requestRef: request.localId,
          persona: { serverId: 'home-a', sessionId: request.sessionId }, origin: null,
          messageRole: 'user', inputAdmissionReceipt, inputAuthority }));
        return { status: 'accepted', localId: request.localId };
      },
      machineActionDirectTargetTransport: createCreationAdmissionMachineTransport('machine-1'),
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'attested-http-mcp', executionTarget: { serverId: 'home-a', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: params.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false, attestedContext,
      initialInput: { text: 'Answer the original requester' },
    });
    for (const surface of ['ui', 'agent', 'mcp', 'cli', 'api', 'plugin'] as const) {
      expect(await executor.execute('session.spawn_new', input, {
        surface, authority: 'present_user', actionCaller: { kind: 'host' },
      }), `surface=${surface}`).toMatchObject({ ok: false, errorCode: surface === 'plugin'
        ? 'plugin_action_caller_required' : 'session_attested_context_forbidden' });
    }
    expect(committed).toBe(false);
    const result = await executor.execute('session.spawn_new', input, {
      surface: 'plugin', authority: 'account_automation', serverId: 'home-a',
      actionCaller: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'inbound' },
      actionRequestAttributionV1: cause,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Plugin spawn failed');
    expect(result.result).toMatchObject({ initialInput: { status: 'accepted' } });
    expect(admittedCauses).toEqual([cause]);
    const birth = SessionSpawnNewActionResultV1Schema.parse(result.result);
    expect(birth).toMatchObject({ type: 'success', sessionId: 'session-created', disposition: 'created', attestedContext });
    if (birth.type !== 'success') throw new Error('Spawn did not settle');
    // A new message can recreate a deleted thread binding with the same birth
    // key. It must recover the original assertion rather than change it.
    expect(await executor.execute('session.spawn_new', { ...input, attestedContext: {
      externalPrincipalId: 'other@batiplus.ch', sourceMessageId: '<followup@example.test>',
    } }, { surface: 'plugin', authority: 'account_automation', serverId: 'home-a',
      actionCaller: { kind: 'plugin', pluginId: 'happier.channels', contributionLocalId: 'inbound' },
      actionRequestAttributionV1: cause,
    })).toMatchObject({ ok: true, result: { sessionId: birth.sessionId, disposition: 'rejoined', attestedContext } });

    const root = await mkdtemp(join(tmpdir(), 'happier-attested-spawn-mcp-'));
    const received: Record<string, string | string[] | undefined>[] = [];
    const http = createServer(async (request, response) => {
      if (request.url !== '/mcp') { response.writeHead(404); response.end(); return; }
      // Wilson's stated boundary is stateless POST-only JSON and refuses Origin.
      if (request.headers.origin !== undefined) { response.writeHead(403); response.end(); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const mcp = new McpServer({ name: 'attested-birth', version: '1' });
      mcp.registerTool('identity', {}, async () => {
        received.push(request.headers);
        return { content: [{ type: 'text', text: JSON.stringify(request.headers) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('HTTP MCP fixture unavailable');
    try {
      for (const variant of ['attested', 'missing', 'wrong-route'] as const) {
        const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
          id: 'wilson', name: 'wilson', transport: 'http', remote: {
            url: `http://127.0.0.1:${address.port}/${variant === 'wrong-route' ? 'unbound' : 'mcp'}`,
            headers: {
              'X-Wilson-On-Behalf-Of': { t: 'sessionAttested', field: 'externalPrincipalId' },
              'X-Wilson-Source-Message': { t: 'sessionAttested', field: 'sourceMessageId' },
              'X-Happier-Session': { t: 'sessionAttested', field: 'sessionId' },
            },
          }, env: {}, createdAt: 0, updatedAt: 0,
        }], bindings: [{ id: 'bound', serverId: 'wilson', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
        const resolved = projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
          context: { machineId: 'machine-1', directory: '/repo', machinePlatform: null, projectKey: null, agentId: null },
          mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true,
        }), '/repo');
        const materialized = await materializeMcpServerConfigRecord({ resolved, tmpDir: root, processEnv: {
          externalPrincipalId: 'forged', sourceMessageId: '<forged>',
        }, session: { sessionId: birth.sessionId, ...(variant === 'missing' ? {} : { attestedContext: birth.attestedContext }) },
          deps: { resolveRemoteBridgeCommand: async () => {
            const invocation = await resolveNodeBackedMcpServerCommand({
              distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
              sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'], preferSourceEntrypoint: true,
            });
            return { ...invocation, args: ['--conditions=happier-source', ...invocation.args] };
          } },
        });
        expect(materialized.warnings).toEqual([]);
        const config = materialized.mcpServers.wilson!;
        const transport = new StdioClientTransport({ command: config.command, args: config.args,
          env: Object.fromEntries(Object.entries({ ...process.env, ...config.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          stderr: 'pipe' });
        const client = new Client({ name: 'spawn-attestation-seam', version: '1' }, { capabilities: {} });
        try {
          if (variant === 'wrong-route') {
            await expect(client.connect(transport)).rejects.toThrow();
            expect(received).toHaveLength(2);
            continue;
          }
          await client.connect(transport);
          const reply = await client.callTool({ name: 'identity', arguments: {} });
          expect(reply.isError).not.toBe(true);
          expect(received.at(-1)).toMatchObject({ 'x-happier-session': birth.sessionId });
          if (variant === 'attested') {
            expect(received.at(-1)).toMatchObject({ 'x-wilson-on-behalf-of': attestedContext.externalPrincipalId,
              'x-wilson-source-message': attestedContext.sourceMessageId });
          } else {
            expect(received.at(-1)).not.toHaveProperty('x-wilson-on-behalf-of');
            expect(received.at(-1)).not.toHaveProperty('x-wilson-source-message');
          }
          expect(received.at(-1)).not.toHaveProperty('origin');
        } finally { await client.close(); await transport.close(); materialized.cleanup(); }
      }
    } finally {
      await new Promise<void>(resolve => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(['prepared', 'incompatible', 'foreign-home'] as const)('resolves the managed target directory before preparing deferred Template birth triggers (%s target)', async targetReply => {
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const settings = accountSettingsParse({ memoryUpkeepInNewBots: false });
    const signing = nacl.sign.keyPair();
    const custodyHome = await mkdtemp(join(tmpdir(), 'managed-trigger-custody-'));
    const targetHome = await mkdtemp(join(tmpdir(), 'managed-trigger-target-'));
    onTestFinished(async () => { await rm(custodyHome, { recursive: true, force: true }); await rm(targetHome, { recursive: true, force: true }); });
    const { prepareSessionCreationTarget } = await import('@/session/creation/prepareSessionCreationTarget');
    const creationKey = SessionCreationKeyV1Schema.parse('managed-template-with-trigger');
    const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey });
    const expectedTarget = await prepareSessionCreationTarget({
      request: { directory: { kind: 'managed' }, sessionCreationTag: tag }, activeServerDir: targetHome,
    });
    if (!expectedTarget.ok) throw new Error('Managed target fixture did not resolve');
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200,
        data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
          content: { t: 'plain', v: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } } }) };
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
      if (String(url).endsWith(ACCOUNT_SECURITY_PATH_V1)) return { status: 200,
        data: AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: 'plain', nativeEmail: null,
          password: { status: 'not_enrolled', revision: null } }) };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) };
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: {
        ...machineSnapshot,
        operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3, 4] } },
        operationProtocolCapabilitiesRevision: 1,
      } } };
      throw new Error(`Unexpected managed trigger HTTP read ${url}`);
    });
    let birthTriggers: unknown;
    let birthOwnerMetadata: unknown;
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (!String(url).endsWith('/v1/sessions') || raw === null || typeof raw !== 'object') {
        throw new Error(`Unexpected managed trigger HTTP write ${url}`);
      }
      birthTriggers = Reflect.get(raw, 'initialTriggers');
      birthOwnerMetadata = Reflect.get(raw, 'ownerMetadata');
      // Real HTTP effect boundary: refuse the birth after inspecting the exact
      // prepared transaction. This test creates no Session or runner.
      throw new AxiosError('Isolated birth boundary refuses persistence', 'ERR_BAD_REQUEST');
    });
    const attribution = { serverId: 'home-a', accountId: 'owner', machineId: 'machine-1', installationId: 'installation-1' };
    const deps = createCliActionDeps({
      token: credentials.token, credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      externalActionMachineInstallationId: 'installation-1', externalActionMachineRequestPrivateKey: signing.secretKey,
      actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => settings }),
      workflowRequesterCustody: createWorkflowRequesterCustody({ happyHomeDir: custodyHome, attribution,
        credentials, serverHttpBaseUrl: 'https://home-a.example.test' }),
      machineActionDirectTargetTransport: createCreationAdmissionMachineTransport('machine-1'),
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: async (request: Parameters<typeof prepareSessionCreationTarget>[0]['request']) => {
          if (targetReply !== 'incompatible') return prepareSessionCreationTarget({ request, activeServerDir: targetHome });
          // Malformed transport bytes exercise the real target-result parser.
          return undefined as unknown as Awaited<ReturnType<typeof prepareSessionCreationTarget>>;
        },
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      },
    });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey,
      executionTarget: { serverId: targetReply === 'foreign-home' ? 'other-home' : 'home-a', machineId: 'machine-1' }, directory: { kind: 'managed' },
      agentTarget: sessionCreationCorrespondence.recipe.agentTarget, connectedServices: { v: 2, bindingsByServiceId: {} },
      memoryEnabled: false, initialTriggers: [{
        target: { kind: 'inline', definition: getWorkflowStarterExamplesV1().find(item => item.key === 'memory-upkeep-in-session')!.definition },
        executionTarget: { kind: 'session' }, trigger: { kind: 'schedule', enabled: true,
          schedule: { kind: 'cron', scheduleExpr: '0 9 * * 0', everyMs: null, timezone: null } },
      }],
    });
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'managed-trigger-template',
      input: { creation: input }, target: { kind: 'machine', machineId: 'machine-1' } });
    // Home's signed grant is the HTTP boundary; retain the real requester and
    // reviewed-child owners through the exact Session operand and continuation.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-birth-authorization', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'owner', serverIdentityId: 'home-a', machineId: 'machine-1', installationId: 'installation-1',
      admittedMachineRole: 'manage', actionId: 'template.instantiate', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const executor = createActionExecutor(deps);
    const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
      machineId: 'machine-1', installationId: 'installation-1', installationPrivateKey: signing.secretKey,
      serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => executor });
    if (!requester) throw new Error('Managed Template requester custody was not admitted');
    onTestFinished(() => requester.dispose());
    const execution = await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: envelope.input },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a', serverIdentityId: 'home-a',
        actionCaller: { kind: 'host' }, runtimeAccountId: 'owner', actionRequestId: envelope.requestId,
        externalActionExecutionAuthorization: requester.authorization, externalActionTarget: envelope.target,
        originalActionEnvelope: envelope },
      child: { action: 'session.spawn_new', role: 'create_bot', input },
      admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'cli' },
      invocationServices: { sessionCreation: { beforeLaunch: async () => {},
        hostOnboarding: { templateName: 'Managed helper', templateVersion: '1.0.0' } } },
      execute: (childInput, childContext, actionId) => executor.execute(actionId, childInput, childContext),
    });
    if (targetReply === 'foreign-home') {
      expect(execution).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
      expect(vi.mocked(axios.post).mock.calls.filter(([url]) => String(url).endsWith('/v1/sessions'))).toHaveLength(0);
      expect(spawn).not.toHaveBeenCalled();
      return;
    }
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true });
    if (!execution.ok) throw new Error('Managed Template child execution was refused');
    const result = SessionSpawnNewResultV1Schema.parse(execution.result);
    if (targetReply === 'incompatible') {
      expect(result).toEqual({ type: 'error', code: 'incompatible_target', retryable: false,
        incompatibleTarget: { reason: 'target_preparation_invalid_result' } });
      expect(birthTriggers).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
      return;
    }
    // The failure before the fix is an absent birth transaction: the canonical
    // Workflow recipe parser rejects the missing managed directory first.
    expect(Array.isArray(birthTriggers)).toBe(true);
    if (!Array.isArray(birthTriggers)) throw new Error('Trigger-bearing birth never reached the HTTP boundary');
    expect(birthTriggers).toHaveLength(1);
    expect(SessionInitialTriggerAdmissionV1Schema.parse(birthTriggers[0])).toMatchObject({
      executionRecipe: { workflow: { t: 'plain', v: { workspace: { directory: expectedTarget.directory } } } },
    });
    expect(birthOwnerMetadata).toMatchObject({ t: 'plain', v: { workspace: {
      sessionDirectoryV1: { v: 1, kind: 'managed' }, path: expectedTarget.directory,
    } } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { bot: true, upkeep: undefined, installed: true, refused: false },
    { bot: true, upkeep: true, installed: true, refused: false },
    { bot: true, upkeep: false, installed: false, refused: false },
    { bot: false, upkeep: true, installed: false, refused: false },
    { bot: true, upkeep: true, installed: true, refused: true },
  ])('installs canonical weekly upkeep only at ordinary Bot birth ($bot/$upkeep/$refused)', async ({ bot, upkeep, installed, refused }) => {
    const custodyHome = await mkdtemp(join(tmpdir(), 'initial-trigger-custody-'));
    onTestFinished(() => rm(custodyHome, { recursive: true, force: true }));
    const attribution = { serverId: 'home-a', accountId: 'guest', machineId: 'machine-1', installationId: 'installation' };
    // The native process boundary may produce sessionStarted immediately.
    // Its admitted trigger scopes must already have real protected custody.
    spawn.mockImplementation(async raw => {
      const request = SpawnDaemonSessionRequestSchema.parse(raw);
      const scopes = await listWorkflowRequesterCredentialScopes({ ...attribution, happyHomeDir: custodyHome });
      expect(scopes.status).toBe('ready');
      if (scopes.status === 'ready') expect(scopes.bindings.map(row => row.sessionId).sort())
        .toEqual((request.initialTriggers ?? []).flatMap(admission => admission.triggers.map(trigger => trigger.triggerId)).sort());
      if (refused) return { error: 'Session birth refused', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorDetail: { kind: 'session_creation_initial_trigger_refused', code: 'feature_disabled' } };
      return { success: true, sessionId: 'session-created',
        sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    fetchSessionById.mockImplementation(async () => {
      // The Home returns the actual admitted launch correspondence, not an unrelated fixture recipe.
      const request = SpawnDaemonSessionRequestSchema.parse(spawn.mock.calls[0]?.[0]);
      const envelopes = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
        accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
        metadata: { path: '/repo', host: 'host', ...request.identity, approvalProfileId: request.approvalProfileId,
          work: { memoryEnabled: request.memoryEnabled }, sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence } });
      return { id: 'session-created', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadataVersion: 1, metadataLayoutVersion: envelopes.metadataLayoutVersion,
        metadata: envelopes.sharedMetadata.ciphertext, ownerMetadata: envelopes.ownerMetadata,
        encryptionMode: 'plain', agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
    });
    // The constructor receives an authenticated Account-storage snapshot; all
    // preference parsing, Action admission, birth preparation and sealing stay real.
    let accountSettings = accountSettingsParse(upkeep === undefined ? {} : { memoryUpkeepInNewBots: upkeep });
    const executor = createActionExecutor(createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettings }),
      workflowRequesterCustody: createWorkflowRequesterCustody({ happyHomeDir: custodyHome, attribution,
        credentials: params.credentials, serverHttpBaseUrl: 'https://home-a.example.test' }),
      machineActionDirectTargetTransport: createCreationAdmissionMachineTransport('machine-1'),
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'bot-weekly-upkeep', executionTarget: { serverId: 'home-a', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: sessionCreationCorrespondence.recipe.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
      approvalProfileId: bot ? 'builtin:read-propose' : null,
      ...(bot ? { identity: { bot: { kind: 'bot' }, createdAsBot: true } } : {}),
      ...(bot && upkeep === true ? { initialTriggers: [{
        target: { kind: 'inline', definition: getWorkflowStarterExamplesV1().find(item => item.key === 'daily-summary-in-session')!.definition },
        executionTarget: { kind: 'session' },
        trigger: { kind: 'schedule', enabled: true,
          schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } },
      }] } : {}),
    });
    const result = await executor.execute('session.spawn_new', input, {
      surface: 'cli', authority: 'present_user', serverId: 'home-a',
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: 'bot-weekly-upkeep',
    });
    if (refused) {
      expect(result).toMatchObject({ ok: true, result: { type: 'error', code: 'target_unavailable', retryable: false } });
      const remaining = await listWorkflowRequesterCredentialScopes({ ...attribution, happyHomeDir: custodyHome });
      expect(remaining).toEqual({ status: 'ready', bindings: [] });
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', disposition: 'created', sessionId: 'session-created' } });
    expect(spawn).toHaveBeenCalledTimes(1);
    const request = spawn.mock.calls[0]![0];
    expect(request.memoryEnabled).toBe(false);
    expect(request.approvalProfileId).toBe(input.approvalProfileId);
    expect(request.sessionCreationCorrespondence.recipe.approvalProfileId).toBe(input.approvalProfileId);
    if (!installed) {
      expect(request.initialTriggers ?? []).toEqual([]);
      return;
    }
    const example = getWorkflowStarterExamplesV1().find(item => item.key === 'memory-upkeep-in-session');
    if (!example) throw new Error('Missing canonical upkeep example');
    expect(request.initialTriggers).toHaveLength(upkeep === true ? 2 : 1);
    const admission = SessionInitialTriggerAdmissionV1Schema.parse(request.initialTriggers.at(-1));
    if (upkeep === true) expect(SessionInitialTriggerAdmissionV1Schema.parse(request.initialTriggers[0]))
      .toMatchObject({ triggers: [{ trigger: { kind: 'schedule', schedule: { scheduleExpr: '0 9 * * *' } } }] });
    expect(admission).toMatchObject({ enabled: true, assignments: [{ machineId: 'machine-1', enabled: true }],
      executionRecipe: { v: 2, workflow: { t: 'plain', v: { inlineDefinition: example.definition,
        approvalProfileId: input.approvalProfileId, executionTarget: { kind: 'session' } } } },
      triggers: [{ trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 9 * * 0' } } }],
    });
    // A subsequent ordinary request observes the accepted birth after the
    // authenticated Account preference changes. It never installs anew.
    const acceptedRow = await fetchSessionById();
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { sessions: [acceptedRow] } });
    accountSettings = accountSettingsParse({ memoryUpkeepInNewBots: false });
    expect(await executor.execute('session.spawn_new', input, {
      surface: 'cli', authority: 'present_user', serverId: 'home-a',
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: 'bot-weekly-upkeep-observe',
    })).toMatchObject({ ok: true, result: { type: 'success', disposition: 'rejoined', sessionId: 'session-created' } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('commits Discussion ownership before a native runner and keeps fresh facts out of the attach request', async () => {
    const discussionParticipant = { discussionId: 'discussion', participantSlotId: 'slot' };
    const discussionParticipantLaunch = { executionTarget: { serverId: 'home', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/repo' }, agentTarget: params.agentTarget! };
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({ ...sessionCreationCorrespondence,
      recipe: { ...sessionCreationCorrespondence.recipe, discussionParticipant } });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    let committed = false;
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: 'existing' } });
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (String(url).endsWith('/v1/sessions')) {
        expect(raw).toMatchObject({ originKind: 'discussion', discussionParticipant, discussionParticipantLaunch,
          ownerMetadata: { t: 'plain', v: { system: { sessionCreationCorrespondenceV1: correspondence } } } });
        committed = true;
        const input = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>;
        return { status: 200, data: { session: { id: 'session-created', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
          metadataLayoutVersion: 1, metadata: input.sharedMetadata.ciphertext, ownerMetadata: input.ownerMetadata, metadataVersion: 1,
          encryptionMode: 'plain', agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null }, created: true } };
      }
      throw new Error(`Unexpected Discussion birth request ${url}`);
    });
    spawn.mockImplementation(async request => {
      expect(committed).toBe(true);
      expect(request).toMatchObject({ existingSessionId: 'session-created' });
      expect(request).not.toHaveProperty('discussionParticipant');
      expect(request).not.toHaveProperty('discussionParticipantLaunch');
      expect(request).not.toHaveProperty('originKind');
      expect(request).not.toHaveProperty('pendingFirstInput');
      return { type: 'success', sessionId: 'session-created' };
    });
    await expect(createSpawnedSession({ ...params, originKind: 'discussion', discussionParticipant, discussionParticipantLaunch,
      accountSettings: accountSettingsParse({}), sessionCreationCorrespondence: correspondence }))
      .resolves.toMatchObject({ disposition: 'created', sessionId: 'session-created' });
  });

  it('revalidates current Discussion ownership before accepting an authenticated creation-tag rejoin', async () => {
    const discussionParticipant = { discussionId: 'discussion', participantSlotId: 'slot' };
    const discussionParticipantLaunch = { executionTarget: { serverId: 'home', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/repo' }, agentTarget: params.agentTarget! };
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({ ...sessionCreationCorrespondence,
      recipe: { ...sessionCreationCorrespondence.recipe, discussionParticipant } });
    const envelopes = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { path: '/repo', host: 'host', sessionCreationCorrespondenceV1: correspondence } });
    const session = { id: 'session-existing', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadataLayoutVersion: envelopes.metadataLayoutVersion, metadata: envelopes.sharedMetadata.ciphertext,
      ownerMetadata: envelopes.ownerMetadata, metadataVersion: 1, encryptionMode: 'plain',
      agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
    let participantCurrent = true;
    vi.mocked(axios.post).mockImplementation(async url => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [session] } };
      if (String(url).endsWith('/v1/sessions')) return participantCurrent
        ? { status: 200, data: { session, created: false } }
        : { status: 403, data: { error: 'session-origin-forbidden' } };
      throw new Error(`Unexpected Discussion rejoin request ${url}`);
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    await expect(createSpawnedSession({ ...params, originKind: 'discussion', discussionParticipant, discussionParticipantLaunch,
      sessionCreationCorrespondence: correspondence })).resolves.toMatchObject({ disposition: 'rejoined', sessionId: session.id });
    participantCurrent = false;
    await expect(createSpawnedSession({ ...params, originKind: 'discussion', discussionParticipant, discussionParticipantLaunch,
      sessionCreationCorrespondence: correspondence })).rejects.toThrow();
    // Omitting fresh birth fields must not bypass current admission for an
    // authenticated immutable recipe that still belongs to the Discussion.
    await expect(createSpawnedSession({ ...params, sessionCreationCorrespondence: correspondence })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['restored', 'unavailable', 'different-session', 'stopped', 'stopped-prior-failure', 'legacy-stopped', 'resume-only', 'resume-only-input'] as const)(
    'restores an archived same-key candidate through ordinary tag rejoin before success (%s)', async (outcome) => {
    const stopped = outcome === 'stopped' || outcome === 'stopped-prior-failure';
    const resumeOnly = outcome === 'resume-only' || outcome === 'resume-only-input';
    let admittedInputs = 0;
    const envelopes = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { path: '/repo', host: 'host', sessionCreationCorrespondenceV1: sessionCreationCorrespondence,
        ...(outcome === 'legacy-stopped' ? { hostPid: 123 } : {}) } });
    const session = { id: 'session-existing', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      ...(stopped || outcome === 'legacy-stopped' || resumeOnly ? {
        runtimeActivityState: stopped ? 'idle' : 'unknown', runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: stopped ? 1 : null,
        runtimeActivityRevision: stopped ? 2 : 0,
      } : {}),
      archivedAt: 123, metadataLayoutVersion: envelopes.metadataLayoutVersion, metadata: envelopes.sharedMetadata.ciphertext,
      ownerMetadata: envelopes.ownerMetadata, metadataVersion: 1, encryptionMode: 'plain',
      agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
    vi.mocked(axios.post).mockImplementation(async (url, body) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [session] } };
      if (String(url).endsWith('/pending')) { admittedInputs += 1; return { status: 200, data: { didWrite: true } }; }
      if (String(url).endsWith('/v1/sessions')) {
        expect(body).toMatchObject({ tag: sessionCreationTag,
          ownerMetadata: { t: 'plain', v: { system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence } } } });
        if (outcome === 'unavailable') return { status: 503, data: { error: 'service_unavailable' } };
        return { status: 200, data: { created: false, session: { ...session, archivedAt: null,
          id: outcome === 'different-session' ? 'unexpected-successor' : session.id } } };
      }
      throw new Error(`Unexpected archived rejoin request ${url}`);
    });
    vi.mocked(axios.get).mockRejectedValue(new Error('Mutable organization placement unavailable'));
    fetchSessionById.mockResolvedValue({ ...session, archivedAt: null });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));

    const result = createSpawnedSession({ ...params, ...(resumeOnly ? { resumeOnly: true } : {}),
      ...(outcome === 'resume-only-input' ? { initialInput: { text: 'Wait for confirmed startup' },
        buildInitialInputHandoff: (localId: string) => buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller: { kind: 'host' }, callerSurface: 'cli', localId }),
        machineAdmissionTransport: async (request: { localId: string }) => { admittedInputs += 1; return { status: 'accepted' as const, localId: request.localId }; },
      } : {}),
      ...(outcome === 'stopped-prior-failure' ? { initialInput: { text: 'Must wait for explicit Resume' },
        buildInitialInputHandoff: (localId: string) => buildSessionSpawnInitialInputAdmissionForLocalIdV1({ actionCaller: { kind: 'host' }, callerSurface: 'cli', localId }),
        previousSessionCreationFailure: { type: 'error' as const, code: 'spawn_failed' as const,
        retryable: true, launchError: { kind: 'launch_error' as const, code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          message: 'A later Session projection could not be read' } } } : {}),
    });
    if (outcome === 'restored' || outcome === 'stopped' || outcome === 'legacy-stopped' || outcome === 'resume-only') {
      await expect(result).resolves.toMatchObject({ disposition: 'rejoined', sessionId: session.id,
        session: { id: session.id, archivedAt: null } });
    } else if (outcome === 'resume-only-input') {
      await expect(result).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    } else if (outcome === 'stopped-prior-failure') {
      await expect(result).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        details: { errorDetail: { kind: 'launch_error', message: 'A later Session projection could not be read' } } });
    } else if (outcome === 'different-session') {
      await expect(result).rejects.toMatchObject({ code: 'creation_conflict' });
    } else {
      await expect(result).rejects.toThrow('Unexpected status from /v1/sessions: 503');
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(admittedInputs).toBe(0);
  });

  it('reconciles an uncertain archived restore by the original creation key before resending', async () => {
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: machineSnapshot } };
      if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
      throw new Error(`Unexpected archived restore HTTP read ${url}`);
    });
    let row: Record<string, unknown> | null = null;
    let loseRestoreResponse = false;
    const creationTags: unknown[] = [];
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: row ? [row] : [] } };
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected creation request ${url}`);
      const input = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields> & { tag: string };
      creationTags.push(input.tag);
      row = { id: 'session-created', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
        metadata: input.sharedMetadata.ciphertext, ownerMetadata: input.ownerMetadata, encryptionMode: 'plain',
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null };
      if (loseRestoreResponse) throw Object.assign(new Error('Creation response lost'), { code: 'ECONNABORTED' });
      return { status: 200, data: { session: row, created: creationTags.length === 1 } };
    });
    const executor = createActionExecutor(createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
      machineActionDirectTargetTransport: createCreationAdmissionMachineTransport('machine-1'),
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'uncertain-restore', executionTarget: { serverId: 'home-a', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: params.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
      attestedContext: { externalPrincipalId: 'fixture-principal', sourceMessageId: 'fixture-message' },
    });
    const context = { surface: 'plugin' as const, authority: 'account_automation' as const, serverId: 'home-a',
      actionCaller: { kind: 'plugin' as const, pluginId: 'happier.channels' } };
    expect(await executor.execute('session.spawn_new', input, context))
      .toMatchObject({ ok: true, result: { type: 'success', sessionId: 'session-created' } });
    const readRow = (): Record<string, unknown> | null => row;
    const committedRow = readRow();
    if (!committedRow) throw new Error('Initial Session was not committed');
    row = { ...committedRow, archivedAt: 123 };
    loseRestoreResponse = true;
    const uncertain = await executor.execute('session.spawn_new', input, context);
    if (!uncertain.ok) throw new Error('Uncertain creation lost its Action result');
    expect(SessionSpawnNewResultV1Schema.parse(uncertain.result))
      .toEqual({ type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' });
    expect(await executor.execute('session.spawn_new', input, context)).toMatchObject({ ok: true,
      result: { type: 'success', disposition: 'rejoined', sessionId: 'session-created' } });
    expect(creationTags).toHaveLength(2);
    expect(creationTags[1]).toBe(creationTags[0]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rejoins an existing creation without preparing unavailable changed trigger drafts', async () => {
    const envelopes = buildSessionMetadataEnvelopeCreateFields({ credentials: params.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { path: '/repo', host: 'host', sessionCreationCorrespondenceV1: sessionCreationCorrespondence } });
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { sessions: [{
      id: 'session-existing', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadataLayoutVersion: envelopes.metadataLayoutVersion, metadata: envelopes.sharedMetadata.ciphertext,
      ownerMetadata: envelopes.ownerMetadata, metadataVersion: 1, encryptionMode: 'plain',
      agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null,
    }] } });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
    const prepareInitialTriggers = vi.fn(async () => {
      throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    });
    await expect(createSpawnedSession({ ...params, prepareInitialTriggers })).resolves.toMatchObject({
      disposition: 'rejoined', sessionId: 'session-existing',
    });
    expect(prepareInitialTriggers).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a predecessor without current spawn capabilities before any remote birth', async () => {
    const initialTriggers = [SessionInitialTriggerAdmissionV1Schema.parse({
      automationId: 'automation-initial', name: 'Prepare workspace', enabled: true,
      workflowDefinitionId: 'builtin:review-and-converge', assignments: [{ machineId: 'machine-1', enabled: true }],
      executionRecipe: { v: 2, templateVersion: 0, triggerEvidence: null,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } },
      triggers: [{ triggerId: 'trigger-initial', trigger: { kind: 'sessionLifecycle', enabled: true,
        events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    })];
    vi.mocked(axios.get).mockResolvedValue({ status: 404, data: {} });
    const { directTransport: _directTransport, sessionCreationTag: _tag,
      sessionCreationCorrespondence: _correspondence, ...remoteParams } = params;
    await expect(createSpawnedSession({ ...remoteParams, initialTriggers })).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    });
    expect(axios.post).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses ordinary Bot creation with Instructions when the predecessor publishes no spawn capability', async () => {
    const serverId = configuration.activeServerId;
    const promptStack = [{ id: 'session.instructions',
      ref: { kind: 'doc', serverId, artifactId: 'instructions' },
      enabled: true, required: true, placement: 'system_append' }] as const;
    const predecessor = { ...ExternalActionMachineBootstrapV1Schema.parse({
      id: 'machine-1', kind: 'persistent',
      active: true, managedMachineRef: null, revokedAt: null, replacedByMachineId: null,
    }), storageMode: 'plain' };
    vi.mocked(axios.get).mockImplementation(async url => ({ status: 200,
      data: String(url).endsWith('/v1/machines') ? [predecessor] : { machine: predecessor } }));
    // The observed 0.2 predecessor has no capability projection producer.
    // Ordinary Action admission already refuses that real shape before dispatch.
    socketBoundary.create.mockImplementation(() => { throw new Error('predecessor_rpc_dispatched'); });
    // This is a remote, unmanaged Machine. Keep the real inventory reader and
    // supply its Account HTTP boundary before testing predecessor capabilities.
    vi.mocked(axios.request).mockImplementation(async request => {
      if (String(request.url).endsWith('/v1/home/governance/get')) return { status: 200, data: { homeDefaults: null } };
      expect(request.url).toBe('https://home-a.example.test/v1/machines/managed/actions/list');
      return { status: 200, data: { machines: [] } };
    });
    const account = createAccountServerActionDeps({ token: params.credentials.token, credentials: params.credentials,
      serverId, serverIdentityId: 'srv_creation_admission', serverHttpBaseUrl: 'https://home-a.example.test' });
    const { executor } = createCliActionExecutorHarness({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId, serverIdentityId: 'srv_creation_admission', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
    }, { managedMachineAction: account.managedMachineAction });
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'predecessor-bot-instructions', executionTarget: { serverId, machineId: 'machine-1' },
      directory: { kind: 'managed' }, agentTarget: sessionCreationCorrespondence.recipe.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, promptStack,
      identity: { bot: { kind: 'bot' }, createdAsBot: true },
    });
    const predecessorResult = await executor.execute('session.spawn_new', input, {
      surface: 'cli', authority: 'present_user', serverId,
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: 'predecessor-bot-instructions',
    });
    expect(predecessorResult, JSON.stringify(predecessorResult)).toMatchObject({ ok: false,
      errorCode: 'incompatible_target', details: { type: 'error', code: 'incompatible_target', retryable: false,
        incompatibleTarget: { reason: 'session_spawn_protocol_unavailable' } } });
    expect(axios.post).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(socketBoundary.create).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves fresh committed creation with truthful nested input when currentness is unavailable (input=%s)', async (withInput) => {
    const result = await createSpawnedSession({
      ...params,
      ...(withInput ? {
        initialInput: { text: 'Hello' },
        buildInitialInputHandoff: (localId: string) => buildSessionSpawnInitialInputAdmissionForLocalIdV1({
          actionCaller: { kind: 'host' }, callerSurface: 'cli', localId,
        }),
      } : {}),
    });
    expect(result).toMatchObject({
      sessionId: 'session-created', disposition: 'created',
      initialInput: withInput
        ? { status: 'outcomeUnknown', localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag }), code: 'session_input_action_execution_failed' }
        : { status: 'notRequested' },
    });
  });

  it('still refuses an unauthenticated rejoined Session after spawn settlement', async () => {
    spawn.mockResolvedValue({
      success: true, sessionId: 'session-created',
      sessionCreationOutcome: { disposition: 'rejoined', organizationPlacement: { folderId: null, tagIds: [] } },
    });
    await expect(createSpawnedSession(params)).rejects.toMatchObject({ code: 'SESSION_WEBHOOK_TIMEOUT' });
  });

  it('parks known Session visibility and re-reads it after reconnect', async () => {
    vi.useFakeTimers();
    const session = await fetchSessionById();
    fetchSessionById.mockClear();
    fetchSessionById.mockResolvedValue(null);
    const result = createSpawnedSession(params);
    await vi.advanceTimersByTimeAsync(0);
    const baselineReads = fetchSessionById.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSessionById).toHaveBeenCalledTimes(baselineReads);
    fetchSessionById.mockResolvedValue(session);
    const socket = socketBoundary.create.mock.results[0]?.value;
    socket.trigger('connect');
    await expect(result).resolves.toMatchObject({ sessionId: 'session-created', disposition: 'created' });
    expect(socket.getHandler('connect')).toBeUndefined();
  });
});
