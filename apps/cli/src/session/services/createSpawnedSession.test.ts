import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';

import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { configuration } from '@/configuration';

const spawnDaemonSession = vi.hoisted(() => vi.fn());
const resolveDaemonSpawnSessionByNonce = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());
const getOrCreateSessionByTag = vi.hoisted(() => vi.fn());
const lookupSessionsByTags = vi.hoisted(() => vi.fn());
const fetchSessionOrganizationPlacement = vi.hoisted(() => vi.fn());
const validateStoredAuthTokenAgainstActiveServer = vi.hoisted(() => vi.fn());
const sendSessionMessage = vi.hoisted(() => vi.fn());
const callMachineRpc = vi.hoisted(() => vi.fn());
const requestSessionStop = vi.hoisted(() => vi.fn());
const archiveSessionOnceInactive = vi.hoisted(() => vi.fn());
const archiveSessionByIdBestEffort = vi.hoisted(() => vi.fn());
const fetchAccountEncryptionCurrentness = vi.hoisted(() => vi.fn());
const updateSessionMetadataWithRetry = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  getOrCreateSessionByTag,
  lookupSessionsByTags,
  fetchSessionOrganizationPlacement,
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness,
}));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));
vi.mock('@/utils/logger', () => ({
  logger: { warn: loggerWarn },
}));

vi.mock('./sendSessionMessage', () => ({ sendSessionMessage }));
vi.mock('./requestSessionStop', () => ({ requestSessionStop }));
vi.mock('./archiveSessionOnceInactive', () => ({ archiveSessionOnceInactive }));
vi.mock('./setSessionArchivedState', () => ({ archiveSessionByIdBestEffort }));

import { createSpawnedSession, type CreateSpawnedSessionParams } from './createSpawnedSession';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import {
  ConnectedServiceMaterializationIdentityV1Schema,
  ProviderConnectionIdSchema,
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionCreationCorrespondenceV1Schema,
  SessionOwnerMetadataV1Schema,
  deriveSessionCreationTagV1,
  buildSessionSpawnInitialInputLocalIdV1,
  snapshotSessionRolesAtSpawnV1,
  createSessionOwnerMetadataV1,
  BUILT_IN_ROLES_V1,
  type SessionInitialAccessDraftV1,
  admitAgentStartV1,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from './sessionInputAdmissionIdentity';
import { createProductionFreshWorkflowSessionConversation } from '@/daemon/workflows/sessionStepExecutor';
import { readSessionWorkspaceWritesV1, type ResolvedRoleV1 } from '@happier-dev/protocol';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { registerPrivateSpawnSessionRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { RpcHandler } from '@/api/rpc/types';
import { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { prepareWorkflowAcceptedWorkspaceTarget } from '@/daemon/workflows/resolveWorkflowWorkspace';
import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import { WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

const initialAccess: SessionInitialAccessDraftV1 = {
  grants: [{ subject: { kind: 'team', teamId: 'team-1' }, accessLevel: 'edit', canApprovePermissions: false }],
};

describe('createSpawnedSession settlement', () => {
  const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
  };
  const providerConnectionId = ProviderConnectionIdSchema.parse('pc_work');
  const creationOutcome = {
    disposition: 'created' as const,
    organizationPlacement: { folderId: null, tagIds: [] },
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  beforeEach(() => {
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    lookupSessionsByTags.mockReset();
    fetchSessionOrganizationPlacement.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    sendSessionMessage.mockReset();
    callMachineRpc.mockReset();
    requestSessionStop.mockReset();
    archiveSessionOnceInactive.mockReset();
    archiveSessionByIdBestEffort.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();
    updateSessionMetadataWithRetry.mockReset();
    loggerWarn.mockReset();
    sendSessionMessage.mockResolvedValue({ ok: true, sessionId: 'session-created', localId: 'local-1', waited: false });
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid' });
    requestSessionStop.mockResolvedValue({ ok: true, sessionId: 'session-abandoned', stopped: true });
    archiveSessionOnceInactive.mockResolvedValue({ archivedAt: 123 });
    archiveSessionByIdBestEffort.mockResolvedValue(undefined);
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1 });
    lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
  });

  it('requires an exact machine target instead of falling back to daemon-local spawn', async () => {
    const withoutMachineTarget = {
      credentials,
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    } as unknown as CreateSpawnedSessionParams;

    await expect(createSpawnedSession(withoutMachineTarget)).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });

    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(validateStoredAuthTokenAgainstActiveServer).not.toHaveBeenCalled();
  });

  it.each(['session', 'run_step'] as const)('inherits the lead Context memory at %s birth without copying instructions or Bot identity', async (originKind) => {
    const plainCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'context-owner' })).toString('base64url')}.signature`, encryption: null };
    const memory = { id: 'session.memory', ref: { kind: 'doc' as const, artifactId: 'lead-memory' }, enabled: true, placement: 'system_append' as const };
    const instruction = { ...memory, id: 'session.instructions', ref: { kind: 'doc' as const, artifactId: 'lead-instructions' } };
    const lead = createSessionRecordFixture({ id: 'context-lead', encryptionMode: 'plain', machineId: 'machine-1',
      metadata: JSON.stringify({ path: '/repo', machineId: 'machine-1', bot: { kind: 'bot' }, createdAsBot: true,
        work: { memoryEnabled: true, promptStack: [instruction, memory] } }),
      effectiveAccess: { level: 'owner', capabilities: { readTranscript: true, readOwnerMetadata: true } },
    });
    fetchSessionById.mockResolvedValue(lead);
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(plainCredentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [] } } }], tombstones: [], diagnostics: [] } });
    const read = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/artifacts')) return { status: 200, data: [
        ['lead-memory', 'memory_doc.v1'], ['lead-instructions', 'prompt_doc.v2'],
      ].map(([id, kind]) => ({ id, header: encodePlainArtifactStoredContent({ v: 1, kind, title: id }), body: null,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 })) };
      throw new Error(`Unexpected inheritance read: ${url}`);
    });
    const spawn = vi.fn(async () => ({ type: 'success', sessionId: 'context-worker', sessionCreationOutcome: creationOutcome }));
    try {
      await createSpawnedSession({ credentials: plainCredentials, directory: '/worker', machineId: 'machine-1',
        accountSettings: {}, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        originKind, originSessionId: 'context-lead', ...(originKind === 'session' ? { reportsTo: { sessionId: 'context-lead' } } : { originRunId: 'workflow-run' }),
        directTransport: { spawn, resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' }) } });
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({ memoryEnabled: true,
        promptStack: [{ ...memory, ref: { ...memory.ref, serverId: configuration.activeServerId } }] });
      expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('identity');
      expect(JSON.stringify(spawn.mock.calls[0]?.[0])).not.toContain('lead-instructions');
    } finally { read.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([undefined, { sessionSpawn: { protocolVersions: [1] } }])(
    'refuses a remote role-bearing spawn before creation when the target lacks current spawn support (%j)',
    async (operationProtocolCapabilities) => {
      getOrCreateSessionByTag.mockClear();
      const machineRead = vi.spyOn(axios, 'get').mockResolvedValue({
        status: 200,
        data: {
          machine: {
            id: 'machine-1', revokedAt: null, replacedByMachineId: null,
            operationProtocolCapabilitiesRevision: 1,
            ...(operationProtocolCapabilities ? { operationProtocolCapabilities } : {}),
          },
        },
      });
      try {
        await expect(createSpawnedSession({
          credentials,
          machineId: 'machine-1',
          directory: '/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          initialSessionRolesV1: {
            ...snapshotSessionRolesAtSpawnV1({
              leadSessionId: 'lead-session',
              roles: { builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' } },
            }),
            roleId: 'builder',
          },
        })).rejects.toMatchObject({
          code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          details: {
            kind: 'update_required', operation: 'session.spawn_new', component: 'daemon',
            reason: 'session_roles_snapshot_update_required',
          },
        });
        expect(callMachineRpc).not.toHaveBeenCalled();
        expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
      } finally {
        machineRead.mockRestore();
      }
    },
  );

  it('submits the initial input through Message admission after spawn settlement and never through the daemon spawn request', async () => {
    const cancellation = new AbortController();
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'accepted' as const,
      localId: 'local-1',
    }));
    const agentSessionStartupInstructionsV1 = {
      v: 1,
      id: 'happier.global_voice_agent',
      revision: 2,
      instructions: 'Apply the approved Global Voice developer instructions.',
    } as const;
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-1',
    });
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'session-created',
      localId: 'local-1',
      waited: false,
      admissionResult: {
        status: 'accepted' as const,
        localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag }) ?? 'local-1',
      },
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: {
          v: agentSessionStartupInstructionsV1.v,
          id: agentSessionStartupInstructionsV1.id,
          revision: agentSessionStartupInstructionsV1.revision,
        },
        checkout: null,
      },
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-created',
      sessionCreationOutcome: {
        disposition: 'created',
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-created',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          workspace: { path: '/repo', host: 'host' },
          system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
        }),
      ),
    });

    const buildInitialInputHandoff = vi.fn((localId: string) => ({
      ...buildSessionSpawnInitialInputAdmissionForLocalIdV1({
        actionCaller: { kind: 'host' as const },
        callerSurface: 'cli' as const,
        localId,
      }),
      localId,
    }));

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
        updatedAt: 1,
      },
      spawnNonce: 'launch-1',
      sessionCreationTag,
      sessionCreationCorrespondence,
      organizationPlacement: { folderId: null, tagIds: [] },
      initialTitle: 'Atomic first title',
      identity: { bot: { kind: 'bot' }, createdAsBot: true },
      memoryEnabled: false,
      initialAccess,
      primaryTeamId: 'team-1',
      initialInput: { text: 'Inspect this repo' },
      agentSessionStartupInstructionsV1,
      buildInitialInputHandoff,
      machineAdmissionTransport,
      signal: cancellation.signal,
    });

    expect(result.initialInput).toEqual({
      status: 'accepted',
      localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag }),
    });

    const spawnRequest = callMachineRpc.mock.calls[0]?.[0]?.request;
    const expectedInitialInputLocalId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag });
    expect(spawnRequest).toMatchObject({
      sessionCreationTag,
      sessionCreationCorrespondence,
      initialTitle: 'Atomic first title',
      identity: { bot: { kind: 'bot' }, createdAsBot: true },
      memoryEnabled: false,
      initialAccess,
      primaryTeamId: 'team-1',
      agentSessionStartupInstructionsV1,
    });
    expect(spawnRequest).not.toHaveProperty('pendingFirstInput');
    expect(spawnRequest).not.toHaveProperty('initialPrompt');
    expect(spawnRequest).not.toHaveProperty('initialMessage');
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(buildInitialInputHandoff).toHaveBeenCalledTimes(1);
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'session-created',
      targetMachineId: 'machine-1',
      localId: expectedInitialInputLocalId,
      inputAdmission: expect.any(Object),
      requestedAction: { v: 1, kind: 'send_now' },
      machineAdmissionTransport,
    }));
    expect(fetchSessionById).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-created',
      signal: cancellation.signal,
    });
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
    }));
    expect(callMachineRpc.mock.invocationCallOrder[0]).toBeLessThan(fetchSessionById.mock.invocationCallOrder[0]);
    expect(fetchSessionById.mock.invocationCallOrder[0]).toBeLessThan(sendSessionMessage.mock.invocationCallOrder[0]);
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('launches the R19 Workflow Agent selection through the real private spawn lifecycle', async () => {
    const directory = '/home/ubuntu';
    // Only filesystem readiness and physical runner launch are replaced;
    // target preparation, Workflow creation, transport parsing and lifecycle stay real.
    const access = vi.spyOn(fs, 'access').mockResolvedValue(undefined);
    const launches: Parameters<Parameters<typeof createSpawnNewSessionLifecycleActionHandler>[0]['spawnSession']>[0][] = [];
    const handlers = new Map<string, RpcHandler>();
    registerPrivateSpawnSessionRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({
        spawnSession: async options => {
          launches.push(options);
          return { type: 'success', sessionId: 'r19-agent-session', sessionCreationOutcome: creationOutcome };
        },
      }),
    });
    callMachineRpc.mockImplementation(async ({ method, request }) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Unexpected private Machine RPC: ${method}`);
      return handler(request);
    });
    fetchSessionById.mockResolvedValue({ id: 'r19-agent-session', createdAt: 1, updatedAt: 1,
      active: true, activeAt: 1, pendingCount: 0, metadataVersion: 1, metadata: { path: directory, host: 'host' } });
    const selection = {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      acpSessionModeId: 'default',
      connectedServices: { v: 2 as const, bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': { source: 'connected' as const,
          selection: 'profile' as const, profileId: '00ae5eea-6286-48bc-b82a-30a5f8492864' },
        'happier.agent.claude/anthropic': { source: 'native' as const },
      } },
      modelSelection: { v: 1 as const, updatedAt: 1791524847849, ref: {
        agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5',
      } },
    } satisfies Parameters<ReturnType<typeof createProductionFreshWorkflowSessionConversation>>[0]['selection'];
    try {
      const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1',
        machineId: '2481f422-055e-4922-ba85-aa3253fda9e3', workDepth: 0,
        originRunId: '8d2650cf-c89a-4238-9275-0da8f42741aa',
        machineAdmissionTransport: async () => ({ status: 'accepted', localId: 'unused' }),
      });
      await expect(create({ selection, workspace: { machineId: '2481f422-055e-4922-ba85-aa3253fda9e3',
        directory, checkoutRootPath: directory },
        creationKey: 'workflow:8d2650cf-c89a-4238-9275-0da8f42741aa:be62f627-1261-48f9-a8d0-487ed7c478c9',
      })).resolves.toMatchObject({ sessionId: 'r19-agent-session' });
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ directory, agentTarget: selection.agentTarget,
        connectedServices: selection.connectedServices, modelSelection: selection.modelSelection, agentModeId: 'default',
        originKind: 'run_step', originRunId: '8d2650cf-c89a-4238-9275-0da8f42741aa', workDepth: 1 });
      expect(callMachineRpc.mock.calls[0]?.[0].request).not.toHaveProperty('backendTarget');
    } finally {
      access.mockRestore();
    }
  });

  it.each(['definite_refusal', 'lost_admission', 'uncorrelated_failure'] as const)('settles only proven no-launch Workflow failure through the real claim owner (%s)', async failure => {
    const runId = '8d2650cf-c89a-4238-9275-0da8f42741aa';
    const machineId = '2481f422-055e-4922-ba85-aa3253fda9e3';
    const accountId = 'account-1';
    const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    const directory = '/home/ubuntu';
    const access = vi.spyOn(fs, 'access').mockResolvedValue(undefined);
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, accountId,
      origin: { kind: 'automation', automationId: 'automation-1' } });
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: { inlineDefinition: {
      version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Reply only ready.', references: [], attachments: [] },
        execution: { connectedServices: { v: 2, bindingsByServiceId: {} } }, input: [], result: { kind: 'text' } }],
    }, workspace: { directory }, executionTarget: { kind: 'session' } } });
    // Private Machine transport returns a correlated refusal, or loses its
    // response after dispatch. The creator, coordinator, store and claim stay real.
    callMachineRpc.mockImplementation(async ({ method }) => {
      if (method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) return { status: 'not_found' };
      if (method !== RPC_METHODS.SPAWN_HAPPY_SESSION) throw new Error(`Unexpected RPC: ${method}`);
      if (failure === 'lost_admission') throw Object.assign(new Error('admission acknowledgement lost'), { code: 'MACHINE_RPC_TIMEOUT' });
      if (failure === 'uncorrelated_failure') throw Object.assign(new Error('uncorrelated transport validation failure'), {
        code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Selected model is unavailable for this Agent.' };
    });
    const coordinate = createProductionWorkflowRunCoordinator({ token: credentials.token, accountId, machineId,
      storage: boundary, resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness }), isAcceptedAuthorizationCurrent: async () => true,
      resolveMaterializationHost: async target => ({ effects: { resolveTargetAvailability: async () => true },
        admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
          caller: { kind: 'originless', runId: target.runId, runDepth: target.workDepth },
          baseline: { machineId, directory: target.directory }, ledSubtreeSessionIds: [],
          roles: {}, workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
        }),
      }),
      prepareAcceptedWorkspaceTarget: input => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
        pathIsDirectory: async () => true, inspectLocation: async () => null }),
      workspaceScm: { inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      onCommittedTransition: async () => {},
      execution: { credentials, serverId: 'server-1',
        machineAdmissionTransport: async () => { throw new Error('No input may follow spawn refusal'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: { execute: async () => { throw new Error('Unexpected detached execution'); } },
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) },
      },
    });
    const claimClient = { heartbeatRun: async () => {}, failRun: vi.fn(async () => {}) };
    try {
      await executeClaimedRun({ machineId, claimClient, coordinateWorkflowRun: coordinate,
        heartbeatMs: 60_000, leaseDurationMs: 120_000,
        claimed: { protocol: 'v3', accountCurrentness: witness,
          automation: { id: 'automation-1', name: 'Agent refusal', enabled: true },
          run: { id: runId, automationId: 'automation-1', attempt: 0, revision: 0,
            recipeKind: 'workflow-v2', executionInputEnvelope: definitionEnvelope,
            triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
            resultDelivery: { kind: 'none' } },
        },
      });
      const cancelAndReclaim = async () => {
        boundary.requestControl('cancel_requested');
        await executeClaimedRun({ machineId, claimClient, coordinateWorkflowRun: coordinate,
          heartbeatMs: 60_000, leaseDurationMs: 120_000,
          claimed: { protocol: 'v3', accountCurrentness: witness,
            automation: { id: 'automation-1', name: 'Agent refusal', enabled: true },
            run: { id: runId, automationId: 'automation-1', attempt: 1, revision: boundary.run().revision,
              recipeKind: 'workflow-v2', executionInputEnvelope: definitionEnvelope,
              triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
              resultDelivery: { kind: 'none' }, workflowAcceptedSnapshotEnvelope: boundary.acceptedEnvelope()! },
          },
        });
      };
      if (failure !== 'definite_refusal') {
        expect(boundary.run().state).toBe('running');
        expect(boundary.run().workflowCustodyState).toBe('pending');
        expect(boundary.rows().some(row => row.index.lifecycle === 'failed')).toBe(false);
        expect(boundary.resultEnvelope()).toBeNull();
        // Redacted R19 public progress (fin-qa19/agent-child-final.json).
        // Map only opaque row ids to the real owner-created fixture ids. No
        // Session correspondence or no-launch proof may be invented on rejoin.
        const historic = boundary.rows().find(row => row.index.parentRecordId !== null);
        if (!historic) throw new Error('Missing historic Agent invocation');
        historic.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
            recordId: historic.index.id, sequence: historic.index.sequence, parentRecordId: historic.index.parentRecordId,
            memberOrdinal: historic.index.memberOrdinal, attempt: historic.index.attempt },
          progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'step-1', scope: [] },
            blockKind: 'step', attempt: '0', input: { document: {
              text: 'Reply exactly QA-FIN19_AGENT_READY. Do not use tools, edit files, or run commands.',
              attachments: [], references: [] }, input: [] },
            workspace: { descriptor: { machineId, directory, checkoutRootPath: directory } },
            logicalInvocationRecordId: historic.index.id },
        }));
        historic.index = { ...historic.index, contentRevision: '3', lifecycle: 'cancel_requested' };
        await cancelAndReclaim();
        expect(boundary.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending' });
        expect(await boundary.execute({ operation: 'wait', runId })).toMatchObject({
          observation: 'terminal', matchedCondition: 'terminal', run: { state: 'cancelled', workflowCustodyState: 'pending' },
        });
        expect(boundary.rows().some(row => row.index.parentRecordId !== null && row.index.lifecycle === 'cancel_requested')).toBe(true);
        expect(callMachineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION)).toHaveLength(1);
        expect(claimClient.failRun).not.toHaveBeenCalled();
        return;
      }
      expect(boundary.run().state).toBe('interrupted');
      const leaf = boundary.rows().find(row => row.index.parentRecordId !== null && row.index.lifecycle === 'failed');
      expect(leaf).toBeDefined();
      if (!leaf) throw new Error('Missing proven failure');
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: leaf.index.id,
          sequence: leaf.index.sequence, parentRecordId: leaf.index.parentRecordId, memberOrdinal: leaf.index.memberOrdinal,
          attempt: leaf.index.attempt }, envelope: parseWorkflowStoredContentEnvelopeV1(leaf.contentEnvelope) });
      expect(opened).toMatchObject({ kind: 'available', content: { reason: {
        code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        message: 'Selected model is unavailable for this Agent.',
      } } });
      // An authorized cancellation follows the proven failure. Reconstruct the
      // production coordinator from stored facts; no second spawn is permitted.
      await cancelAndReclaim();
      expect(boundary.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
      expect(await boundary.execute({ operation: 'wait', runId })).toMatchObject({
        observation: 'terminal', matchedCondition: 'terminal', run: { state: 'cancelled' },
      });
      expect(boundary.rows().some(row => WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1
        .some(lifecycle => lifecycle === row.index.lifecycle))).toBe(false);
      expect(callMachineRpc).toHaveBeenCalledTimes(1);
      expect(sendSessionMessage).not.toHaveBeenCalled();
      expect(claimClient.failRun).not.toHaveBeenCalled();
    } finally { access.mockRestore(); }
  });

  it.each(['private_default', 'team_required', null] as const)('creates fresh Workflow steps with Team policy %s, accepted depth and frozen role workspace ceiling', async (policy) => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-frozen-role-'));
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: {
          id: 'team-1', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
          policy: { v: 1, sessionCreationPolicy: policy ?? 'private_default', externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null },
          viewerRole: 'owner', capabilities: NO_TEAM_CAPABILITIES_V1,
          admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
          counts: null,
        } });
    const machineRead = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { machine: {
      id: 'machine-1', revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2] } },
    } } });
    callMachineRpc.mockResolvedValue({ success: true, sessionId: 'frozen-step', sessionCreationOutcome: creationOutcome });
    fetchSessionById.mockResolvedValue({ id: 'frozen-step', createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      pendingCount: 0, metadataVersion: 1, metadata: { path: directory, host: 'host' } });
    const role: ResolvedRoleV1 = { ...BUILT_IN_ROLES_V1.reviewer, roleId: 'reviewer',
      engine: { agentTargetKey: 'agent:happier.agent.claude/claude' }, workspaceWrites: 'deny', instructions: 'Frozen review' };
    try {
      const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1', machineId: 'machine-1',
        workDepth: 2, originRunId: 'workflow-run', machineAdmissionTransport: async () => ({ status: 'accepted', localId: 'unused' }),
        ...(policy ? { visibleTeamId: 'team-1' } : {}),
      });
      await expect(create({ selection: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} }, permissionMode: 'read_only',
        launchEnvironment: { values: { OPENAI_API_KEY: 'retained-private-value', task_name: 'daily' }, unset: [] },
        providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-conversation-2' },
      }, workspace: { machineId: 'machine-1', directory, checkoutRootPath: directory },
        creationKey: 'workflow:workflow-run:invocation', frozenRole: role,
      })).resolves.toMatchObject({ sessionId: 'frozen-step' });
      const transmitted = SpawnDaemonSessionRequestSchema.parse(callMachineRpc.mock.calls[0]?.[0].request);
      expect(transmitted).toMatchObject({ workDepth: 3, originKind: 'run_step', originRunId: 'workflow-run',
        initialSessionRolesV1: { roleId: 'reviewer', sessionRoles: { reviewer: role } },
        environmentVariables: { OPENAI_API_KEY: 'retained-private-value', task_name: 'daily' },
        resume: 'native-conversation-2',
      });
      if (policy) {
        expect(transmitted.initialAccess).toEqual({ grants: [{ subject: { kind: 'team', teamId: 'team-1' }, accessLevel: 'view', canApprovePermissions: false }] });
      } else {
        expect(transmitted).not.toHaveProperty('initialAccess');
        expect(axios.request).not.toHaveBeenCalled();
      }
      if (policy === 'team_required') expect(transmitted.primaryTeamId).toBe('team-1');
      else expect(transmitted).not.toHaveProperty('primaryTeamId');
      expect(readSessionWorkspaceWritesV1({ work: { sessionRolesV1: transmitted.initialSessionRolesV1 } })).toBe('deny');
    } finally {
      machineRead.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a committed create successful when legacy metadata-label persistence fails', async () => {
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-created',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-created',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });
    updateSessionMetadataWithRetry.mockRejectedValue(
      new Error('metadata write unavailable'),
    );

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      legacyMetadataLabel: 'predecessor metadata label',
    });

    expect(result).toMatchObject({
      disposition: 'created',
      sessionId: 'session-created',
      initialInput: { status: 'notRequested' },
    });
    const spawnRequest = callMachineRpc.mock.calls[0]?.[0]?.request;
    expect(spawnRequest).not.toHaveProperty('tag');
    expect(spawnRequest).not.toHaveProperty('legacyMetadataLabel');
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      token: credentials.token,
      credentials,
      sessionId: 'session-created',
      accountEncryptionCurrentness: { mode: 'plain', version: 1 },
      rawSession: expect.objectContaining({ id: 'session-created' }),
      updater: expect.any(Function),
    }));
    expect(callMachineRpc.mock.invocationCallOrder[0]).toBeLessThan(
      updateSessionMetadataWithRetry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(fetchSessionById.mock.invocationCallOrder[0]).toBeLessThan(
      updateSessionMetadataWithRetry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    const metadataUpdater = updateSessionMetadataWithRetry.mock.calls[0]?.[0]?.updater;
    expect(metadataUpdater({ path: '/repo', host: 'host' })).toEqual({
      path: '/repo',
      host: 'host',
      tag: 'predecessor metadata label',
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Legacy metadata label compatibility write failed',
      { code: 'legacy_metadata_label_write_failed' },
    );
  });

  it('returns current organization placement for a preflight same-key rejoin when legacy metadata-label persistence fails', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-preflight',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: 'folder-1', tagIds: ['tag-1'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'session-existing',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        pendingCount: 0,
        metadataVersion: 1,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
          }),
        ),
      }],
    });
    sendSessionMessage.mockImplementation(async ({ localId }) => ({
      ok: true,
      sessionId: 'session-existing',
      localId,
      waited: false,
      admissionResult: { status: 'alreadyAccepted', localId },
    }));
    updateSessionMetadataWithRetry.mockRejectedValue(
      new Error('metadata write unavailable'),
    );
    fetchSessionOrganizationPlacement.mockResolvedValue({
      folderId: 'folder-current',
      tagIds: ['tag-current-a', 'tag-current-b'],
    });

    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'alreadyAccepted' as const,
      localId: 'plugin-input-v1:existing',
    }));
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-existing',
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag,
      sessionCreationCorrespondence,
      organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
      legacyMetadataLabel: 'predecessor metadata label',
      environmentVariables: { TOKEN: 'rejoin-value-that-must-not-dispatch' },
      initialInput: {
        text: 'Review comments:\n\n1) src/a.ts',
        reviewComments: {
          displayText: 'Review comments (1)',
          comments: [{
            id: 'draft-1', filePath: 'src/a.ts', source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['code'], beforeContext: [], afterContext: [] },
            body: 'Check this', createdAt: 1,
          }],
        },
      },
      buildInitialInputHandoff: () => initialInputAdmission,
      machineAdmissionTransport,
    });

    expect(result).toMatchObject({
      disposition: 'rejoined',
      sessionId: 'session-existing',
      organizationPlacement: {
        folderId: 'folder-current',
        tagIds: ['tag-current-a', 'tag-current-b'],
      },
      initialInput: {
        status: 'alreadyAccepted',
        localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag }),
      },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(fetchSessionOrganizationPlacement).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-existing',
    });
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'session-existing',
      targetMachineId: 'machine-1',
      messageMeta: {
        displayText: 'Review comments (1)',
        happier: {
          kind: 'review_comments.v1',
          payload: { sessionId: 'session-existing', comments: [expect.objectContaining({ id: 'draft-1' })] },
        },
      },
      localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag }),
      inputAdmission: initialInputAdmission.inputAdmission,
      requestedAction: { v: 1, kind: 'send_now' },
      machineAdmissionTransport,
    }));
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-existing',
    }));
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Legacy metadata label compatibility write failed',
      { code: 'legacy_metadata_label_write_failed' },
    );
  });

  it('fails closed for an unauthenticated same-tag candidate when Account currentness is unavailable', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-rejoin-currentness-unavailable',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: 'folder-created', tagIds: ['tag-created'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    const candidateCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/another-repository' } },
        organization: { folderId: 'folder-created', tagIds: ['tag-created'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'session-rejoin-currentness-unavailable',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        pendingCount: 0,
        metadataVersion: 1,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: candidateCorrespondence },
          }),
        ),
      }],
    });
    fetchAccountEncryptionCurrentness.mockRejectedValue(
      new Error('Account encryption currentness unavailable'),
    );
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-currentness-unavailable',
    });
    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag,
      sessionCreationCorrespondence,
      organizationPlacement: { folderId: 'folder-created', tagIds: ['tag-created'] },
      initialInput: { text: 'Keep the Session settlement' },
      buildInitialInputHandoff: () => initialInputAdmission,
    })).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      details: { spawnNonce: expect.stringMatching(/^session\.spawn_new\.creation:/u) },
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(fetchSessionOrganizationPlacement).not.toHaveBeenCalled();
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Known Session Account currentness read failed',
      { code: 'session_spawn_account_currentness_unavailable' },
    );
  });

  it('keeps a same-key rejoin successful when Message transport acknowledgement fails', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-rejoin-message-transport-failed',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: 'folder-created', tagIds: ['tag-created'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'session-rejoin-message-transport-failed',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        pendingCount: 0,
        metadataVersion: 1,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
          }),
        ),
      }],
    });
    fetchSessionOrganizationPlacement.mockResolvedValue({
      folderId: 'folder-current',
      tagIds: ['tag-current'],
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-message-transport-failed',
    });
    sendSessionMessage.mockRejectedValue(new Error('Session Message transport acknowledgement failed'));

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag,
      sessionCreationCorrespondence,
      organizationPlacement: { folderId: 'folder-created', tagIds: ['tag-created'] },
      initialInput: { text: 'Keep the Session settlement' },
      buildInitialInputHandoff: () => initialInputAdmission,
    })).resolves.toMatchObject({
      disposition: 'rejoined',
      sessionId: 'session-rejoin-message-transport-failed',
      organizationPlacement: { folderId: 'folder-current', tagIds: ['tag-current'] },
      initialInput: {
        status: 'outcomeUnknown',
        localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag }),
        code: 'session_input_action_execution_failed',
      },
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('keeps a known same-key rejoin successful when cancellation interrupts current placement before initial input admission', async () => {
    const controller = new AbortController();
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-rejoin-placement-cancelled',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: 'folder-created', tagIds: ['tag-created'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'session-known-rejoin',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        pendingCount: 0,
        metadataVersion: 1,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
          }),
        ),
      }],
    });
    fetchSessionOrganizationPlacement.mockImplementation(async () => {
      controller.abort(new Error('caller retired after Session identity was known'));
      throw controller.signal.reason;
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-known-rejoin',
    });
    sendSessionMessage.mockRejectedValue(
      new Error('initial input must not be submitted after caller cancellation'),
    );

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag,
      sessionCreationCorrespondence,
      organizationPlacement: { folderId: 'folder-created', tagIds: ['tag-created'] },
      initialInput: { text: 'This input must remain nested' },
      buildInitialInputHandoff: () => initialInputAdmission,
      signal: controller.signal,
    })).resolves.toMatchObject({
      disposition: 'rejoined',
      sessionId: 'session-known-rejoin',
      organizationPlacement: { folderId: 'folder-created', tagIds: ['tag-created'] },
      initialInput: { status: 'rejected', code: 'session_input_cancelled' },
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('returns creation_conflict when the post-spawn Session has a different immutable correspondence', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-post-spawn-conflict',
    });
    const requestedCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    const existingCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      ...requestedCorrespondence,
      recipe: {
        ...requestedCorrespondence.recipe,
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/different-repo' } },
      },
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-post-spawn-conflict',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-post-spawn-conflict',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          workspace: { path: '/different-repo', host: 'host' },
          system: { sessionCreationCorrespondenceV1: existingCorrespondence },
        }),
      ),
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag,
      sessionCreationCorrespondence: requestedCorrespondence,
    })).rejects.toMatchObject({
      code: 'creation_conflict',
      details: { sessionId: 'session-post-spawn-conflict' },
    });
  });

  it('validates source lineage before input when settlement rejoins a child', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'creation-post-settlement-source-conflict',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-source-conflict',
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-post-settlement-source-conflict',
      sessionCreationOutcome: {
        disposition: 'rejoined',
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-post-settlement-source-conflict',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          workspace: { path: '/repo', host: 'host' },
          system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
          history: {
            replaySeedV1: {
              v: 1,
              seedText: '',
              sourceSessionId: 'parent-session',
              sourceCutoffSeqInclusive: 12,
              createdAtMs: 1,
            },
          },
        }),
      ),
    });
    const baseParams = {
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
      sessionCreationTag,
      sessionCreationCorrespondence,
      initialInput: { text: 'Never admit this input to another source' },
      buildInitialInputHandoff: () => initialInputAdmission,
    } satisfies CreateSpawnedSessionParams;

    await expect(createSpawnedSession({
      ...baseParams,
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'other-parent-session',
        forkPoint: { type: 'latest' },
      },
    })).rejects.toMatchObject({ code: 'creation_conflict' });

    await expect(createSpawnedSession({
      ...baseParams,
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'parent-session',
        forkPoint: { type: 'seq', upToSeqInclusive: 11 },
      },
    })).rejects.toMatchObject({ code: 'creation_conflict' });

    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('routes an explicit non-Provider target through that exact machine without local fallback', async () => {
    callMachineRpc
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'exact-machine-action-1',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-exact-machine',
        sessionCreationOutcome: creationOutcome,
      });
    fetchSessionById.mockResolvedValue({
      id: 'session-exact-machine',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-exact',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
        updatedAt: 1,
      },
      spawnNonce: 'exact-machine-action-1',
    })).resolves.toMatchObject({ sessionId: 'session-exact-machine' });

    expect(callMachineRpc).toHaveBeenNthCalledWith(1, {
      credentials,
      machineId: 'machine-exact',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      timeoutMs: DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS,
      request: expect.objectContaining({
        machineId: 'machine-exact',
        spawnNonce: 'exact-machine-action-1',
      }),
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials,
      machineId: 'machine-exact',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: 'exact-machine-action-1', timeoutMs: expect.any(Number) },
      timeoutMs: null,
      signal: expect.any(AbortSignal),
      reattachOnReconnect: { readRequest: expect.any(Function) },
    });
    expect(callMachineRpc.mock.calls[1]?.[0]?.request?.timeoutMs).toBeGreaterThan(20_000);
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('uses the supplied direct target lifecycle transport without looping through Socket RPC', async () => {
    const controller = new AbortController();
    const directTransport = {
      spawn: vi.fn(async () => ({
        type: 'success' as const,
        spawnNonce: 'direct-target-action-1',
        sessionIdStatus: 'pending' as const,
      })),
      resolveSpawnSessionByNonce: vi.fn(async () => ({
        status: 'success' as const,
        sessionId: 'session-direct-target',
        sessionCreationOutcome: creationOutcome,
      })),
    };
    fetchSessionById.mockResolvedValue({
      id: 'session-direct-target',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-exact',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'direct-target-action-1',
      directTransport,
      signal: controller.signal,
    })).resolves.toMatchObject({ sessionId: 'session-direct-target' });

    expect(directTransport.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'machine-exact',
        spawnNonce: 'direct-target-action-1',
      }),
      { signal: controller.signal },
    );
    expect(directTransport.resolveSpawnSessionByNonce).toHaveBeenCalledWith(
      'direct-target-action-1',
      { signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) },
    );
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('preserves a cancellation racing exact-machine submission as an unresolved same-nonce attempt', async () => {
    const controller = new AbortController();
    callMachineRpc.mockImplementation(async () => {
      controller.abort(new Error('caller cancelled while waiting for spawn acknowledgement'));
      throw controller.signal.reason;
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-exact',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'cancelled-after-submit',
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      details: { spawnNonce: 'cancelled-after-submit' },
    });
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-exact',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: expect.objectContaining({ spawnNonce: 'cancelled-after-submit' }),
      signal: controller.signal,
    }));
  });

  it('keeps an accepted pending exact-machine spawn unresolved when caller cancellation interrupts nonce resolution', async () => {
    const controller = new AbortController();
    callMachineRpc.mockImplementation(async (request) => {
      if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        return {
          success: true,
          status: 'pending',
          sessionIdStatus: 'pending',
          spawnNonce: 'accepted-then-cancelled',
        };
      }
      return await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    });
    const creation = createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-exact',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'accepted-then-cancelled',
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(callMachineRpc).toHaveBeenCalledTimes(2));
    controller.abort(new Error('caller retired after accepted submission'));

    await expect(creation).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      details: { spawnNonce: 'accepted-then-cancelled' },
    });
  });

  it('retains daemon-proven Agent identity when an accepted spawn fails during nonce settlement', async () => {
    callMachineRpc.mockImplementation(async ({ method }) => method === RPC_METHODS.SPAWN_HAPPY_SESSION
      ? { success: true, sessionIdStatus: 'pending', spawnNonce: 'agent-setup-nonce' }
      : { status: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
          errorMessage: 'Agent setup required', agentId: 'codex' });

    await expect(createSpawnedSession({
      credentials, directory: '/repo', machineId: 'machine-exact',
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      spawnNonce: 'agent-setup-nonce',
    })).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
      details: { agentId: 'codex', spawnNonce: 'agent-setup-nonce' },
    });
  });

  it('keeps a known direct Session successful when server visibility is still unavailable', async () => {
    vi.stubEnv('HAPPIER_SESSION_SPAWN_FETCH_TIMEOUT_MS', '25');
    vi.stubEnv('HAPPIER_SESSION_SPAWN_FETCH_POLL_INTERVAL_MS', '1');
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-known-before-visibility',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockResolvedValue(null);

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'known-before-visibility',
    })).resolves.toMatchObject({
      disposition: 'created',
      sessionId: 'session-known-before-visibility',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    });
  });

  it('keeps a directly identified Session successful when Account currentness is unavailable', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-direct-currentness-unavailable',
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-direct-currentness',
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-direct-currentness-unavailable',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-direct-currentness-unavailable',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });
    fetchAccountEncryptionCurrentness.mockRejectedValue(
      new Error('Account encryption currentness unavailable'),
    );
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'session-direct-currentness-unavailable',
      localId: initialInputAdmission.localId,
      waited: false,
      admissionResult: { status: 'accepted', localId: 'spawn-first-turn:direct-currentness-unavailable' },
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'direct-currentness-unavailable',
      initialInput: { text: 'Keep the Session settlement' },
      buildInitialInputHandoff: () => initialInputAdmission,
    })).resolves.toMatchObject({
      disposition: 'created',
      sessionId: 'session-direct-currentness-unavailable',
      initialInput: { status: 'accepted', localId: 'spawn-first-turn:direct-currentness-unavailable' },
    });
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Known Session Account currentness read failed',
      { code: 'session_spawn_account_currentness_unavailable' },
    );
  });

  it('keeps a directly identified Session successful with outcomeUnknown when Message admission transport fails', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-direct-message-setup-failed',
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-direct-message',
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-direct-message-setup-failed',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-direct-message-setup-failed',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });
    sendSessionMessage.mockRejectedValue(Object.assign(
      new Error('Private Session Message setup detail'),
      { code: 'session_input_target_unavailable' },
    ));

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'direct-message-setup-failed',
      initialInput: { text: 'Keep the Session settlement' },
      buildInitialInputHandoff: () => initialInputAdmission,
    })).resolves.toMatchObject({
      disposition: 'created',
      sessionId: 'session-direct-message-setup-failed',
      initialInput: {
        status: 'outcomeUnknown',
        localId: 'spawn-first-turn:direct-message-setup-failed',
        code: 'session_input_target_unavailable',
      },
    });
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Initial input admission failed',
      expect.objectContaining({
        sessionId: 'session-direct-message-setup-failed',
        localId: 'spawn-first-turn:direct-message-setup-failed',
        code: 'session_input_target_unavailable',
      }),
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('Private Session Message setup detail');
  });

  it('classifies a generic settled-Session visibility failure without hiding it as eventual visibility', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-direct-visibility-failed',
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-direct-visibility',
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-direct-visibility-failed',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockRejectedValue(new Error('Settled Session visibility request failed'));
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'session-direct-visibility-failed',
      localId: initialInputAdmission.localId,
      waited: false,
      admissionResult: { status: 'accepted', localId: 'spawn-first-turn:direct-visibility-failed' },
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'direct-visibility-failed',
      initialInput: { text: 'Keep the Session settlement' },
      buildInitialInputHandoff: () => initialInputAdmission,
    })).resolves.toMatchObject({
      disposition: 'created',
      sessionId: 'session-direct-visibility-failed',
      initialInput: { status: 'accepted', localId: 'spawn-first-turn:direct-visibility-failed' },
    });
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Settled Session visibility read failed',
      { code: 'session_spawn_visibility_unavailable' },
    );
  });

  it('keeps the Session top-level successful with a rejected disposition when cancellation interrupts before input admission', async () => {
    const controller = new AbortController();
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-known-visibility-cancelled',
    });
    const initialInputAdmission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
      actionCaller: { kind: 'host' },
      callerSurface: 'cli',
      localId: 'fixture-known-visibility',
    });
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-known-before-visibility',
      sessionCreationOutcome: creationOutcome,
    });
    fetchSessionById.mockImplementation(async () => {
      controller.abort(new Error('caller retired after Session identity was known'));
      throw controller.signal.reason;
    });
    sendSessionMessage.mockRejectedValue(
      new Error('initial input must not be submitted after caller cancellation'),
    );

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'known-before-visibility',
      initialInput: { text: 'This input must remain nested' },
      buildInitialInputHandoff: () => initialInputAdmission,
      signal: controller.signal,
    })).resolves.toMatchObject({
      disposition: 'created',
      sessionId: 'session-known-before-visibility',
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'rejected', code: 'session_input_cancelled' },
    });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects an advertised V1 result that names a Session without create-or-rejoin truth', async () => {
    callMachineRpc.mockResolvedValue({
      type: 'success',
      sessionId: 'session-without-outcome',
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-exact',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'missing-outcome',
    })).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      details: { sessionId: 'session-without-outcome' },
    });
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('returns a same-key rejoin after later organization edits without treating current placement as correspondence', async () => {
    callMachineRpc.mockResolvedValue({
      success: true,
      sessionId: 'session-rejoined-after-edit',
      sessionCreationOutcome: {
        disposition: 'rejoined',
        organizationPlacement: { folderId: 'folder-current', tagIds: ['tag-current'] },
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-rejoined-after-edit',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      organizationPlacement: { folderId: 'folder-original', tagIds: ['tag-original'] },
    })).resolves.toMatchObject({
      disposition: 'rejoined',
      sessionId: 'session-rejoined-after-edit',
      organizationPlacement: { folderId: 'folder-current', tagIds: ['tag-current'] },
    });
  });

  it('submits Provider-bound actions atomically through the current-only machine RPC', async () => {
    callMachineRpc
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'provider-action-1',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-provider', sessionCreationOutcome: creationOutcome });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    fetchSessionById.mockResolvedValue({
      id: 'session-provider',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-1',
    });

    expect(result.sessionId).toBe('session-provider');
    expect(callMachineRpc).toHaveBeenCalledTimes(2);
    expect(callMachineRpc).toHaveBeenNthCalledWith(1, {
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      timeoutMs: DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS,
      request: expect.objectContaining({
        machineId: 'machine-1',
        spawnNonce: 'provider-action-1',
        modelSelection: {
          v: 1,
          ref: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId,
            modelId: 'shared-model',
          },
          updatedAt: 1,
        },
      }),
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: 'provider-action-1', timeoutMs: expect.any(Number) },
      timeoutMs: null,
      signal: expect.any(AbortSignal),
      reattachOnReconnect: { readRequest: expect.any(Function) },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it.each([
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
  ])('maps Provider-bound current-only receiver absence (%s) to typed daemon unavailability without fallback', async (rpcErrorCode) => {
    callMachineRpc.mockRejectedValue(createRpcCallError({
      error: 'RPC method unavailable',
      errorCode: rpcErrorCode,
    }));

    const error = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-2',
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      message: 'Provider-bound session creation is unavailable because the selected machine does not support this request',
    });
    expect(error).not.toHaveProperty('details');
    expect(error).not.toHaveProperty('rpcErrorCode');
    expect(JSON.stringify(error)).not.toContain('provider-action-2');
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      timeoutMs: DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS,
      request: expect.objectContaining({ spawnNonce: 'provider-action-2' }),
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('retains the Provider spawn nonce only when machine-RPC submission is ambiguous', async () => {
    callMachineRpc.mockRejectedValue(Object.assign(new Error('Machine RPC call timeout'), {
      code: 'MACHINE_RPC_TIMEOUT',
    }));

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-timeout',
    })).rejects.toMatchObject({
      code: 'MACHINE_RPC_TIMEOUT',
      details: { spawnNonce: 'provider-action-timeout' },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('resumes Provider-bound nonce settlement against the exact machine without submitting again', async () => {
    callMachineRpc.mockResolvedValue({ status: 'success', sessionId: 'session-provider-recovered', sessionCreationOutcome: creationOutcome });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    fetchSessionById.mockResolvedValue({
      id: 'session-provider-recovered',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-retry',
      resumeOnly: true,
    });

    expect(result.sessionId).toBe('session-provider-recovered');
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: 'provider-action-retry', timeoutMs: expect.any(Number) },
      timeoutMs: null,
      signal: expect.any(AbortSignal),
      reattachOnReconnect: { readRequest: expect.any(Function) },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('waits past the old three-second window for one accepted exact-machine spawn and one nonce', async () => {
    vi.useFakeTimers();
    callMachineRpc
      .mockResolvedValueOnce({
        success: true,
        status: 'pending',
        sessionIdStatus: 'pending',
        spawnNonce: 'daemon-echoed-nonce',
      })
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_500));
        return { status: 'success', sessionId: 'session-after-slow-registration', sessionCreationOutcome: creationOutcome };
      });
    fetchSessionById.mockResolvedValue({
      id: 'session-after-slow-registration',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });
    const pending = createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    });
    await vi.advanceTimersByTimeAsync(3_499);
    expect(callMachineRpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.sessionId).toBe('session-after-slow-registration');
    expect(callMachineRpc).toHaveBeenCalledTimes(2);
    expect(callMachineRpc.mock.calls[0]?.[0]).toMatchObject({
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
    });
    const sentNonce = callMachineRpc.mock.calls[0]?.[0]?.request?.spawnNonce;
    expect(sentNonce).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    for (const [request] of callMachineRpc.mock.calls.slice(1)) {
      expect(request).toMatchObject({
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        request: { spawnNonce: sentNonce, timeoutMs: expect.any(Number) },
      });
    }
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('abandons a late-settled generated-nonce child through stop then bounded inactive archive', async () => {
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '100');
    vi.stubEnv('HAPPIER_SPAWN_ABANDON_TIMEOUT_MS', '1000');
    callMachineRpc
      .mockResolvedValueOnce({
        success: true,
        status: 'pending',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-abandoned' });
    const cleanupOrder: string[] = [];
    requestSessionStop.mockImplementation(async () => {
      cleanupOrder.push('stop');
      return { ok: true, sessionId: 'session-abandoned', stopped: true };
    });
    archiveSessionOnceInactive.mockImplementation(async () => {
      cleanupOrder.push('archive');
      return { archivedAt: 123 };
    });
    await expect(createSpawnedSession({
        credentials,
        directory: '/repo',
        machineId: 'machine-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    })).rejects.toMatchObject({
        code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });

    await vi.waitFor(() => {
      expect(archiveSessionOnceInactive).toHaveBeenCalledWith({
        token: 'token',
        sessionId: 'session-abandoned',
      });
    });
    expect(archiveSessionOnceInactive).toHaveBeenCalledOnce();
    expect(requestSessionStop).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'session-abandoned',
    });
    expect(requestSessionStop).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(['stop', 'archive']);
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('resumes a caller-owned ambiguous predecessor nonce without a second spawn', async () => {
    callMachineRpc
      .mockResolvedValueOnce({
        success: true,
        status: 'pending',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-original-attempt', sessionCreationOutcome: creationOutcome });
    fetchSessionById.mockResolvedValue({
      id: 'session-from-original-attempt',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const stableAttempt = {
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'action-request:session-1:tool-call-1',
    } satisfies CreateSpawnedSessionParams & Readonly<{ spawnNonce: string }>;

    await expect(createSpawnedSession(stableAttempt)).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    });
    const recovered = await createSpawnedSession({
      ...stableAttempt,
      resumeOnly: true,
    } as CreateSpawnedSessionParams & Readonly<{ resumeOnly: true }>);

    expect(recovered.sessionId).toBe('session-from-original-attempt');
    expect(callMachineRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: expect.objectContaining({ spawnNonce: stableAttempt.spawnNonce }),
    }));
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: stableAttempt.spawnNonce, timeoutMs: expect.any(Number) },
    }));
    expect(callMachineRpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: stableAttempt.spawnNonce, timeoutMs: expect.any(Number) },
    }));
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });
});

/**
 * Replay-seeded creation is a mode of the canonical creator, not a second
 * creator. These cases own the create/rejoin, recipe-conflict and orphan
 * settlement contract every Replay ingress now inherits.
 */
describe('createSpawnedSession replay-seeded creation', () => {
  const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
  };
  const replayMetadata = {
    forkV1: {
      v: 1,
      parentSessionId: 'parent-session',
      parentCutoffSeqInclusive: 12,
      createdAtMs: 1,
      strategy: 'replay',
      agentHint: { agentId: 'codex' },
    },
    replaySeedV1: {
      v: 1,
      seedText: 'Continue this conversation',
      sourceSessionId: 'parent-session',
      sourceCutoffSeqInclusive: 12,
      createdAtMs: 1,
    },
  } as const;

  function replaySeededParams(
    overrides?: Partial<CreateSpawnedSessionParams>,
  ): CreateSpawnedSessionParams {
    return {
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'replay:parent-session:12:attempt',
      replaySeededCreation: {
        tag: 'replay:parent-session:12:attempt',
        flavor: 'codex',
        metadata: { ...replayMetadata },
        sourceRecipe: { sourceSessionId: 'parent-session', cutoffSeqInclusive: 12 },
      },
      ...overrides,
    } as CreateSpawnedSessionParams;
  }

  beforeEach(() => {
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path.startsWith('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
      throw new Error(`Unexpected replay creation HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true } } as never);
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    getOrCreateSessionByTag.mockReset();
    lookupSessionsByTags.mockReset();
    fetchSessionOrganizationPlacement.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    sendSessionMessage.mockReset();
    callMachineRpc.mockReset();
    archiveSessionOnceInactive.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid' });
    fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1 });
    fetchSessionOrganizationPlacement.mockResolvedValue({ folderId: null, tagIds: [] });
    archiveSessionOnceInactive.mockResolvedValue({ archivedAt: 1 });
    lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
    getOrCreateSessionByTag.mockResolvedValue({ session: { id: 'replay-child' }, created: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds a replay child only after its creation identity is trusted and before dispatch', async () => {
    getOrCreateSessionByTag.mockResolvedValue({ session: { id: 'replay-child-bind-order' }, created: true });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: null } } as never);
    const order: string[] = [];
    vi.mocked(axios.post).mockImplementation(async () => {
      order.push('access-key');
      return { status: 200, data: { success: true } } as never;
    });
    const directSpawn = vi.fn(async () => {
      order.push('spawn');
      return { type: 'success', sessionId: 'replay-child-bind-order' };
    });

    await createSpawnedSession(replaySeededParams({
      // This access-key boundary case starts after Account creation settings admission.
      accountSettings: {},
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    expect(order).toEqual(['access-key', 'spawn']);
    expect(vi.mocked(axios.get).mock.calls.some(([url]) => String(url).includes('/v1/access-keys/replay-child-bind-order/machine-1'))).toBe(true);
  });

  it.each([
    { identity: { bot: { kind: 'bot' as const }, createdAsBot: true as const }, memoryEnabled: false, expectedMemory: false, roleWorker: true, profileId: 'worker-profile' },
    { identity: undefined, memoryEnabled: undefined, expectedMemory: false, roleWorker: true, profileId: 'worker-profile' },
    { identity: { bot: { kind: 'bot' as const }, createdAsBot: true as const }, memoryEnabled: undefined, expectedMemory: true, roleWorker: true, profileId: 'worker-profile' },
    { identity: undefined, memoryEnabled: undefined, expectedMemory: false, roleWorker: false, profileId: 'worker-profile' },
    { identity: undefined, memoryEnabled: undefined, expectedMemory: false, roleWorker: true, profileId: null },
    { identity: undefined, memoryEnabled: undefined, expectedMemory: false, roleWorker: false, profileId: undefined },
  ])('commits the row from the recipe and attaches the launched runner to it', async ({ identity, memoryEnabled, expectedMemory, roleWorker, profileId }) => {
    const initialSessionRolesV1 = { ...snapshotSessionRolesAtSpawnV1({
      leadSessionId: 'lead-1', notes: 'Preserve launch notes',
      roles: { builder: { roleId: 'builder', name: 'Builder', instructions: 'Complete role instructions',
        engine: { agentTargetKey: 'agent:codex', modelId: 'worker-model' }, runsAs: { kind: 'session' },
        workspaceWrites: 'allow', secondOpinion: 'off', enabled: true } },
    }), roleId: 'builder' };
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));

    const created = await createSpawnedSession(replaySeededParams({
      initialAccess,
      identity,
      memoryEnabled,
      primaryTeamId: 'team-1',
      profileId,
      ...(roleWorker ? { initialSessionRolesV1 } : { reportsTo: { sessionId: 'lead-1' } }),
      replaySeededCreation: { tag: 'replay:parent-session:12:attempt', flavor: 'codex',
        metadata: { ...replayMetadata, profileId: 'lead-profile', work: { promptStack: [{ id: 'lead-context', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'lead-doc' } }],
          disabledInheritedEntryIds: ['account.context'], memoryEnabled: !expectedMemory,
          sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Lead notes', memoryDocRef: { kind: 'doc', artifactId: 'lead-memory' } } } },
        sourceRecipe: { sourceSessionId: 'parent-session', cutoffSeqInclusive: 12 } },
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    expect(created.disposition).toBe('created');
    expect(created.sessionId).toBe('replay-child');
    const creationCall = getOrCreateSessionByTag.mock.calls[0]?.[0];
    expect(creationCall.tag).toBe('replay:parent-session:12:attempt');
    expect(creationCall).toMatchObject({ initialAccess, primaryTeamId: 'team-1' });
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('initialAccess');
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('primaryTeamId');
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('initialSessionRolesV1');
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('identity');
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('memoryEnabled');
    expect(creationCall.metadata).toMatchObject({
      tag: 'replay:parent-session:12:attempt',
      path: '/repo',
      flavor: 'codex',
      ...(typeof profileId === 'string' ? { profileId } : {}),
      forkV1: replayMetadata.forkV1,
      replaySeedV1: replayMetadata.replaySeedV1,
      ...identity,
      work: { ...(roleWorker ? { sessionRolesV1: initialSessionRolesV1 } : {}), memoryEnabled: expectedMemory },
    });
    expect(creationCall.metadata).not.toHaveProperty('work.promptStack');
    expect(creationCall.metadata).not.toHaveProperty('work.disabledInheritedEntryIds');
    const storedOwner = createSessionOwnerMetadataV1({ metadata: creationCall.metadata });
    expect(storedOwner).toMatchObject({ ok: true });
    if (!storedOwner.ok) throw new Error('Expected canonical persisted worker metadata');
    expect(storedOwner.ownerMetadata.work).not.toHaveProperty('promptStack');
    if (typeof profileId !== 'string') expect(creationCall.metadata).not.toHaveProperty('profileId');
    expect(directSpawn.mock.calls[0]?.[0]).toMatchObject({
      existingSessionId: 'replay-child',
      freshSessionCreation: true,
      spawnNonce: 'replay:parent-session:12:attempt',
    });
    // Identity is already committed by the row creation, so the creator must
    // not fall back to nonce settlement for it.
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('preserves the source Profile and Session context for ordinary replay without a worker relation', async () => {
    const promptStack = [{ id: 'source-context', enabled: true, placement: 'system_append' as const,
      ref: { kind: 'doc' as const, artifactId: 'source-doc' } }];
    await createSpawnedSession(replaySeededParams({
      replaySeededCreation: { tag: 'replay:parent-session:12:attempt', flavor: 'codex',
        metadata: { ...replayMetadata, profileId: 'source-profile', work: {
          promptStack, disabledInheritedEntryIds: ['account.context'],
          sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Source notes', memoryDocRef: { kind: 'doc', artifactId: 'source-memory' } },
        } }, sourceRecipe: { sourceSessionId: 'parent-session', cutoffSeqInclusive: 12 } },
      directTransport: { spawn: async () => ({ type: 'success', sessionId: 'replay-child' }),
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }) },
    }));
    expect(getOrCreateSessionByTag.mock.calls[0]?.[0].metadata).toMatchObject({
      profileId: 'source-profile', work: { promptStack, disabledInheritedEntryIds: ['account.context'] },
    });
    const storedOwner = createSessionOwnerMetadataV1({ metadata: getOrCreateSessionByTag.mock.calls[0]?.[0].metadata });
    expect(storedOwner).toMatchObject({ ok: true });
    if (!storedOwner.ok) throw new Error('Expected canonical persisted replay metadata');
    expect(storedOwner.ownerMetadata.work).toMatchObject({ promptStack: [...promptStack, {
      id: 'session.legacy-role-memory', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'source-memory' },
    }] });
  });

  it('reports the persisted empty cross-machine managed fork and never sends a source seed', async () => {
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));
    const created = await createSpawnedSession(replaySeededParams({
      directory: '/private/child', directoryKind: 'managed',
      replaySeededCreation: {
        tag: 'replay:parent-session:12:attempt', flavor: 'codex',
        metadata: { ...replayMetadata, forkV1: { ...replayMetadata.forkV1, filesNotCopied: { reason: 'cross_machine' } } },
        sourceRecipe: { sourceSessionId: 'parent-session', cutoffSeqInclusive: 12 },
      },
      directTransport: { spawn: directSpawn, resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' }) },
    }));
    expect(created).toMatchObject({ disposition: 'created', filesNotCopied: { reason: 'cross_machine' } });
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('managedDirectorySeed');
    expect(getOrCreateSessionByTag.mock.calls[0]?.[0].metadata).toMatchObject({
      sessionDirectoryV1: { v: 1, kind: 'managed' }, forkV1: { filesNotCopied: { reason: 'cross_machine' } },
    });
  });

  it('submits replay-created initial input once through Message admission after the runner attaches', async () => {
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));
    const buildInitialInputHandoff = vi.fn((localId: string) => ({
      ...buildSessionSpawnInitialInputAdmissionForLocalIdV1({
        actionCaller: { kind: 'host' as const },
        callerSurface: 'cli' as const,
        localId,
      }),
      localId,
    }));
    sendSessionMessage.mockResolvedValue({
      ok: false,
      code: 'admission_rejected' as const,
      admissionResult: { status: 'rejected' as const, code: 'session_input_idempotency_conflict' as const },
    });

    const created = await createSpawnedSession(replaySeededParams({
      initialInput: { text: 'Continue from the replay seed' },
      buildInitialInputHandoff,
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    expect(created).toMatchObject({
      disposition: 'created',
      sessionId: 'replay-child',
      initialInput: { status: 'rejected', code: 'session_input_idempotency_conflict' },
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      '[SESSION SPAWN] Initial input admission did not accept the message',
      expect.objectContaining({
        sessionId: 'replay-child',
        status: 'rejected',
        code: 'session_input_idempotency_conflict',
      }),
    );
    expect(directSpawn.mock.calls[0]?.[0]).not.toHaveProperty('pendingFirstInput');
    expect(buildInitialInputHandoff).toHaveBeenCalledTimes(1);
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(directSpawn.mock.invocationCallOrder[0]).toBeLessThan(sendSessionMessage.mock.invocationCallOrder[0]);
  });

  it('carries one fresh materialization identity from source-context creation into the attached spawn', async () => {
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));

    await createSpawnedSession(replaySeededParams({
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'parent-session',
        forkPoint: { type: 'seq', upToSeqInclusive: 12 },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.agent.claude/claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile-1',
          },
        },
      },
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    const creationCall = getOrCreateSessionByTag.mock.calls[0]?.[0];
    const persistedIdentity = ConnectedServiceMaterializationIdentityV1Schema.parse(
      creationCall.metadata.connectedServiceMaterializationIdentityV1,
    );
    const spawnRequest = directSpawn.mock.calls[0]?.[0];
    expect(ConnectedServiceMaterializationIdentityV1Schema.parse(
      spawnRequest.connectedServiceMaterializationIdentityV1,
    )).toEqual(persistedIdentity);
  });

  it('does not commit a materialization identity for a native replay-seeded spawn', async () => {
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));

    await createSpawnedSession(replaySeededParams({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.agent.claude/claude-subscription': { source: 'native' },
        },
      },
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    const creationCall = getOrCreateSessionByTag.mock.calls[0]?.[0];
    expect(creationCall.metadata).not.toHaveProperty('connectedServiceMaterializationIdentityV1');
  });

  it('rejects a reused creation identity whose persisted source recipe differs', async () => {
    getOrCreateSessionByTag.mockResolvedValue({
      session: {
        id: 'replay-child-untrusted',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            history: {
              replaySeedV1: {
                v: 1,
                seedText: 'Other source',
                sourceSessionId: 'other-parent',
                sourceCutoffSeqInclusive: 4,
                createdAtMs: 1,
              },
            },
          }),
        ),
      },
      created: false,
    });
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));

    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: 'creation_conflict' });
    expect(directSpawn).not.toHaveBeenCalled();
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
    expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
  });

  it('rejects a reused creationKey whose committed Session names another source recipe', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-key-source-context',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'existing-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
            history: {
              replaySeedV1: {
                v: 1,
                seedText: 'Other source',
                sourceSessionId: 'other-parent',
                sourceCutoffSeqInclusive: 4,
                createdAtMs: 1,
              },
            },
          }),
        ),
      }],
    });

    await expect(createSpawnedSession(replaySeededParams({
      sessionCreationTag,
      sessionCreationCorrespondence,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });

    // The inverse matters just as much: retrying an ordinary launch after its
    // source-context chip was removed must not rejoin the earlier replay child
    // merely because the creation identity was retained by an outcome-unknown
    // attempt.
    await expect(createSpawnedSession(replaySeededParams({
      sessionCreationTag,
      sessionCreationCorrespondence,
      replaySeededCreation: undefined,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
  });

  it('rejoins a latest sourceContext through persisted lineage without recomputing its cutoff', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-key-source-context-latest-rejoin',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'existing-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
            history: {
              forkV1: { ...replayMetadata.forkV1, filesNotCopied: { reason: 'cross_machine' } },
              replaySeedV1: {
                v: 1,
                seedText: '',
                sourceSessionId: 'parent-session',
                sourceCutoffSeqInclusive: 12,
                createdAtMs: 1,
              },
            },
          }),
        ),
      }],
    });

    await expect(createSpawnedSession(replaySeededParams({
      sessionCreationTag,
      sessionCreationCorrespondence,
      replaySeededCreation: undefined,
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'parent-session',
        forkPoint: { type: 'latest' },
      },
      resumeOnly: true,
    }))).resolves.toMatchObject({
      disposition: 'rejoined',
      sessionId: 'existing-child',
      filesNotCopied: { reason: 'cross_machine' },
    });

    await expect(createSpawnedSession(replaySeededParams({
      sessionCreationTag,
      sessionCreationCorrespondence,
      replaySeededCreation: undefined,
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'other-parent-session',
        forkPoint: { type: 'latest' },
      },
      resumeOnly: true,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });

    await expect(createSpawnedSession(replaySeededParams({
      sessionCreationTag,
      sessionCreationCorrespondence,
      replaySeededCreation: undefined,
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'parent-session',
        forkPoint: { type: 'seq', upToSeqInclusive: 11 },
      },
      resumeOnly: true,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });

    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('fails closed when atomic get-or-create rejoins a child with a different immutable correspondence', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-key-atomic-correspondence-race',
    });
    const requestedCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    const racedCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      ...requestedCorrespondence,
      recipe: {
        ...requestedCorrespondence.recipe,
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/different-repo' } },
      },
    });
    // The first tag lookup observed no child. The atomic get-or-create then
    // joins a concurrently committed row, so it must re-run every immutable
    // correspondence check before attaching a runner to it.
    lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [sessionCreationTag], sessions: [] });
    getOrCreateSessionByTag.mockResolvedValue({
      session: {
        id: 'replay-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/different-repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: racedCorrespondence },
            history: {
              replaySeedV1: {
                v: 1,
                seedText: 'Continue this conversation',
                sourceSessionId: 'parent-session',
                sourceCutoffSeqInclusive: 12,
                createdAtMs: 1,
              },
            },
          }),
        ),
      },
      created: false,
    });
    const directSpawn = vi.fn(async () => ({ type: 'success', sessionId: 'replay-child' }));

    await expect(createSpawnedSession(replaySeededParams({
      // This test stops before spawn in the correct branch. Omitting the
      // otherwise unrelated runtime target keeps the wrong branch observable
      // without loading the concurrent bundled-plugin catalog fixture.
      backendTarget: undefined as unknown as CreateSpawnedSessionParams['backendTarget'],
      sessionCreationTag,
      sessionCreationCorrespondence: requestedCorrespondence,
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: 'creation_conflict' });

    expect(directSpawn).not.toHaveBeenCalled();
  });

  it('uses raw source intent after atomic get-or-create rejoins a replay child', async () => {
    // The initial tag lookup can miss a concurrent creator. The following
    // get-or-create is still a rejoin boundary, so it must use the caller's
    // original source intent rather than a later `latest` recipe cutoff.
    getOrCreateSessionByTag.mockResolvedValue({
      session: {
        id: 'replay-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            history: { replaySeedV1: replayMetadata.replaySeedV1 },
          }),
        ),
      },
      created: false,
    });
    const directSpawn = vi.fn(async () => ({ type: 'success', sessionId: 'replay-child' }));
    const directTransport = {
      spawn: directSpawn,
      resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
    };

    await expect(createSpawnedSession(replaySeededParams({
      replaySeededCreation: {
        tag: 'replay:parent-session:12:attempt',
        flavor: 'codex',
        metadata: { ...replayMetadata },
        // A new `latest` read is not the persisted child snapshot.
        sourceRecipe: { sourceSessionId: 'parent-session', cutoffSeqInclusive: 13 },
      },
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'parent-session',
        forkPoint: { type: 'latest' },
      },
      directTransport,
    }))).resolves.toMatchObject({ disposition: 'rejoined', sessionId: 'replay-child' });
    expect(directSpawn).toHaveBeenCalledTimes(1);

    directSpawn.mockClear();
    await expect(createSpawnedSession(replaySeededParams({
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'other-parent-session',
        forkPoint: { type: 'latest' },
      },
      directTransport,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });
    await expect(createSpawnedSession(replaySeededParams({
      sourceContext: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'parent-session',
        forkPoint: { type: 'seq', upToSeqInclusive: 11 },
      },
      directTransport,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });

    expect(directSpawn).not.toHaveBeenCalled();
  });

  it('refuses a replay request to rejoin a matching creation identity without persisted lineage', async () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-key-source-context-without-lineage',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      tags: [sessionCreationTag],
      sessions: [{
        id: 'existing-ordinary-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            system: { sessionCreationCorrespondenceV1: sessionCreationCorrespondence },
          }),
        ),
      }],
    });

    await expect(createSpawnedSession(replaySeededParams({
      sessionCreationTag,
      sessionCreationCorrespondence,
    }))).rejects.toMatchObject({ code: 'creation_conflict' });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
  });

  it.each([SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING, SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT])(
    'archives the fresh replay row rejected by %s before admission', async (errorCode) => {
      const realArchive = await vi.importActual<typeof import('./archiveSessionOnceInactive')>('./archiveSessionOnceInactive');
      archiveSessionOnceInactive.mockImplementation(realArchive.archiveSessionOnceInactive);
      let archived = false;
      vi.mocked(axios.post).mockImplementation(async (url) => {
        if (String(url).endsWith('/archive')) archived = true;
        // Axios transport boundary fixture; the real archive owner reads status and data only.
        return { status: 200, data: { archivedAt: 1, success: true } } as never;
      });
      await expect(createSpawnedSession(replaySeededParams({
        directTransport: {
          spawn: async () => ({ type: 'error', errorCode, agentId: 'codex', errorMessage: 'Agent setup is required.' }),
          resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
        },
      }))).rejects.toMatchObject({ code: errorCode });
      expect(archived).toBe(true);
    },
  );

  it('settles the orphan once on a definite launch failure and never on an ambiguous one', async () => {
    const definiteSpawn = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Runner rejected spawn validation before admission',
    }));
    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: definiteSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
    expect(archiveSessionOnceInactive).toHaveBeenCalledTimes(1);
    expect(archiveSessionOnceInactive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'replay-child' }),
    );

    archiveSessionOnceInactive.mockClear();
    const ambiguousSpawn = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Timed out waiting for session webhook',
    }));
    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: ambiguousSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(archiveSessionOnceInactive).not.toHaveBeenCalled();
  });

  it('never archives a rejoined child after a definite pre-admission rejection', async () => {
    getOrCreateSessionByTag.mockResolvedValue({
      session: {
        id: 'replay-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            history: { replaySeedV1: replayMetadata.replaySeedV1 },
          }),
        ),
      },
      created: false,
    });
    const directSpawn = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Runner rejected spawn validation before admission',
    }));

    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });

    expect(archiveSessionOnceInactive).not.toHaveBeenCalled();
  });

  it('refuses to rejoin a reused creation identity it cannot authenticate', async () => {
    // `getOrCreateSessionByTag` is get-OR-create, so a reused tag rejoins an
    // existing row. The sibling correspondence-rejoin path already refuses to
    // attach to a candidate whose immutable recipe it cannot authenticate; a
    // transient currentness read must not make this path laxer, or the seed
    // silently continues another source's Session.
    fetchAccountEncryptionCurrentness.mockRejectedValue(new Error('currentness unavailable'));
    getOrCreateSessionByTag.mockResolvedValue({
      session: { id: 'replay-child' },
      created: false,
    });
    const directSpawn = vi.fn(async () => ({ type: 'success', sessionId: 'replay-child' }));

    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(directSpawn).not.toHaveBeenCalled();
  });

  it('refuses to rejoin a reused creation identity whose lineage it cannot read', async () => {
    // The sibling refusal above only fires when the currentness read itself
    // failed. A currentness read that SUCCEEDS while the candidate row's owner
    // metadata cannot be decrypted — or simply carries no source recipe — used
    // to sail through: the recipe reader returns null, and "no recipe" is not a
    // conflict, so an unauthenticated row was rejoined and had this seed
    // attached to it. Absence of contradicting evidence is not lineage; the
    // rejoin needs POSITIVE evidence that the row is this exact source recipe's
    // child. The predecessor already fails closed here.
    getOrCreateSessionByTag.mockResolvedValue({
      session: { id: 'replay-child' },
      created: false,
    });
    const directSpawn = vi.fn(async () => ({ type: 'success', sessionId: 'replay-child' }));

    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(directSpawn).not.toHaveBeenCalled();
  });

  it('rejoins a reused creation identity whose persisted lineage matches, seed already consumed', async () => {
    // The control that keeps the refusal above from becoming "never rejoin".
    // Seed consumption blanks `seedText` and stamps `appliedToLocalId` but
    // SPREADS the rest, so `sourceSessionId`/`sourceCutoffSeqInclusive` outlive
    // the seed. An exact retry after the child already ran must still rejoin.
    getOrCreateSessionByTag.mockResolvedValue({
      session: {
        id: 'replay-child',
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
          SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: { path: '/repo', host: 'host' },
            history: {
              replaySeedV1: {
                v: 1,
                seedText: '',
                appliedToLocalId: 'local-1',
                appliedAtMs: 2,
                sourceSessionId: 'parent-session',
                sourceCutoffSeqInclusive: 12,
                createdAtMs: 1,
              },
            },
          }),
        ),
      },
      created: false,
    });
    const directSpawn = vi.fn(async () => ({ type: 'success', sessionId: 'replay-child' }));

    const created = await createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    expect(created.sessionId).toBe('replay-child');
    expect(directSpawn).toHaveBeenCalledTimes(1);
    expect(directSpawn).toHaveBeenCalledWith(expect.objectContaining({ freshSessionCreation: false }), expect.anything());
  });

  it('still commits a fresh row when Account currentness is unavailable', async () => {
    // A row this call created cannot conflict with itself, so the refusal above
    // must not block first-time replay-seeded creation on a flaky read.
    fetchAccountEncryptionCurrentness.mockRejectedValue(new Error('currentness unavailable'));
    getOrCreateSessionByTag.mockResolvedValue({ session: { id: 'replay-child' }, created: true });
    const directSpawn = vi.fn(async () => ({ type: 'success', sessionId: 'replay-child' }));

    const created = await createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    expect(created.sessionId).toBe('replay-child');
    expect(directSpawn).toHaveBeenCalledTimes(1);
  });

  it('settles the orphan when the launch dispatch throws rather than answering', async () => {
    // The row is already committed when dispatch runs. A definite transport
    // failure that throws leaves the same orphan a definite error response
    // does, so it takes the same one settlement — and an ambiguous throw still
    // takes none, because the runner may be live.
    const definiteThrow = vi.fn(async () => {
      const error = new Error('Daemon rejected spawn validation before admission') as Error & { code?: string };
      error.code = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
      throw error;
    });
    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: definiteThrow,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
    expect(archiveSessionOnceInactive).toHaveBeenCalledTimes(1);
    expect(archiveSessionOnceInactive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'replay-child' }),
    );

    archiveSessionOnceInactive.mockClear();
    const ambiguousThrow = vi.fn(async () => {
      const error = new Error('Machine RPC timed out') as Error & { code?: string };
      error.code = 'MACHINE_RPC_TIMEOUT';
      throw error;
    });
    await expect(createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: ambiguousThrow,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }))).rejects.toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
    expect(archiveSessionOnceInactive).not.toHaveBeenCalled();
  });
});
