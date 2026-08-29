import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

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
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import {
  ConnectedServiceMaterializationIdentityV1Schema,
  ProviderConnectionIdSchema,
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionCreationCorrespondenceV1Schema,
  SessionOwnerMetadataV1Schema,
  deriveSessionCreationTagV1,
  buildSessionSpawnInitialInputLocalIdV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { buildSessionSpawnInitialInputAdmissionForLocalIdV1 } from './sessionInputAdmissionIdentity';

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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
          agentTargetKey: 'backend:codex',
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
      agentSessionStartupInstructionsV1,
    });
    expect(spawnRequest).not.toHaveProperty('pendingFirstInput');
    expect(spawnRequest).not.toHaveProperty('initialPrompt');
    expect(spawnRequest).not.toHaveProperty('initialMessage');
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(buildInitialInputHandoff).toHaveBeenCalledTimes(1);
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'session-created',
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
      initialInput: { text: 'Inspect this repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/another-repository' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/different-repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
          agentTargetKey: 'backend:codex',
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
      request: expect.objectContaining({
        machineId: 'machine-exact',
        spawnNonce: 'exact-machine-action-1',
      }),
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials,
      machineId: 'machine-exact',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: 'exact-machine-action-1' },
    });
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
      { signal: controller.signal },
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
    sendSessionMessage.mockRejectedValue(new Error('Session Message setup failed'));

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
        code: 'session_input_action_execution_failed',
      },
    });
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
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
          agentTargetKey: 'backend:codex',
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
      request: expect.objectContaining({
        machineId: 'machine-1',
        spawnNonce: 'provider-action-1',
        modelSelection: {
          v: 1,
          ref: {
            agentTargetKey: 'backend:codex',
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
      request: { spawnNonce: 'provider-action-1' },
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
          agentTargetKey: 'backend:codex',
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
          agentTargetKey: 'backend:codex',
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
          agentTargetKey: 'backend:codex',
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
      request: { spawnNonce: 'provider-action-retry' },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('waits past the old three-second window for one accepted exact-machine spawn and one nonce', async () => {
    callMachineRpc
      .mockResolvedValueOnce({
        success: true,
        status: 'pending',
        sessionIdStatus: 'pending',
        spawnNonce: 'daemon-echoed-nonce',
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-after-slow-registration', sessionCreationOutcome: creationOutcome });
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
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }).finally(() => nowSpy.mockRestore());

    expect(result.sessionId).toBe('session-after-slow-registration');
    expect(callMachineRpc).toHaveBeenCalledTimes(6);
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
        request: { spawnNonce: sentNonce },
      });
    }
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('abandons a late-settled generated-nonce child through stop then bounded inactive archive', async () => {
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '100');
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_POLL_INTERVAL_MS', '25');
    vi.stubEnv('HAPPIER_SPAWN_ABANDON_TIMEOUT_MS', '1000');
    vi.stubEnv('HAPPIER_SPAWN_ABANDON_POLL_INTERVAL_MS', '100');
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
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });

    try {
      await expect(createSpawnedSession({
        credentials,
        directory: '/repo',
        machineId: 'machine-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      })).rejects.toMatchObject({
        code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
    } finally {
      nowSpy.mockRestore();
    }

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
      request: { spawnNonce: stableAttempt.spawnNonce },
    }));
    expect(callMachineRpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: stableAttempt.spawnNonce },
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

  it('commits the row from the recipe and attaches the launched runner to it', async () => {
    const directSpawn = vi.fn(async (
      _request: Parameters<NonNullable<CreateSpawnedSessionParams['directTransport']>['spawn']>[0],
    ) => ({ type: 'success', sessionId: 'replay-child' }));

    const created = await createSpawnedSession(replaySeededParams({
      directTransport: {
        spawn: directSpawn,
        resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
      },
    }));

    expect(created.disposition).toBe('created');
    expect(created.sessionId).toBe('replay-child');
    const creationCall = getOrCreateSessionByTag.mock.calls[0]?.[0];
    expect(creationCall.tag).toBe('replay:parent-session:12:attempt');
    expect(creationCall.metadata).toMatchObject({
      tag: 'replay:parent-session:12:attempt',
      path: '/repo',
      flavor: 'codex',
      forkV1: replayMetadata.forkV1,
      replaySeedV1: replayMetadata.replaySeedV1,
    });
    expect(directSpawn.mock.calls[0]?.[0]).toMatchObject({
      existingSessionId: 'replay-child',
      spawnNonce: 'replay:parent-session:12:attempt',
    });
    // Identity is already committed by the row creation, so the creator must
    // not fall back to nonce settlement for it.
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
        execution: { machineId: 'machine-1', directory: '/different-repo' },
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
        execution: { machineId: 'machine-1', directory: '/repo' },
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
