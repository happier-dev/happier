import { AxiosError, AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSocketTransportAdapter, markRpcRequestDisposition } from '@happier-dev/sync-client';
import axios from 'axios';

import {
  buildSessionSpawnInitialInputLocalIdV1,
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
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
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionSpawnNewActionResultV1Schema, SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createWorkflowRequesterCustody, listWorkflowRequesterCredentialScopes } from '@/daemon/workflows/requesterCustody';
import { configuration } from '@/configuration';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createSpawnedSession } from './createSpawnedSession';
import { submitSpawnInitialInput } from './submitSpawnInitialInput';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from './sessionInputAdmissionIdentity';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

// Only HTTP/authentication and exact-machine transport boundaries are replaced;
// lookup decoding, creation settlement and Message admission remain real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: vi.fn(), get: vi.fn(), isAxiosError: actual.default.isAxiosError } };
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
vi.mock('@/api/session/sockets', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createUserScopedSocketConnection: () => {
    const socket = socketBoundary.create();
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

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

  beforeEach(() => {
    vi.clearAllMocks();
    socketBoundary.create.mockReturnValue(Object.assign(new EventEmitter(), {
      connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
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

  it.each(['prepared', 'incompatible'] as const)('resolves the managed target directory before preparing deferred Template birth triggers (%s target)', async targetReply => {
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
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: {
        id: 'machine-1', revokedAt: null, replacedByMachineId: null,
        operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3, 4] } },
        operationProtocolCapabilitiesRevision: 1,
      } } };
      throw new Error(`Unexpected managed trigger HTTP read ${url}`);
    });
    let birthTriggers: unknown;
    let birthOwnerMetadata: unknown;
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
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
    const attribution = { serverId: 'home-a', accountId: 'guest', machineId: 'machine-1', installationId: 'installation' };
    const deps = createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
      workflowRequesterCustody: createWorkflowRequesterCustody({ happyHomeDir: custodyHome, attribution,
        credentials: params.credentials, serverHttpBaseUrl: 'https://home-a.example.test' }),
      machineActionDirectTargetTransport: targetReply === 'prepared'
        ? createLocalMachineActionTransportFixture('machine-1')
        : { machineId: 'machine-1', invoke: async method => {
          // The real RPC transport may return malformed data. Keep the typed
          // local preparation owner truthful and exercise its receiver parser.
          if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
            || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) return undefined;
          throw new Error(`Unexpected managed trigger RPC ${method}`);
        } },
      ...(targetReply === 'prepared' ? { sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        // Exact Machine transport boundary delegates to the real target owner;
        // no Workflow or directory logic is mocked.
        prepare: (request: Parameters<typeof prepareSessionCreationTarget>[0]['request']) => prepareSessionCreationTarget({ request, activeServerDir: targetHome }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      } } : {}),
    });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-birth-authorization', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'owner', serverIdentityId: 'home-a', machineId: 'machine-1', installationId: 'installation-1',
      actionId: 'template.instantiate', requestId: 'managed-trigger-template', target: { kind: 'machine', machineId: 'machine-1' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey,
      executionTarget: { serverId: 'home-a', machineId: 'machine-1' }, directory: { kind: 'managed' },
      agentTarget: sessionCreationCorrespondence.recipe.agentTarget, connectedServices: { v: 2, bindingsByServiceId: {} },
      memoryEnabled: false, initialTriggers: [{
        target: { kind: 'inline', definition: getWorkflowStarterExamplesV1().find(item => item.key === 'memory-upkeep-in-session')!.definition },
        executionTarget: { kind: 'session' }, trigger: { kind: 'schedule', enabled: true,
          schedule: { kind: 'cron', scheduleExpr: '0 9 * * 0', everyMs: null, timezone: null } },
      }],
    });
    if (!deps.sessionSpawnNew) throw new Error('Canonical spawn dependency is unavailable');
    const result = await deps.sessionSpawnNew({ ...input, creationKey, sessionCreationTag: tag,
      actionCaller: { kind: 'host' }, callerSurface: 'cli', actionRequestId: 'managed-trigger-template',
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a',
        externalActionExecutionAuthorization: authorization,
        originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'managed-trigger-template',
          input: {}, target: { kind: 'machine', machineId: 'machine-1' } }) },
    }, {
      beforeLaunch: async () => { throw new Error('Refused birth must not reach content preparation'); },
      hostOnboarding: { templateName: 'Managed helper', templateVersion: '1.0.0' },
    });
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
    expect(birthOwnerMetadata).toMatchObject({ t: 'plain', v: { workspace: { sessionDirectoryV1: { v: 1, kind: 'managed' } } } });
    expect(birthOwnerMetadata).not.toMatchObject({ t: 'plain', v: { workspace: { path: expectedTarget.directory } } });
    expect(spawn).not.toHaveBeenCalled();
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
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
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

  it('delivers sealed initial triggers to the exact daemon birth owner', async () => {
    const initialTriggers = [SessionInitialTriggerAdmissionV1Schema.parse({
      automationId: 'automation-initial', name: 'Prepare workspace', enabled: true,
      workflowDefinitionId: 'builtin:review-and-converge', assignments: [{ machineId: 'machine-1', enabled: true }],
      executionRecipe: { v: 2, templateVersion: 0, triggerEvidence: null,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } },
      triggers: [{ triggerId: 'trigger-initial', trigger: { kind: 'sessionLifecycle', enabled: true,
        events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    })];
    await expect(createSpawnedSession({ ...params, prepareInitialTriggers: async () => initialTriggers })).resolves.toMatchObject({
      sessionId: 'session-created', disposition: 'created',
    });
    expect(spawn.mock.calls[0]![0]).toMatchObject({ initialTriggers });
  });

  it.each(['returned', 'thrown'] as const)('preserves a confirmed Home rollback through plugin spawn and rejoins the same birth after retry (%s)', async responseKind => {
    const attestedContext = { externalPrincipalId: 'principal-rollback', sourceMessageId: 'message-rollback' };
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })),
    { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.mocked(axios.get).mockImplementation(async (url) => {
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
      sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
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
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
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
      })).toMatchObject({ ok: false, errorCode: 'session_attested_context_forbidden' });
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
      const mcp = new McpServer({ name: 'attested-birth', version: '1' });
      mcp.registerTool('identity', {}, async () => {
        received.push(request.headers);
        return { content: [{ type: 'text', text: JSON.stringify(request.headers) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
        metadata: { path: '/repo', host: 'host', ...request.identity,
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
      machineActionDirectTargetTransport: createLocalMachineActionTransportFixture('machine-1'),
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'bot-weekly-upkeep', executionTarget: { serverId: 'home-a', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: sessionCreationCorrespondence.recipe.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
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
      executionRecipe: { v: 2, workflow: { t: 'plain', v: { inlineDefinition: example.definition, executionTarget: { kind: 'session' } } } },
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
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: 'existing' } });
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
      sessionSpawnDirectTargetTransport: {
        machineId: 'machine-1',
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
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { machine: {
      id: 'machine-1', kind: 'persistent', storageMode: 'plain',
      revokedAt: null, replacedByMachineId: null,
    } } });
    // The observed 0.2 predecessor has no capability projection producer.
    // Ordinary Action admission already refuses that real shape before dispatch.
    socketBoundary.create.mockImplementation(() => { throw new Error('predecessor_rpc_dispatched'); });
    const executor = createActionExecutor(createCliActionDeps({
      token: params.credentials.token, credentials: params.credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId, serverHttpBaseUrl: 'https://home-a.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
    }));
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'predecessor-bot-instructions', executionTarget: { serverId, machineId: 'machine-1' },
      directory: { kind: 'managed' }, agentTarget: sessionCreationCorrespondence.recipe.agentTarget,
      connectedServices: { v: 2, bindingsByServiceId: {} }, promptStack,
      identity: { bot: { kind: 'bot' }, createdAsBot: true },
    });
    expect(await executor.execute('session.spawn_new', input, {
      surface: 'cli', authority: 'present_user', serverId,
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: 'predecessor-bot-instructions',
    })).toMatchObject({ ok: true, result: { type: 'error', code: 'incompatible_target', retryable: false } });
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
    socket.emit('connect');
    await expect(result).resolves.toMatchObject({ sessionId: 'session-created', disposition: 'created' });
    expect(socket.eventNames()).toEqual([]);
  });

  it.each([false, true])('commits ordinary Bot birth and awaits content preparation before dispatching its runner (retry: %s)', async retry => {
    const keys = nacl.sign.keyPair();
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-birth-authorization', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'owner', serverIdentityId: 'home', machineId: 'machine-1', installationId: 'installation-1',
      actionId: 'template.instantiate', requestId: 'template-birth', target: { kind: 'machine', machineId: 'machine-1' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const child = { actionId: 'session.spawn_new', role: 'create_bot', inputDigest: 'b'.repeat(43) };
    const signed = { authorizationToken: authorization.token, effectActionId: 'session.spawn_new',
      target: authorization.binding.target, installationId: authorization.binding.installationId,
      requestId: authorization.binding.requestId, method: 'POST', path: '/v1/sessions', reviewedChild: child };
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    const events: string[] = [];
    let committed: Record<string, unknown> | null = null;
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
      throw new Error(`Unexpected HTTP read ${url}`);
    });
    vi.mocked(axios.post).mockImplementation(async (url, raw, config) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected HTTP write ${url}`);
      expect(verifyExternalActionMachineRequestV1({ ...signed, body: raw, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      const input = raw as ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>;
      events.push('birth');
      committed = {
        id: 'session-created', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
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
      expect(request).toMatchObject({ existingSessionId: 'session-created', freshSessionCreation: !retry });
      expect(events).toEqual(retry ? ['birth', 'content', 'content', 'launch'] : ['birth', 'content', 'launch']);
      return { type: 'success', sessionId: 'session-created' };
    });
    let failPreparation = retry;
    const preparedParams = { ...params,
      authorizeCreationRequest: (body: unknown) => createExternalActionAuthorizedRequestHeaders({ authorization,
        effectActionId: 'session.spawn_new', target: authorization.binding.target, installationId: signed.installationId,
        method: 'POST', path: '/v1/sessions', body, reviewedChild: child, privateKey: keys.secretKey }),
      beforeLaunch: async birth => {
        expect(birth).toMatchObject({ sessionId: 'session-created', metadataRevision: 1 });
        await Promise.resolve();
        events.push('content');
        if (failPreparation) throw new Error('Content boundary unavailable');
      },
    } satisfies Parameters<typeof createSpawnedSession>[0];
    if (retry) {
      await expect(createSpawnedSession(preparedParams)).rejects.toMatchObject({ details: { sessionId: 'session-created' } });
      expect(spawn).not.toHaveBeenCalled();
      failPreparation = false;
    }
    const result = await createSpawnedSession(preparedParams);
    expect(result).toMatchObject({ disposition: retry ? 'rejoined' : 'created', sessionId: 'session-created' });
    expect(events.filter(event => event === 'birth')).toHaveLength(1);
  });


  it.each([false, true])('commits an asleep managed Bot without inventing a remote path or dispatching a runner and rejoins its birth (private carrier: %s)', async privateCarrier => {
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
    const sessionId = privateCarrier ? 'session-private-birth' : 'session-deferred-birth';
    let committed: Record<string, unknown> | null = null;
    let births = 0;
    let requests = 0;
    let returnedAuthorization = false;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-birth-authorization', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'owner', serverIdentityId: 'home', machineId: 'machine-1', installationId: 'installation-1',
      actionId: 'template.instantiate', requestId: 'template-birth', target: { kind: 'machine', machineId: 'machine-1' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const carrier = { authorization, originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse({ v: 1,
      requestId: 'template-birth', input: {}, target: { kind: 'machine', machineId: 'machine-1' } }) };
    const birthAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, templateRequesterBirth: { sessionId, creationTag: sessionCreationTag } } });
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).includes('/v1/access-keys/')) {
        if (privateCarrier) throw new Error('The finite birth transaction already owns the Machine binding');
        return { status: 200, data: { accessKey: 'existing' } };
      }
      throw new Error(`Unexpected HTTP read ${url}`);
    });
    vi.mocked(axios.post).mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: committed ? [committed] : [] } };
      if (!String(url).endsWith('/v1/sessions')) throw new Error(`Unexpected HTTP write ${url}`);
      requests++;
      if (privateCarrier) expect(raw).toMatchObject({ templateRequesterAuthorization: carrier });
      if (committed) return { status: 200, headers: { [TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1]:
        encodeTemplateBirthExecutionAuthorizationV1(birthAuthorization) }, data: { created: false, session: committed } };
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
      return { status: 200, headers: { [TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1]:
        encodeTemplateBirthExecutionAuthorizationV1(birthAuthorization) }, data: { created: true, session: committed } };
    });
    const deferred = { ...params, directory: undefined, directoryKind: 'managed' as const, deferLaunch: true as const,
      sessionCreationCorrespondence: SessionCreationCorrespondenceV1Schema.parse({ ...sessionCreationCorrespondence,
        recipe: { ...sessionCreationCorrespondence.recipe, execution: { machineId: 'machine-1', directory: { kind: 'managed' } } } }),
      ...(privateCarrier ? { templateRequesterAuthorization: carrier,
        onCreationAuthorization: (proof: typeof authorization) => { expect(proof).toEqual(birthAuthorization); returnedAuthorization = true; } } : {}),
      beforeLaunch: async () => { if (privateCarrier) expect(returnedAuthorization).toBe(true); },
    };
    const first = await createSpawnedSession(deferred);
    returnedAuthorization = false;
    const second = await createSpawnedSession({ ...deferred, ...(privateCarrier ? { resumeOnly: true } : {}) });
    expect(first).toMatchObject({ disposition: 'created', sessionId });
    expect(second).toMatchObject({ disposition: 'rejoined', sessionId });
    expect(births).toBe(1);
    expect(requests).toBe(privateCarrier ? 2 : 1);
    expect(spawn).not.toHaveBeenCalled();
  });

});
