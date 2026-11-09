import { join } from 'node:path';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { createDaemonControlApp } from '@/daemon/controlServer';
import type { TrackedSession } from '@/daemon/types';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { authorizeConnectedServiceRuntimeAuthFailureSource, handleConnectedServiceRuntimeAuthFailureForSession } from '../runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry, type ConnectedServiceAuthGroupSwitchState } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { buildConnectedServiceAuthGroupObservedFailureMemberState } from '../accountGroups/runtimeState/buildConnectedServiceAuthGroupObservedFailureMemberState';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { continueAccountQualifiedSessionAfterUsageLimitReset, continueSessionAfterUsageLimitReset } from './continueSessionAfterUsageLimitReset';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from '../sessionRuntimeAuthRefresh';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { readQualifiedConnectedAccountCredentialMaterial } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/types';
import { createConnectedServiceContinuationMessageDispatcher } from './createConnectedServiceContinuationMessageDispatcher';
import { RuntimeAuthRecoveryScheduler } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';
import { createConnectedServiceContinuationHandler } from './switchRecovery';
import { USAGE_LIMIT_CONTINUATION_RESUME_PROMPT } from './continuationResumePrompt';

// HTTP is the process boundary. Keep issue validation, continuation identity,
// Session authoring, envelopes and ordinary Pending transport real.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { ...http, defaults: {}, isAxiosError: () => false } }));

const sessionId = 'c123456789012345678901234';
const serviceId = 'happier.agent.claude/claude-subscription';
const credentials = { token: 'quota-recovery-test', encryption: null };
const issue: SessionRuntimeIssueV1 = {
  v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
  agentId: 'claude', agentTurnId: 'interrupted-turn', occurredAt: 100,
  usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
    connectedService: { serviceId, profileId: 'account-1', groupId: null } },
};
const recovery: SessionUsageLimitRecoveryV1 = {
  v: 1, status: 'waiting', issueFingerprint: 'recovery-attempt', runtimeAuthRecoveryAttemptId: 'recovery-attempt',
  armedAtMs: 110, resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
  lastProbeError: null, resumePromptMode: 'standard',
  selectedAuth: { kind: 'profile', serviceId, profileId: 'account-1' },
};

function fixture(overrides: Partial<RawSessionRecord> = {}) {
  const selectedAuth = { ...recovery.selectedAuth, retiredSelectionField: true };
  const fixtureRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, selectedAuth };
  const metadata = {
    connectedServices: { v: 2, retiredBindingsField: true, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'profile', profileId: 'account-1', retiredBindingField: true },
    } },
    sessionUsageLimitRecoveryV1: { ...fixtureRecovery, retiredRecoveryField: true },
  };
  const rawSession = createSessionRecordFixture({
    id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify(metadata),
    latestTurnId: 'canonical-failed-turn', latestTurnStatus: 'failed', lastRuntimeIssue: issue,
    ...overrides,
  });
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
    throw new Error(`Unexpected read: ${url}`);
  });
  return { credentials, sessionId, rawSession, metadata, recovery, nowMs: 200, isCurrent: () => true };
}

describe('continueSessionAfterUsageLimitReset', () => {

  it.each(['stopped', 'predecessor', 'provider_capacity', 'newer_work', 'completed', 'cancelled', 'not_failed', 'archived', 'unknown_quota', 'exhausted_quota'] as const)(
    'keeps an adopted successor report under durable guarded admission (%s)', async projection => {
    const directory = await createTempDir('happier-adopted-report-');
    let now = 110;
    const input = fixture({ latestTurnId: 'interrupted-turn', latestTurnStatus: 'in_progress', lastRuntimeIssue: null,
      latestTurnStatusObservedAt: 100 });
    const revisionA = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const revisionB = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const tracked: TrackedSession = { startedBy: 'daemon', happySessionId: sessionId, pid: 123,
      activeTurnId: 'interrupted-turn', ...(projection === 'predecessor' ? { reattachedFromDiskMarker: true } : {}),
      spawnOptions: { directory, backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, connectedServices: {
        v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'A' } },
      } } };
    const classification: ConnectedServiceRuntimeFailureClassification = { kind: projection === 'provider_capacity' ? 'capacity' : 'plan',
      limitCategory: projection === 'provider_capacity' ? 'capacity' : 'plan_invalid',
      quotaScope: projection === 'provider_capacity' ? 'provider' : 'model', providerLimitId: 'fixture-model',
      serviceId, groupId: 'pool', profileId: 'A', groupGeneration: 1,
      expectedCredentialRevision: projection === 'predecessor' ? null : revisionA,
      resetsAtMs: 604_800_000, planType: null, rateLimits: null, source: 'structured_provider_error' };
    let runtime = { serviceId, groupId: 'pool', profileId: 'A', generation: 1, credentialRevision: revisionA };
    let state: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'A', generation: 1,
      credentialRevision: revisionA, runtimeStateRevision: 0,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true, strategy: 'priority', softSwitchRemainingPercent: 15 },
      members: ['A', 'B'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
      memberStatesByProfileId: new Map(['A', 'B'].map(profileId => [profileId, {
        quotaSnapshot: { capturedAtMs: now, staleAfterMs: 60_000, effectiveRemainingPercent: profileId === 'A' ? 10 : 80 },
      }])) };
    let commits = 0;
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => now,
      loadState: async () => state,
      commitSwitch: async value => { commits++; state = { ...state, activeProfileId: value.toProfileId,
        generation: state.generation + 1, credentialRevision: revisionB }; return state; },
      // Home CAS, provider apply and Home member-state persistence are system boundaries.
      applyGeneration: async value => { runtime = { ...runtime, profileId: value.activeProfileId!, generation: value.generation, credentialRevision: revisionB };
        return { ok: true, mode: 'hot_apply' }; },
      recordObservedFailureState: async value => {
        const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
        const profileId = value.observedProfileId!;
        const existing = memberStatesByProfileId.get(profileId) ?? {};
        const observed = buildConnectedServiceAuthGroupObservedFailureMemberState({ existing, reason: value.reason,
          limitCategory: value.limitCategory, quotaScope: value.quotaScope, providerLimitId: value.providerLimitId,
          retryAtMs: value.resetsAtMs ?? null, cooldownMs: state.policy.cooldownMs,
          autoDisablePlanInvalidAccounts: state.policy.autoDisablePlanInvalidAccounts, planType: value.planType, observedAtMs: now });
        memberStatesByProfileId.set(profileId, { ...existing, ...observed });
        state = { ...state, memberStatesByProfileId };
      },
    });
    const consumed = new Set<string>();
    const sends: string[] = [];
    http.post.mockImplementation(async (_url: string, body: { localId: string }) => {
      sends.push(body.localId); const didWrite = !consumed.has(body.localId); consumed.add(body.localId);
      return { status: 200, data: { didWrite, terminal: false } };
    });
    let scheduler: RuntimeAuthRecoveryScheduler;
    const run = async (value: Parameters<NonNullable<Parameters<typeof createDaemonControlApp>[0]['handleConnectedServiceRuntimeAuthFailure']>>[0] & { recoveryInvocationSource?: 'scheduler_retry' }) => {
      const intent = scheduler.readForSession(sessionId)[0];
      return await handleConnectedServiceRuntimeAuthFailureForSession({ ...value, getChildren: () => [tracked],
        switchCoordinator: coordinator, resolveRegisteredRuntimeAuthFailureSource: () => runtime,
        resolveCurrentRuntimeAuthFailureSource: async () => runtime,
        continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({ credentials,
          interruptedOriginId: value.interruptedOriginId, resumePromptMode: 'standard', resolveInterruption: () => 'provider_failed_turn',
          ...(intent ? { runtimeAuthRecovery: { armedAtMs: intent.armedAtMs,
            isCurrent: () => scheduler.readForSession(sessionId).some(current => current.attemptId === value.interruptedOriginId
              && ['waiting', 'checking', 'resumed_awaiting_proof'].includes(current.status)),
            readActiveTurnId: () => tracked.activeTurnId ?? null } } : {}),
        }),
      });
    };
    const createScheduler = () => new RuntimeAuthRecoveryScheduler({ nowMs: () => now, jitterMs: () => 0,
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(directory, 'recoveries.json')),
      recover: value => run({ ...value, switchesThisTurn: value.switchesThisTurn ?? 0 }) });
    scheduler = createScheduler();
    const createApp = () => createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, runtimeAuthRecoveryScheduler: scheduler,
      authorizeConnectedServiceRuntimeAuthFailure: value => authorizeConnectedServiceRuntimeAuthFailureSource({ ...value,
        getChildren: () => [tracked], resolveRegisteredRuntimeAuthFailureSource: () => runtime,
        resolveCurrentRuntimeAuthFailureSource: async () => runtime }), handleConnectedServiceRuntimeAuthFailure: run });
    let app = createApp();
    const report = (reportId = 'adopted-A-report') => app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
      headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId, classification, reportId } });
    try {
      expect(await coordinator.switchBeforeTurn({ sessionId, serviceId, groupId: 'pool', reason: 'soft_threshold', observedProfileId: 'A' }))
        .toMatchObject({ status: 'switched', activeProfileId: 'B', generation: 2 });
      expect(input.rawSession.latestTurnStatus).toBe('in_progress');
      tracked.activeTurnId = projection === 'newer_work' ? 'new-user-turn' : 'interrupted-turn';
      const read = http.get.getMockImplementation()!;
      http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
        ? { status: 200, data: { session: { ...input.rawSession,
          latestTurnStatus: projection === 'not_failed' ? 'in_progress' : projection === 'completed' || projection === 'cancelled' ? projection : 'failed',
          latestTurnStatusObservedAt: projection === 'completed' || projection === 'cancelled' ? now + 1 : 100,
          archivedAt: projection === 'archived' ? now : null,
          lastRuntimeIssue: ['completed', 'cancelled', 'not_failed'].includes(projection) ? null : issue } } } : read(url));
      if (projection === 'unknown_quota' || projection === 'exhausted_quota') state = { ...state,
        memberStatesByProfileId: new Map([...state.memberStatesByProfileId, ['B', projection === 'unknown_quota' ? {} : {
          quotaSnapshot: { capturedAtMs: now, staleAfterMs: 60_000, effectiveRemainingPercent: 0,
            meters: [{ meterId: 'weekly', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 180_000, providerLimitId: null }] },
        }]]) };
      const [response, duplicate] = await Promise.all([report(), report()]);
      expect(response.statusCode).toBe(200); expect(duplicate.json()).toEqual(response.json());
      expect(response.json()).toMatchObject({ ok: true, result: { status: 'recovery_retry_scheduled' },
        recoveryReceipt: { reportId: 'adopted-A-report', attemptId: expect.any(String) } });
      const initial = scheduler.readForSession(sessionId)[0]!;
      expect(initial).toMatchObject({ status: 'waiting', lastSettledTransition: 'scheduled',
        classification: { kind: classification.kind, serviceId, profileId: 'A', groupId: 'pool', groupGeneration: 1,
          resetsAtMs: classification.resetsAtMs, limitCategory: classification.limitCategory, quotaScope: classification.quotaScope } });
      expect(initial.classification.expectedCredentialRevision ?? null).toBe(classification.expectedCredentialRevision);
      expect(initial.nextRetryAtMs).toBe(1_110); expect(sends).toEqual([]);
      now = initial.nextRetryAtMs!; await scheduler.wake({ sessionId, reason: 'timer' });
      if (projection === 'unknown_quota' || projection === 'exhausted_quota') {
        const wait = scheduler.readForSession(sessionId)[0]!;
        expect(wait.status).toBe('waiting'); expect(sends).toEqual([]);
        expect(wait.lastError).toBe(projection === 'unknown_quota' ? 'quota_proof_unavailable' : 'no_eligible_member');
        expect(wait.nextRetryAtMs).toBe(projection === 'unknown_quota' ? now + 30_000 : 180_000);
        now = wait.nextRetryAtMs!; state = { ...state, memberStatesByProfileId: new Map([...state.memberStatesByProfileId,
          ['B', { quotaSnapshot: { capturedAtMs: now, staleAfterMs: 60_000, effectiveRemainingPercent: 80 } }]]) };
        await scheduler.wake({ sessionId, reason: 'timer' });
      }
      const shouldSend = !['newer_work', 'completed', 'cancelled', 'not_failed', 'archived'].includes(projection);
      expect(consumed.size).toBe(shouldSend ? 1 : 0);
      expect(state.memberStatesByProfileId.get('A')?.lastFailureKind).toBe(projection === 'provider_capacity' ? undefined : 'plan');
      expect(state.memberStatesByProfileId.get('B')?.lastFailureKind).toBeUndefined();
      const firstSends = sends.length;
      scheduler.dispose(); scheduler = createScheduler(); scheduler.hydratePassive(); await app.close(); app = createApp();
      await report(); expect(scheduler.readForSession(sessionId)[0]!.attemptId).toBe(initial.attemptId);
      await scheduler.wake({ sessionId, reason: 'manual' }); expect(consumed.size).toBe(shouldSend ? 1 : 0);
      if (shouldSend) {
        expect(scheduler.readForSession(sessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof',
          pendingTargetProfileId: 'B', pendingTargetGeneration: 2, pendingTargetCredentialRevision: revisionB });
        expect(new Set(sends).size).toBe(1); expect(sends.length).toBeGreaterThanOrEqual(firstSends);
        expect(await scheduler.markProviderOutcomeProofByIdentity({ sessionId, serviceId, groupId: 'pool', profileId: 'A',
          groupGeneration: 1, credentialRevision: revisionA, proofKind: 'provider_activity', observedAtMs: now })).toEqual([]);
        await scheduler.markProviderOutcomeProofByIdentity({ sessionId, serviceId, groupId: 'pool', profileId: 'B',
          groupGeneration: 2, credentialRevision: revisionB, proofKind: 'provider_activity', observedAtMs: now });
        expect(scheduler.readForSession(sessionId)[0]!.status).toBe('recovered');
        const settledSends = sends.length; await app.close(); app = createApp(); await report();
        await scheduler.wake({ sessionId, reason: 'manual' });
        expect(scheduler.readForSession(sessionId)[0]!.status).toBe('recovered'); expect(sends.length).toBe(settledSends);
        if (projection === 'stopped') {
          tracked.activeTurnId = 'next-interrupted-turn';
          const failedAtMs = now;
          const currentRead = http.get.getMockImplementation()!;
          http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
            ? { status: 200, data: { session: { ...input.rawSession, latestTurnId: tracked.activeTurnId,
              latestTurnStatus: 'failed', latestTurnStatusObservedAt: failedAtMs,
              lastRuntimeIssue: { ...issue, agentTurnId: tracked.activeTurnId, occurredAt: failedAtMs } } } }
            : currentRead(url));
          const fresh = await report('next-adopted-A-report');
          expect(fresh.json()).toMatchObject({ ok: true, result: { status: 'recovery_retry_scheduled' } });
          const next = scheduler.readForSession(sessionId)[0]!;
          expect(next.attemptId).not.toBe(initial.attemptId); expect(next.status).toBe('waiting');
          now = next.nextRetryAtMs!; await scheduler.wake({ sessionId, reason: 'timer' });
          expect(consumed.size).toBe(2);
        }
      }
      expect(commits).toBe(1);
    } finally { scheduler.dispose(); await app.close(); await removeTempDir(directory); }
  });

  it('reads the policy after a deferred account switch before sending its continuation', async () => {
    fixture();
    const read = http.get.getMockImplementation()!;
    let policyAvailable = false;
    let resumePromptMode: 'off' | 'standard' = 'off';
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/continuation-policy')) {
        if (!policyAvailable) throw new Error('Home policy unavailable');
        return { data: { resumePromptMode } };
      }
      return read(url);
    });
    const options = { credentials, interruptedOriginId: 'interrupted-turn', resumePromptMode: 'standard' as const,
      resolveInterruption: () => 'provider_failed_turn' as const,
      resolveResumePromptMode: () => resolveRoutedUsageLimitRecoveryResumePromptMode({
        loadGroupPolicy: async () => (await http.get('/continuation-policy')).data,
      }),
    };
    const continueAfterSwitch = createConnectedServiceContinuationHandler(options);
    const switched = { sessionId, attemptId: 'deferred-switch', action: 'restart_requested' as const };
    await expect(continueAfterSwitch(switched)).rejects.toThrow('Home policy unavailable');
    expect(http.post).not.toHaveBeenCalled();
    policyAvailable = true;
    await continueAfterSwitch(switched);
    expect(http.post).not.toHaveBeenCalled();
    resumePromptMode = 'standard';
    await continueAfterSwitch(switched);
    expect(http.post).toHaveBeenCalledOnce();
  });
  it.each([90, 150])('retains recovery until the same failed turn projects (observedAt=%s)', async observedAt => {
    const input = fixture({ latestTurnId: 'interrupted-turn', latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: observedAt, lastRuntimeIssue: null });
    const classification: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', serviceId, groupId: 'pool', profileId: 'A',
      resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' };
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials });
    const consumedIds = new Set<string>();
    // The server retains local-ID dedupe after a Pending row is consumed.
    http.post.mockImplementation(async (_url: string, body: { localId: string }) => {
      const didWrite = !consumedIds.has(body.localId);
      consumedIds.add(body.localId);
      return { status: 200, data: { didWrite, terminal: false } };
    });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 110,
      recover: async ({ interruptedOriginId }) => {
          await dispatcher.enqueueInterruptedOriginContinuation({ sessionId, attemptId: 'switch-B', interruptedOriginId: interruptedOriginId ?? 'durable-recovery-A',
            interruption: 'provider_failed_turn', resumePromptMode: 'standard',
            runtimeAuthRecovery: { armedAtMs: 110, isCurrent: () => true, readActiveTurnId: () => 'interrupted-turn' } });
        return { status: 'switch_attempted', result: { status: 'observed_generation', activeProfileId: 'B', generation: 2 } };
      },
    });
    try {
      await scheduler.enqueueHandlerFailure({ sessionId, classification, switchesThisTurn: 0,
        error: Object.assign(new Error('endpoint unavailable'), { code: 'ECONNRESET' }) });
      await scheduler.wake({ sessionId, reason: 'manual' });
      expect(http.post).not.toHaveBeenCalled();
      expect(scheduler.readForSession(sessionId)[0]).toMatchObject({ status: 'waiting' });
      const read = http.get.getMockImplementation()!;
      http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
        ? { status: 200, data: { session: { ...input.rawSession, latestTurnStatus: 'failed', latestTurnStatusObservedAt: 150, lastRuntimeIssue: issue } } }
        : read(url));
      await scheduler.wake({ sessionId, reason: 'manual' });
      await scheduler.wake({ sessionId, reason: 'manual' });
      expect(consumedIds.size).toBe(1);
      expect(scheduler.readForSession(sessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof' });
    } finally { scheduler.dispose(); }
  });

  it.each([
    { status: 'in_progress', observedAt: 150, failureAt: 100, activeTurn: 'new-user-turn', admitted: false },
    { status: 'completed', observedAt: 150, failureAt: 100, activeTurn: null, admitted: false },
    { status: 'failed', observedAt: 150, failureAt: 150, activeTurn: null, admitted: false },
    { status: 'failed', observedAt: 100, failureAt: 100, activeTurn: 'new-user-turn', admitted: false },
    { status: 'failed', observedAt: 150, failureAt: 100, activeTurn: 'interrupted-turn', admitted: true },
  ] as const)('protects newer consumed user work ($status/$activeTurn)', async ({ status, observedAt, failureAt, activeTurn, admitted }) => {
    fixture({ latestTurnId: 'interrupted-turn', latestTurnStatus: status, latestTurnStatusObservedAt: observedAt,
      lastRuntimeIssue: { ...issue, occurredAt: failureAt } });
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials });
    const result = await dispatcher.enqueueInterruptedOriginContinuation({ sessionId, attemptId: 'switch-B', interruptedOriginId: 'durable-recovery-A',
      interruption: 'provider_failed_turn', resumePromptMode: 'standard',
      runtimeAuthRecovery: { armedAtMs: 110, isCurrent: () => true, readActiveTurnId: () => activeTurn } });
    expect(result.status).toBe(admitted ? 'enqueued' : 'suppressed_newer_user_input');
    expect(http.post).toHaveBeenCalledTimes(admitted ? 1 : 0);
  });
  beforeEach(() => {
    vi.resetAllMocks();
    http.post.mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false } });
  });

  it.each([true, false])('admits an ordinary send-now continuation with active projection=%s', async (active) => {
    const input = fixture({ active });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
      expect.objectContaining({ localId: expect.stringMatching(/^connected-service-continuation:/),
        deliveryMode: 'continuation_if_no_queued_user_input', requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: expect.objectContaining({ role: 'user', content: {
          type: 'text', text: 'Usage limits are lifted. Continue where you left off.',
        } }) },
      }), expect.anything());
    expect(http.post).toHaveBeenCalledOnce();
  });

  it.each([true, false])('settles an accepted auth refresh during Pending admission only for the same known quota subject (known=%s)', async (knownSubject) => {
    const continuation = fixture();
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let storedRevision = revisionA;
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 123, agentId: 'claude', sessionId, materializationKey: 'continuation-refresh-test',
      connectedServicesBindingsRaw: continuation.metadata.connectedServices,
      connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile', serviceId, profileId: 'account-1', credentialRevision: revisionA,
      }]) },
    });
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes('/v4/connect/qualified/credential')
      ? { status: 200, data: {
        ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'account-1' },
        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: storedRevision,
        configurationRevision: null, metadata: { scopes: [] },
        content: { t: 'plain', v: { v: 1, values: { accessToken: 'test-token', providerAccountId: 'quota-subject' } } },
      } } : read(url));
    const readAccount = async () => {
      const material = await readQualifiedConnectedAccountCredentialMaterial({
        credentials, account: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'account-1' },
        getAccountEncryptionMode: async () => 'plain',
      });
      return material ? { providerAccountId: material.credential.values.providerAccountId ?? null,
        credentialRevision: material.snapshot.credentialRevision } : null;
    };
    // The plugin process/credential bridge is the only refresh boundary fixture.
    const refresh = createSessionConnectedServiceRuntimeAuthRefreshHandler({ registry,
      resolveDaemonAuthBridge: async () => ({ registration: { serviceId, refresh: async () => {
        storedRevision = revisionB;
        return { status: 'refreshed', result: { credentialRevision: revisionB } };
      } } }),
    });
    const account = await readAccount();
    if (!account) throw new Error('Expected qualified account fixture');
    http.post.mockImplementation(async () => {
      expect(await refresh({ sessionId, refreshAttemptId: 'accepted-during-pending',
        selection: { kind: 'profile', serviceId, profileId: 'account-1' }, expectedCredentialRevision: revisionA }))
        .toMatchObject({ ok: true, result: { status: 'refreshed' } });
      expect(registry.getBySessionId(sessionId)?.activeBindings[0]?.credentialRevision).toBe(revisionB);
      return { status: 200, data: { didWrite: true, terminal: false } };
    });
    const classification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit', limitCategory: 'usage_limit', serviceId, profileId: 'account-1', groupId: null,
      resetsAtMs: 200, retryAfterMs: null, quotaScope: 'account', providerLimitId: null,
      action: null, planType: null, rateLimits: null, source: 'structured_provider_error',
      expectedCredentialRevision: revisionA, ...(knownSubject ? { sourceProviderAccountId: 'quota-subject' } : {}),
    };
    const result = await continueAccountQualifiedSessionAfterUsageLimitReset({
      continuation, classification, readAccount,
      readActiveBinding: () => registry.getBySessionId(sessionId)?.activeBindings.find((binding) => binding.serviceId === serviceId),
    });
    expect(http.post).toHaveBeenCalledOnce();
    expect(result).toEqual(knownSubject
      ? { status: 'continuation_enqueued', credentialRevision: revisionB }
      : { status: 'recovery_superseded' });
  });

  it('does not admit an attempt cancelled during Session lookup', async () => {
    const input = fixture();
    let current = true;
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (...args: unknown[]) => {
      const result = await read(...args);
      if (String(args[0]).includes(`/v2/sessions/${sessionId}`)) current = false;
      return result;
    });
    expect(await continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current }))
      .toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    { latestTurnStatus: 'completed' as const },
    { latestTurnId: 'newer-canonical-turn' },
    { lastRuntimeIssue: { ...issue, agentTurnId: 'newer-turn', occurredAt: 120 } },
    { lastRuntimeIssue: { ...issue, usageLimit: { ...issue.usageLimit!, connectedService: {
      serviceId, profileId: 'account-2', groupId: null,
    } } } },
  ])('suppresses newer turn or account evidence found at admission: %j', async (fresh) => {
    const input = fixture();
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: { ...input.rawSession, ...fresh } } } : read(url));
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('retains one Pending identity across retry without reconstructing the interrupted input', async () => {
    const input = fixture();
    await continueSessionAfterUsageLimitReset(input);
    http.post.mockResolvedValueOnce({ status: 200, data: { didWrite: false, terminal: false } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(http.post.mock.calls[1]?.[1]).toEqual(http.post.mock.calls[0]?.[1]);
  });

  it('honors atomic Pending suppression when user input is queued', async () => {
    const input = fixture();
    http.post.mockResolvedValue({ status: 200, data: { didWrite: false, terminal: false, suppressed: true } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
  });

  it('honors continuation turned off during an owned usage-limit wait', async () => {
    const input = fixture();
    const currentRecovery = { ...recovery, resumePromptMode: 'custom' as const };
    input.metadata.sessionUsageLimitRecoveryV1 = { ...input.metadata.sessionUsageLimitRecoveryV1, ...recovery, resumePromptMode: 'off' };
    const read = http.get.getMockImplementation()!;
    const freshMetadata = { ...input.metadata, sessionUsageLimitRecoveryV1: { ...recovery, resumePromptMode: 'off' } };
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: { ...input.rawSession, metadata: JSON.stringify(freshMetadata) } } } : read(url));
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: currentRecovery,
      customResumePrompt: 'Continue from the authoritative custom mode' })).toEqual({ status: 'disabled' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('reads current policy at continuation and leaves an unreadable policy retryable', async () => {
    const input = fixture();
    const read = http.get.getMockImplementation()!;
    let policyAvailable = false;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/continuation-policy')) {
        if (!policyAvailable) throw new Error('Home policy unavailable');
        return { data: { resumePromptMode: 'off' } };
      }
      return read(url);
    });
    const continuation = { ...input, resolveResumePromptMode: () => resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadGroupPolicy: async () => (await http.get('/continuation-policy')).data,
    }) };
    await expect(continueSessionAfterUsageLimitReset(continuation)).rejects.toThrow('Home policy unavailable');
    expect(http.post).not.toHaveBeenCalled();
    policyAvailable = true;
    expect(await continueSessionAfterUsageLimitReset(continuation)).toEqual({ status: 'disabled' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('does not continue after the qualified Session account binding changes', async () => {
    const input = fixture();
    input.metadata.connectedServices.bindingsByServiceId[serviceId]!.profileId = 'replacement-account';
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'exhausted', 'paused'] as const)('does not revive a terminal owned attempt: %s', async (status) => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, status } }))
      .toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    ['Resume the interrupted work', 'Resume the interrupted work'],
    ['', USAGE_LIMIT_CONTINUATION_RESUME_PROMPT],
    ['   ', USAGE_LIMIT_CONTINUATION_RESUME_PROMPT],
  ])('freezes custom continuation or its default before Pending custody (%j)', async (customResumePrompt, expectedPrompt) => {
    const input = fixture();
    const customRecovery = { ...recovery, resumePromptMode: 'custom' as const };
    input.metadata.sessionUsageLimitRecoveryV1 = { ...input.metadata.sessionUsageLimitRecoveryV1, ...customRecovery };
    await continueSessionAfterUsageLimitReset({ ...input, recovery: customRecovery,
      customResumePrompt });
    expect(http.post.mock.calls[0]?.[1]).toMatchObject({ content: { t: 'plain', v: { content: {
      type: 'text', text: expectedPrompt,
    } } } });
  });

  it('does not report continued when Pending acceptance is unknown', async () => {
    const input = fixture();
    http.post.mockRejectedValue(new Error('acknowledgement lost'));
    await expect(continueSessionAfterUsageLimitReset(input)).rejects.toThrow('continuation_prompt_send_failed:timeout');
  });

  it('preserves already-admitted input when cancellation follows acceptance', async () => {
    const input = fixture();
    let current = true;
    http.post.mockImplementation(async () => {
      current = false;
      return { status: 200, data: { didWrite: true, terminal: false } };
    });
    const run = () => continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(http.post).toHaveBeenCalledOnce();
  });

  it('uses the canonical failed turn when the issue has no native turn id', async () => {
    const input = fixture({ lastRuntimeIssue: { ...issue, agentTurnId: undefined } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
  });

  it('does not resurrect an old issue after a completed turn', async () => {
    expect(await continueSessionAfterUsageLimitReset(fixture({ latestTurnStatus: 'completed' })))
      .toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('waits until the reset and honors disabled continuation', async () => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, nowMs: 199 })).toEqual({ status: 'not_ready' });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, resumePromptMode: 'off' } }))
      .toEqual({ status: 'disabled' });
    const unownedRecovery = { ...recovery, runtimeAuthRecoveryAttemptId: undefined };
    input.metadata.sessionUsageLimitRecoveryV1 = { ...input.metadata.sessionUsageLimitRecoveryV1, ...unownedRecovery, resumePromptMode: 'off' };
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: unownedRecovery }))
      .toEqual({ status: 'disabled' });
    expect(http.post).not.toHaveBeenCalled();
  });
});
