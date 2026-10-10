import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
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
} from '@happier-dev/protocol';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { configuration } from '@/configuration';
import { createSpawnedSession } from './createSpawnedSession';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from './sessionInputAdmissionIdentity';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

// Only HTTP/authentication and exact-machine transport boundaries are replaced;
// lookup decoding, creation settlement and Message admission remain real.
vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'admission-test' });
const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
  v: 1,
  sessionCreationTag,
  recipe: {
    execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
    organization: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
    configuration: null, connectedServices: null, mcpSelection: null, transcriptStorage: null,
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

  it('refuses a recognized unavailable tag lookup before any provider spawn', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 404,
      data: { statusCode: 404, error: 'Not Found', message: 'Route POST:/v2/sessions/lookup-by-tags not found' },
    });
    await expect(createSpawnedSession(params)).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
    expect(spawn).not.toHaveBeenCalled();
    expect(resolveSpawnSessionByNonce).not.toHaveBeenCalled();
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

  it.each([
    { bot: true, upkeep: undefined, installed: true },
    { bot: true, upkeep: true, installed: true },
    { bot: true, upkeep: false, installed: false },
    { bot: false, upkeep: true, installed: false },
  ])('installs canonical weekly upkeep only at ordinary Bot birth ($bot/$upkeep)', async ({ bot, upkeep, installed }) => {
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
});
