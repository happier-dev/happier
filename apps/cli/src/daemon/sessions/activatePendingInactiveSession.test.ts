import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { activatePendingInactiveSession, type PendingInactiveSessionActivationRejected } from './activatePendingInactiveSession';
import { createActivityLog } from '../guard/activityLog';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import { createMachineResourceSummary } from '../resources/machineResourceSummary';
import type { SpawnFailureV1 } from '@happier-dev/protocol/machines/processes/spawnFailureV1';
type ResumeOptions = Parameters<Parameters<typeof activatePendingInactiveSession>[0]['spawnSessionForInternalResume']>[0];

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(),
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  readPendingQueueV2ActivationEligibilityFromServer: vi.fn(),
}));
vi.mock('@/api/session/pendingActivationTransport', () => ({
  reportPendingSessionActivationFailure: vi.fn(async () => ({ didFail: true })),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' })),
}));

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
  },
};
const tokenOnlyCredentials = {
  token: 'token-only',
  encryption: null,
};

function createSession(active: boolean) {
  return {
    id: 'session-1',
    seq: 12,
    createdAt: 1,
    updatedAt: 1,
    active,
    activeAt: 1,
    encryptionMode: 'plain' as const,
    metadata: JSON.stringify({
      machineId: 'machine-1',
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'vendor-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    pendingCount: 1,
    pendingVersion: 9,
    pendingActivationAuthorization: {
      requestId: 'pending-after-ui-death',
      requestedAt: 10,
      status: 'waiting' as const,
    },
    dataEncryptionKey: null,
    machineId: 'machine-1',
    path: '/repo',
  };
}

describe('activatePendingInactiveSession', () => {
  it('settles a refused connected account with its closed cause so the Session can lead to signing in again', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const result = await activatePendingInactiveSession({ credentials: tokenOnlyCredentials, machineId: 'machine-1',
      sessionId: 'session-1', requestId: 'pending-after-ui-death', pendingVersion: 9,
      spawnSessionForInternalResume: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'private provider message', errorDetail: { kind: 'connected_service_ux_diagnostic', uxDiagnostic: {
          code: 'connected_service_credential_reconnect_required', failurePhase: 'materialization', source: 'spawn_resume',
          serviceId: 'happier.agent.claude/claude-subscription', agentId: 'claude', profileId: 'private-profile', retryable: false,
          suggestedActions: ['reconnect_profile', 'open_connected_accounts'] } } }) });
    const failureDetails = { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED',
      runtimeReason: 'connected_service_credential_reconnect_required' };
    expect(result).toEqual({ status: 'rejected', reason: 'spawn-rejected', failureDetails });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('retains a retryable transport spawn refusal as waiting without copying its private message', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const result = await activatePendingInactiveSession({ credentials: tokenOnlyCredentials, machineId: 'machine-1',
      sessionId: 'session-1', requestId: 'pending-after-ui-death', pendingVersion: 9,
      spawnSessionForInternalResume: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        runtimeFailureReason: 'transport_unavailable',
        errorMessage: 'secret credential and transcript' }) });
    expect(result).toEqual({ status: 'not-needed', reason: 'spawn-retryable' });
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('records a rejected Guard-stopped wake with its native cause, then folds actual runner restoration without changing resume options', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-guard-wake-'));
    let now = Date.now();
    const attribution = { serverId: 'home', accountId: 'owner', machineId: 'machine-1', installationId: 'installation' };
    const sampler = createMachineVitalsSampler({ historyStore: await createMinuteHistoryStore({ directory: join(directory, 'minutes') }),
      readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) } });
    const summary = createMachineResourceSummary({ sampler, nowMs: () => now, readNearlyFull: () => null, onError: error => { throw error; } });
    const activity = await createActivityLog({ activeServerDir: directory, nowMs: () => now, resourceSummary: summary });
    try {
      await activity.append({ v: 1, id: 'guard-stop', at: now, kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done', attribution,
        subject: { kind: 'session', sessionId: 'session-1', title: 'Session' },
        wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 'session-1', intent: 'resume' } }] });
      const session = createSession(false);
      session.metadata = JSON.stringify({ ...JSON.parse(session.metadata), permissionMode: 'read-only', permissionModeUpdatedAt: 5 });
      vi.mocked(fetchSessionByIdCompat).mockResolvedValue(session);
      vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
      const spawnSessionForInternalResume = vi.fn(async (_options: ResumeOptions): Promise<SpawnSessionResult> => ({ type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'native launch failed',
        errorDetail: { kind: 'spawn_failure', reason: 'too_many_open_files', errno: 'EMFILE' } }));
      const params = { credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1', requestId: 'pending-after-ui-death',
        pendingVersion: 9, spawnSessionForInternalResume,
        onActivationRejected: async (event: PendingInactiveSessionActivationRejected) => {
          const { createGuardSessionRestoration } = await import('../guard/sessionRestoration');
          await createGuardSessionRestoration({ activity, nowMs: () => now,
            readCustodianTarget: () => ({ serverId: attribution.serverId, machineId: attribution.machineId,
              installationId: attribution.installationId, custodianAccountId: attribution.accountId }),
          }).onActivationRejected(event);
        } };
      expect(await activatePendingInactiveSession(params)).toMatchObject({ status: 'rejected', reason: 'spawn-rejected' });
      expect((await activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'start_failed', rule: 'idle_sessions', ref: 'guard-stop',
          failure: { reason: 'too_many_open_files', errno: 'EMFILE' }, nextStep: 'review_processes', attribution })]));
      expect(spawnSessionForInternalResume.mock.calls[0]?.[0]).toMatchObject({ existingSessionId: 'session-1', directory: '/repo',
        permissionMode: 'read-only', permissionModeUpdatedAt: 5, initialTranscriptAfterSeq: 12,
        executionAuthorization: { provenance: 'user_request', requestId: 'pending-after-ui-death', requestedAt: 10 } });
      const { createGuardSessionRestoration } = await import('../guard/sessionRestoration');
      const restoration = createGuardSessionRestoration({ activity, nowMs: () => now });
      await restoration.onSessionRunnerStarted({ pid: 42, happySessionId: 'session-1', startedBy: 'daemon',
        requesterWorkAttributionV1: { ...attribution, accountId: 'other' } });
      expect((await activity.read('guard-stop'))?.undoneAt).toBeUndefined();
      now++;
      await restoration.onSessionRunnerStarted({ pid: 42, happySessionId: 'session-1', startedBy: 'daemon', requesterWorkAttributionV1: attribution });
      expect((await activity.read('guard-stop'))?.undoneAt).toBe(now);
      await restoration.onSessionRunnerStarted({ pid: 42, happySessionId: 'session-1', startedBy: 'daemon', requesterWorkAttributionV1: attribution });
      expect((await activity.list({ range: 'today' })).entries.filter(row => row.kind === 'start_failed')).toHaveLength(1);
    } finally { summary.stop(); await sampler.stop(); await rm(directory, { recursive: true, force: true }); }
  });
  it('retains requester pending custody without reporting failure or spawning after Machine admission is lost', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn(async (_options: ResumeOptions) => ({ type: 'success' as const, sessionId: 'session-1' }));
    const params = {
      credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSessionForInternalResume,
      requester: { serverHttpBaseUrl: 'https://bob-home.test',
        attribution: { serverId: 'bob-home', accountId: 'bob', machineId: 'machine-1', installationId: 'installation' },
        isCurrent: async () => false },
    };
    expect(await activatePendingInactiveSession(params)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('does not publish a Guard wake failure to a requester whose admission changed while the failure CAS was in flight', async () => {
    let current = true;
    const events: unknown[] = [];
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('ineligible');
    vi.mocked(reportPendingSessionActivationFailure).mockImplementationOnce(async () => { current = false; return { didFail: true }; });
    const params = { credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9,
      spawnSessionForInternalResume: async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'session-1' }),
      requester: { serverHttpBaseUrl: 'https://owner-home.test',
        attribution: { serverId: 'home', accountId: 'owner', machineId: 'machine-1', installationId: 'installation' },
        isCurrent: async () => current },
      onActivationRejected: async (event: unknown) => { events.push(event); } };
    expect(await activatePendingInactiveSession(params)).toMatchObject({ status: 'rejected', reason: 'ineligible' });
    expect(events).toEqual([]);
  });

  it('preserves exact requester/Home custody on inactive resume and rechecks admission before spawn', async () => {
    let current = true;
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn(async (_options: ResumeOptions) => ({ type: 'success' as const, sessionId: 'session-1' }));
    const requester = { serverHttpBaseUrl: 'https://bob-home.test',
      attribution: { serverId: 'bob-home', accountId: 'bob', machineId: 'machine-1', installationId: 'installation' },
      isCurrent: async () => current };
    const params = { credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSessionForInternalResume, requester };
    expect(await activatePendingInactiveSession(params)).toEqual({ status: 'activated' });
    expect(spawnSessionForInternalResume).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: 'session-1',
      requesterWorkAttributionV1: requester.attribution,
      verifyRequesterMachineAdmissionCurrent: expect.any(Function) }),
      { requestId: 'pending-after-ui-death', requestedAt: 10 });
    const options = spawnSessionForInternalResume.mock.calls[0]?.[0];
    current = false;
    const verifyAdmission = options?.verifyRequesterMachineAdmissionCurrent;
    if (!verifyAdmission) throw new Error('Expected the resume launch to retain its requester admission verifier');
    expect(await verifyAdmission()).toBe(false);
  });

  it('leaves the queued prompt in custody when the managed session directory is missing', async () => {
    const session = createSession(false);
    session.metadata = JSON.stringify({
      machineId: 'machine-1', path: '/repo',
      acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'my-acp', title: 'My ACP' },
      sessionDirectoryV1: { v: 1, kind: 'managed' },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(session);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn(async () => ({
      type: 'error' as const,
      errorCode: 'SESSION_DIRECTORY_MISSING' as const,
      errorMessage: 'Session folder is missing',
    }));
    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSessionForInternalResume,
    })).resolves.toMatchObject({ status: 'rejected', reason: 'session-directory-missing' });
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledWith({
      token: 'token-only', sessionId: 'session-1', requestId: 'pending-after-ui-death',
      requestedAt: 10, failureCode: 'runtime_start_failed',
      failureDetails: { reason: 'session-directory-missing', spawnErrorCode: 'SESSION_DIRECTORY_MISSING' },
    });
  });

  beforeEach(() => {
    vi.mocked(fetchSessionByIdCompat).mockReset();
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockReset();
    vi.mocked(reportPendingSessionActivationFailure).mockClear();
  });

  it('starts the exact inactive session from durable Pending custody without any UI process', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'activated' });

    expect(spawnSessionForInternalResume).toHaveBeenCalledTimes(1);
    expect(spawnSessionForInternalResume).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo',
      initialTranscriptAfterSeq: 12,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'pending-after-ui-death',
        requestedAt: 10,
      },
    }), { requestId: 'pending-after-ui-death', requestedAt: 10 });
  });

  it('does not spawn when the exact durable authorization is rearmed before the final decision', async () => {
    vi.mocked(fetchSessionByIdCompat)
      .mockResolvedValueOnce(createSession(false))
      .mockResolvedValueOnce({
        ...createSession(false),
        pendingActivationAuthorization: {
          requestId: 'pending-after-ui-death',
          requestedAt: 11,
          status: 'waiting' as const,
        },
      });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(fetchSessionByIdCompat).toHaveBeenCalledTimes(2);
    expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalledTimes(2);
    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('starts a plaintext layout-v1 inactive session from its plain owner envelope without account encryption material', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
      },
      nativeSession: {
        codexSessionId: 'vendor-1',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'vendor-1',
          },
        },
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        agentPresentation: { agentId: 'codex' },
      }),
      ownerMetadata:
        createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      machineId: undefined,
      path: undefined,
    });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'activated' });

    expect(spawnSessionForInternalResume).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: expect.objectContaining({
          backendMode: 'appServer',
          providerSessionId: 'vendor-1',
        }),
      },
    }), { requestId: 'pending-after-ui-death', requestedAt: 10 });
  });

  it('keeps retained encrypted layout-v1 owner metadata locked for token-only credentials', async () => {
    const retainedOwnerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-1',
        path: '/repo',
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        agentPresentation: { agentId: 'codex' },
      }),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: {
          type: 'legacy',
          secret: credentials.encryption.secret,
        },
        ownerMetadata: retainedOwnerMetadata,
        randomBytes: (length) =>
          new Uint8Array(length).fill(9),
      }),
      machineId: undefined,
      path: undefined,
    });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'identity-unavailable',
    });
    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
  });

  it('delegates an active relay projection to the canonical runner serviceability owner', async () => {
    const spawnSessionForInternalResume = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
      runnerAcceptance: 'preexisting_or_adopted' as const,
    }));
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(true));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'activated' });
    expect(spawnSessionForInternalResume).toHaveBeenCalledOnce();
  });

  it('does not start a session whose exact Pending authorization resolved', async () => {
    const spawnSessionForInternalResume = vi.fn();

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('missing');
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'not-needed', reason: 'pending-resolved' });
    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
  });

  it('rejects Pending activation for an externally linked session instead of spawning it', async () => {
    // A linked Session's hosted runtime is owned by External Sessions takeover:
    // durable Pending custody must not activate it behind takeover's back.
    const linked = createSession(false);
    linked.metadata = JSON.stringify({
      ...JSON.parse(linked.metadata),
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'vendor-1',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 1,
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(linked);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toMatchObject({ status: 'rejected', reason: 'takeover-required' });

    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledOnce();
  });

  it('rejects Pending activation when the external link exists but is unresolved', async () => {
    const unresolved = createSession(false);
    unresolved.metadata = JSON.stringify({
      ...JSON.parse(unresolved.metadata),
      externalSessionV1: { v: 1 },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(unresolved);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toMatchObject({ status: 'rejected', reason: 'takeover-required' });

    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledWith({
      token: 'token-only', sessionId: 'session-1', requestId: 'pending-after-ui-death',
      requestedAt: 10, failureCode: 'runtime_start_failed',
      failureDetails: { reason: 'takeover-required' },
    });
  });

  it('rejects a Pending activation owned by a different exact machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-2',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'not-needed', reason: 'target-mismatch' });

    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
  });

  it('leaves the evolved deferred spawn result waiting because session identity is ambiguous', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSessionForInternalResume = vi.fn(async () => ({
      type: 'success' as const,
      spawnNonce: 'spawn-1',
      sessionIdStatus: 'pending' as const,
    }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'not-needed', reason: 'spawn-ambiguous' });

    expect(spawnSessionForInternalResume).toHaveBeenCalledTimes(1);
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['mismatched', { requestId: 'other', requestedAt: 10, status: 'waiting' as const }],
    ['failed', { requestId: 'pending-after-ui-death', requestedAt: 10, status: 'failed' as const, failureCode: 'runtime_start_failed' as const }],
  ])('does not start when durable activation authorization is %s', async (_label, authorization) => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      pendingActivationAuthorization: authorization,
    });
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(readPendingQueueV2ActivationEligibilityFromServer).not.toHaveBeenCalled();
    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
  });

  it('reports deterministic ineligibility through the exact failure CAS', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      archivedAt: 11,
    });
    const spawnSessionForInternalResume = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume,
    })).resolves.toMatchObject({ status: 'rejected', reason: 'ineligible' });

    expect(reportPendingSessionActivationFailure).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      requestedAt: 10,
      failureCode: 'runtime_start_failed',
      failureDetails: { reason: 'ineligible' },
    });
    expect(spawnSessionForInternalResume).not.toHaveBeenCalled();
  });

  it('does not terminally fail a durable authorization targeted at another machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-2',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume: vi.fn(),
    })).resolves.toEqual({ status: 'not-needed', reason: 'target-mismatch' });

    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('reports a deterministic spawn rejection and keeps CAS transport failure observable', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    vi.mocked(reportPendingSessionActivationFailure).mockRejectedValueOnce(new Error('network unavailable'));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'invalid persisted identity',
      })),
    })).rejects.toThrow('network unavailable');
  });

  it('treats a declined terminal failure CAS as an authorization-stale race', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('ineligible');
    vi.mocked(reportPendingSessionActivationFailure).mockResolvedValueOnce({ didFail: false });

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSessionForInternalResume: vi.fn(),
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });
  });
});
