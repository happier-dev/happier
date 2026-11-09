import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { createDaemonControlApp } from './controlServer';
import { RuntimeAuthRecoveryScheduler } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { handleConnectedServiceRuntimeAuthFailure } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/types';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';
import { authorizeConnectedServiceRuntimeAuthFailureSource, handleConnectedServiceRuntimeAuthFailureForSession } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2 } from './connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceAuthGroupSwitchState } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { readConnectedServiceRuntimeAuthFailureSourceBinding } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { enqueueRuntimeAuthFailureReportOutboxItem, readRuntimeAuthFailureReportOutboxItems } from './connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import { drainRuntimeAuthFailureReportOutboxToDaemon } from './connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxDrain';
import type { RuntimeAuthFailureReportIntake } from './controlServer';
import { createRuntimeAuthRecoverySchedulerForDaemon } from './connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon';
import { createConnectedServiceContinuationMessageDispatcher } from './connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import { resolveConnectedServiceContinuationOriginId } from './connectedServices/continuation/switchRecovery';

describe('registered runtime-auth failure recovery', () => {
  it.each(['plan', 'usage_limit', 'rate_limit'] as const)('does not admit model-scoped %s to account recovery', async kind => {
    const recover = (input: Readonly<{ sessionId: string; classification: ConnectedServiceRuntimeFailureClassification }>) =>
      handleConnectedServiceRuntimeAuthFailure({ ...input, switchesThisTurn: 0, switchCoordinator: null,
        selection: { kind: 'profile', serviceId: input.classification.serviceId, profileId: 'primary' } });
    const scheduler = new RuntimeAuthRecoveryScheduler({ recover });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      runtimeAuthRecoveryScheduler: scheduler, handleConnectedServiceRuntimeAuthFailure: recover });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'model-refusal',
          classification: { kind, serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary', groupId: null,
            quotaScope: 'model', providerLimitId: 'gpt-6.1-sol', resetsAtMs: null, planType: null, rateLimits: null,
            source: 'structured_provider_error' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, result: { status: 'not_classified' } });
      expect(response.json().recoveryReceipt).toBeUndefined();
      expect(scheduler.readForSession('model-refusal')).toEqual([]);
    } finally { scheduler.dispose(); await app.close(); }
  });
  it.each([... [null, 'csr_aaaaaaaaaaaaaaaaaaaaaa'].flatMap(commitRevision =>
    (['aligned', 'newer_same_account', 'lagging'] as const).map(observation => ({ commitRevision, observation })),
  ), { commitRevision: null, observation: 'unproven_then_registered' as const }])('settles verified recipient activity despite $observation observation (commit=$commitRevision)', async ({ commitRevision, observation }) => {
    const serviceId = 'happier.agent.codex/openai-codex';
    const actualRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const tracked = { startedBy: 'daemon' as const, happySessionId: 'actual-revision', pid: 123 };
    let current: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'A', generation: 1,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, autoSwitch: true, strategy: 'priority' },
      members: ['A', 'B'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
      memberStatesByProfileId: new Map([['B', { quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: 60 } }]]),
    };
    let runtime = { serviceId, groupId: 'pool', profileId: 'A', generation: 1, credentialRevision: current.credentialRevision ?? null };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => current = { ...current, activeProfileId: toProfileId, generation: 2, credentialRevision: commitRevision },
      // Home CAS and provider application are boundaries; result mapping and proof settlement remain real.
      applyGeneration: async () => {
        current = observation === 'lagging'
          ? { ...current, activeProfileId: 'A', generation: 1, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' }
          : { ...current, credentialRevision: observation === 'aligned' || observation === 'unproven_then_registered' ? actualRevision : 'csr_cccccccccccccccccccccc' };
        runtime = { ...runtime, profileId: 'B', generation: 2, credentialRevision: actualRevision };
        if (observation === 'unproven_then_registered') return { ok: true, mode: 'restart_resume' };
        return { ok: true, mode: 'hot_apply', verificationByServiceId: { [serviceId]: {
          status: 'verified', proofStrength: 'exact', providerAccountId: 'provider-B', credentialRevision: actualRevision,
          generationApplication: { serviceId, groupId: 'pool', profileId: 'B', generation: 2, credentialRevision: actualRevision,
            credentialFingerprint: 'fixture-provider-B' },
        } } };
      },
    });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, jitterMs: () => 0,
      recover: input => handleConnectedServiceRuntimeAuthFailureForSession({ ...input, getChildren: () => [tracked],
        switchCoordinator: coordinator, resolveRegisteredRuntimeAuthFailureSource: async () => runtime }),
    });
    try {
      const classification: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account',
        serviceId, groupId: 'pool', profileId: 'A', groupGeneration: 1, expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' };
      await scheduler.beginClassifiedFailure({ reportId: 'runtime-auth-report:actual-revision',
        sessionId: tracked.happySessionId, classification, switchesThisTurn: 0 });
      await scheduler.wake({ sessionId: tracked.happySessionId, reason: 'manual' });
      expect(scheduler.readForSession(tracked.happySessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof',
        pendingTargetProfileId: 'B', pendingTargetGeneration: 2,
        pendingTargetCredentialRevision: observation === 'unproven_then_registered' ? null : actualRevision });
      if (observation === 'unproven_then_registered') {
        expect(await scheduler.markProviderOutcomeProofByIdentity({ sessionId: tracked.happySessionId, proofKind: 'provider_activity',
          serviceId, groupId: 'pool', profileId: 'B', groupGeneration: 2, credentialRevision: actualRevision, observedAtMs: 1_001 })).toEqual([]);
        // The existing retry owner can reconstruct a target from the now-registered
        // recipient; null itself never admits the activity as a wildcard.
        await scheduler.wake({ sessionId: tracked.happySessionId, reason: 'manual' });
        expect(scheduler.readForSession(tracked.happySessionId)[0]).toMatchObject({ pendingTargetCredentialRevision: actualRevision });
      }
      expect(await scheduler.markProviderOutcomeProofByIdentity({ sessionId: tracked.happySessionId, proofKind: 'provider_activity',
        serviceId, groupId: 'pool', profileId: 'B', groupGeneration: 2, credentialRevision: actualRevision, observedAtMs: 1_001 }))
        .toEqual([expect.objectContaining({ status: 'recovered' })]);
      expect(scheduler.readForSession(tracked.happySessionId)[0]).toMatchObject({ status: 'recovered' });
    } finally { scheduler.dispose(); }
  });
  it('retains an unreadable continuation policy as failed intake without starting recovery', async () => {
    let handled = 0;
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      resolveConnectedServiceRuntimeAuthResumePromptMode: async () => { throw new Error('Home policy unavailable'); },
      handleConnectedServiceRuntimeAuthFailure: async () => { handled++; return { status: 'noop' }; },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'waiting',
          classification: { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary', groupId: 'pool',
            resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } } });
      expect(response.json()).toMatchObject({ ok: false, errorCode: 'connected_service_runtime_auth_recovery_intake_failed' });
      expect(handled).toBe(0);
    } finally { await app.close(); }
  });
  it.each(['hot_apply', 'spawn_next_turn', 'quota_reset', 'credential_refresh_same_daemon', 'credential_refresh_replacement', 'interrupted_hot_apply', 'interrupted_spawn_next_turn'] as const)(
    'keeps one consumed Pending identity across recovery replay (%s)', async scenario => {
    const interrupted = scenario.startsWith('interrupted_');
    let releaseInitial = () => {};
    const initialAcknowledgement = new Promise<void>(resolve => { releaseInitial = resolve; });
    const credentialRefresh = scenario.startsWith('credential_refresh');
    const quotaReset = scenario === 'quota_reset' || credentialRefresh;
    const mode = scenario.endsWith('spawn_next_turn') ? 'spawn_next_turn' : 'hot_apply';
    const directory = await createTempDir('happier-recovery-origin-');
    const serviceId = 'happier.agent.codex/openai-codex';
    const credentials = { token: 'test', encryption: null };
    const consumed = new Set<string>();
    const sends: string[] = [];
    const recoveries: unknown[] = [];
    let resets = 0;
    let applications = 0;
    const tracked = { startedBy: 'daemon' as const, happySessionId: 'stopped', pid: 123 };
    let current: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'A', generation: 1,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, autoSwitch: true, strategy: 'priority',
        autoUseQuotaResetsWhenExhausted: quotaReset },
      members: (quotaReset ? ['A'] : ['A', 'B']).map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
      memberStatesByProfileId: new Map([[quotaReset ? 'A' : 'B', {
        quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: quotaReset ? 0 : 60,
          ...(quotaReset ? { meters: [{ meterId: 'weekly', limitCategory: 'usage_limit' as const,
            remainingPct: 0, resetAtMs: null, providerLimitId: 'weekly' }] } : {}),
        },
      }]]),
    };
    let runtime = { serviceId, groupId: 'pool', profileId: 'A', generation: 1, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
      loadState: async () => current,
      consumeAvailableRecoveryCreditForProfile: async () => {
        resets++;
        current = { ...current, memberStatesByProfileId: new Map([['A', {
          quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: 60 },
        }]]) };
        return { ok: true, snapshot: null, receipt: { status: 'consumed', idempotencyKey: 'reset:A' } };
      },
      commitSwitch: async ({ toProfileId }) => current = { ...current, activeProfileId: toProfileId, generation: 2, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
      applyGeneration: async () => { applications++;
        if (!quotaReset) runtime = { ...runtime, profileId: 'B', generation: 2, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' };
        return { ok: true, mode }; },
    });
    const recover = async (input: { sessionId: string; switchesThisTurn?: number; classification: ConnectedServiceRuntimeFailureClassification;
      interruptedOriginId?: string; recoveryInvocationSource?: 'scheduler_retry' }) => {
      const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials,
        // Durable Pending is the network boundary; consumed IDs outlive both daemon instances.
        sendMessage: async ({ localId }) => { if (!localId) throw new Error('Missing Pending identity');
          sends.push(localId); consumed.add(localId);
          if (interrupted && sends.length === 1) await initialAcknowledgement;
          return { ok: true, sessionId: input.sessionId, localId, waited: false,
            admissionResult: { status: 'accepted', localId } }; },
      });
      const result = await handleConnectedServiceRuntimeAuthFailureForSession({ ...input, getChildren: () => [tracked], switchCoordinator: coordinator,
        resolveRegisteredRuntimeAuthFailureSource: async () => runtime,
        continueAfterRuntimeAuthSwitch: async ({ attemptId }) => {
          const origin = resolveConnectedServiceContinuationOriginId({ source: input.recoveryInvocationSource ?? 'daemon_report',
            activeTurnId: 'different-new-user-turn', reportId: input.interruptedOriginId });
          if (!origin) throw new Error('Missing continuation origin');
          await dispatcher.enqueueInterruptedOriginContinuation({ sessionId: input.sessionId, attemptId, interruptedOriginId: origin,
            interruption: 'provider_failed_turn', resumePromptMode: 'standard' });
        },
      });
      recoveries.push(result);
      return result;
    };
    const makeScheduler = () => createRuntimeAuthRecoverySchedulerForDaemon({ activeServerDir: directory,
      nowMs: () => 1_000, jitterMs: () => 0, recover });
    const first = makeScheduler();
    let replacement: RuntimeAuthRecoveryScheduler | undefined;
    let intake: RuntimeAuthFailureReportIntake | undefined;
    let pendingIntake: Promise<unknown> | undefined;
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, runtimeAuthRecoveryScheduler: first,
      onRuntimeAuthFailureReportIntakeReady: value => { intake = value; }, handleConnectedServiceRuntimeAuthFailure: recover });
    try {
      if (!intake) throw new Error('Missing report intake');
      const classification: ConnectedServiceRuntimeFailureClassification = {
        kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account', serviceId, groupId: 'pool', profileId: 'A',
        groupGeneration: 1, expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', resetsAtMs: null,
        planType: null, rateLimits: null, source: 'structured_provider_error' };
      if (quotaReset) {
        await first.enqueueHandlerFailure({ reportId: 'runtime-auth-report:consumed-origin', sessionId: 'stopped',
          classification, switchesThisTurn: 0, error: Object.assign(new Error('offline'), { code: 'ECONNRESET' }) });
        await first.wake({ sessionId: 'stopped', reason: 'manual' });
        expect(resets).toBe(1);
      } else {
        pendingIntake = intake({ reportId: 'runtime-auth-report:consumed-origin', sessionId: 'stopped', classification });
        if (interrupted) await vi.waitFor(() => expect(sends).toHaveLength(1));
        else await pendingIntake;
      }
      expect(first.readForSession('stopped')[0]).toMatchObject(interrupted
        ? { status: 'waiting', lastSettledTransition: 'working', nextRetryAtMs: null }
        : { status: 'resumed_awaiting_proof' });
      expect(sends).toHaveLength(1);
      const originalAttemptId = first.readForSession('stopped')[0]?.attemptId;
      if (interrupted) {
        first.hydrate();
        first.hydrate();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(sends).toHaveLength(1);
      }
      if (credentialRefresh) {
        runtime = { ...runtime, credentialRevision: 'csr_cccccccccccccccccccccc' };
        current = { ...current, credentialRevision: runtime.credentialRevision };
      }
      if (quotaReset) current = { ...current, memberStatesByProfileId: new Map([['A', {
        quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: 60 },
      }]]) };
      if (scenario === 'credential_refresh_same_daemon') {
        await first.wake({ sessionId: 'stopped', reason: 'manual' });
      } else {
        first.dispose();
        replacement = makeScheduler();
        expect(sends).toHaveLength(1);
        if (interrupted) {
          replacement.hydrate();
          replacement.hydrate();
          await vi.waitFor(() => {
            const intent = replacement!.readForSession('stopped')[0];
            expect(intent, JSON.stringify({ lastError: intent?.lastError })).toMatchObject({ status: 'resumed_awaiting_proof' });
          });
        } else await replacement.wake({ sessionId: 'stopped', reason: 'manual' });
      }
      expect(sends).toHaveLength(2);
      if (credentialRefresh) expect(recoveries.at(-1)).toMatchObject({ status: 'credential_refreshed',
        generation: 1, pendingProviderOutcome: true });
      expect(consumed.size).toBe(1);
      if (credentialRefresh) expect(applications).toBe(1);
      if (quotaReset) expect(resets).toBe(1);
      expect((replacement ?? first).readForSession('stopped')[0]).toMatchObject({ status: 'resumed_awaiting_proof', attemptId: originalAttemptId });
    } finally {
      first.dispose(); replacement?.dispose(); releaseInitial(); await pendingIntake;
      await app.close(); await removeTempDir(directory);
    }
  });
  it.each([1, undefined])('defers adopted late reports to scheduler custody (generation=%s)', async groupGeneration => {
    const serviceId = 'happier.agent.codex/openai-codex';
    const tracked = { startedBy: 'daemon' as const, happySessionId: 'late-report', pid: 124 };
    const current: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'B', generation: 2,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb', policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
      members: [{ profileId: 'B', priority: 0, enabled: true, createdAtMs: 1 }],
      memberStatesByProfileId: new Map([['B', { quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: 60 } }]]),
    };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
      loadState: async () => current,
      commitSwitch: async () => { throw new Error('A late report must not select another account'); },
      applyGeneration: async () => { throw new Error('The registered target is already adopted'); },
    });
    const sends: string[] = [];
    const resolveRegisteredRuntimeAuthFailureSource = async () => ({ serviceId, groupId: 'pool', profileId: 'B', generation: 2,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' });
    const recover = async (input: Omit<Parameters<NonNullable<Parameters<typeof createDaemonControlApp>[0]['handleConnectedServiceRuntimeAuthFailure']>>[0], 'switchesThisTurn'> & { switchesThisTurn?: number }) =>
      await handleConnectedServiceRuntimeAuthFailureForSession({ ...input, getChildren: () => [tracked],
        switchCoordinator: coordinator, resolveRegisteredRuntimeAuthFailureSource,
        continueAfterRuntimeAuthSwitch: async ({ attemptId }) => { sends.push(attemptId); },
      });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, jitterMs: () => 0, recover });
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, runtimeAuthRecoveryScheduler: scheduler,
      authorizeConnectedServiceRuntimeAuthFailure: input => authorizeConnectedServiceRuntimeAuthFailureSource({ ...input,
        getChildren: () => [tracked], resolveRegisteredRuntimeAuthFailureSource }),
      handleConnectedServiceRuntimeAuthFailure: recover,
    });
    const classification: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', limitCategory: 'usage_limit',
      quotaScope: 'account', serviceId, groupId: 'pool', profileId: 'A', groupGeneration,
      expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', resetsAtMs: null,
      planType: null, rateLimits: null, source: 'structured_provider_error' };
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { reportId: 'runtime-auth-report:late-report', sessionId: tracked.happySessionId, classification } });
      expect(response.json()).toMatchObject({ ok: true, result: { status: 'recovery_retry_scheduled' },
        recoveryReceipt: { reportId: 'runtime-auth-report:late-report', attemptId: expect.any(String) } });
      expect(scheduler.readForSession(tracked.happySessionId)).toEqual([expect.objectContaining({ status: 'waiting',
        lastSettledTransition: 'scheduled', nextRetryAtMs: 2_000 })]);
      expect(sends).toEqual([]);
      // Only the admitted scheduler retry can continue on the proven current target.
      await scheduler.wake({ sessionId: tracked.happySessionId, reason: 'manual' });
      expect(sends).toHaveLength(1);
      expect(scheduler.readForSession(tracked.happySessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof',
        pendingTargetProfileId: 'B', pendingTargetGeneration: 2 });
    } finally { scheduler.dispose(); await app.close(); }
  });
  it('shares authorized report intake and report-ID custody between startup outbox and HTTP', async () => {
    const outboxDir = await createTempDir('happier-startup-report-intake-');
    let intake: RuntimeAuthFailureReportIntake | undefined;
    let authorizations = 0;
    const classification: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'A', groupId: 'pool', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' };
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      onRuntimeAuthFailureReportIntakeReady: value => { intake = value; },
      authorizeConnectedServiceRuntimeAuthFailure: async input => { authorizations++;
        return await authorizeConnectedServiceRuntimeAuthFailureSource({ ...input, getChildren: () => [] }); },
      handleConnectedServiceRuntimeAuthFailure: input => handleConnectedServiceRuntimeAuthFailureForSession({ ...input,
        getChildren: () => [], switchCoordinator: null }),
    });
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({ outboxDir, report: { sessionId: 'stopped', switchesThisTurn: 0, classification } });
      const [item] = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      if (!intake || !item) throw new Error('Daemon in-process report intake unavailable');
      expect(await drainRuntimeAuthFailureReportOutboxToDaemon({ outboxDir, notify: intake })).toMatchObject({ dropped: 1, retried: 0 });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { reportId: item.reportId, sessionId: 'stopped', classification } });
      expect(response.json()).toMatchObject({ ok: true, result: { status: 'session_not_found' } });
      expect(authorizations).toBe(1);
    } finally { await app.close(); await removeTempDir(outboxDir); }
  });
  it('retires a native-login report before arming any daemon recovery attempt', async () => {
    const tracked = { startedBy: 'daemon' as const, pid: 224, happySessionId: 'native-login', spawnOptions: { directory: '/project' } };
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: Date.now,
      recover: async () => { throw new Error('Native login has no daemon Account attempt'); } });
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, runtimeAuthRecoveryScheduler: scheduler,
      authorizeConnectedServiceRuntimeAuthFailure: input => authorizeConnectedServiceRuntimeAuthFailureSource({ ...input,
        getChildren: () => [tracked], resolveRegisteredRuntimeAuthFailureSource: async () => null }),
      handleConnectedServiceRuntimeAuthFailure: input => handleConnectedServiceRuntimeAuthFailureForSession({ ...input,
        getChildren: () => [tracked], switchCoordinator: null }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { reportId: 'runtime-auth-report:native-login', sessionId: tracked.happySessionId,
          classification: { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex', profileId: null, groupId: null,
            quotaScope: 'account', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } } });
      expect(response.json()).toEqual({ ok: true, result: { status: 'not_applicable', reason: 'no_connected_service_binding' } });
      expect(scheduler.readForSession(tracked.happySessionId)).toEqual([]);
    } finally { scheduler.dispose(); await app.close(); }
  });
  it('recovers an unattributed provider-started pool turn without assigning its failure to a member', async () => {
    const serviceId = 'happier.agent.codex/openai-codex';
    const tracked = { startedBy: 'daemon' as const, pid: 223, happySessionId: 'provider-started-pool', spawnOptions: { directory: '/project' } };
    const sourceBinding = { serviceId, groupId: 'pool', profileId: 'primary', generation: 1,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' };
    let state: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'primary',
      generation: 1, runtimeStateRevision: 0,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, strategy: 'priority', autoSwitch: true },
      members: [{ profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true }],
      memberStatesByProfileId: new Map([['primary', { exhaustedUntilMs: Date.now() + 60_000 }]]),
    };
    const observedMembers: Array<string | null | undefined> = [];
    const applied: Array<string | null> = [];
    // Home group storage/CAS and Session generation application are genuine boundaries.
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({ leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: Date.now, loadState: async () => state,
      recordObservedFailureState: async input => { observedMembers.push(input.observedProfileId); },
      commitSwitch: async ({ toProfileId }) => (state = { ...state, activeProfileId: toProfileId, generation: 2 }),
      applyGeneration: async input => { applied.push(input.activeProfileId); return { ok: true, mode: 'hot_apply' }; },
    });
    const authorize = (input: { sessionId: string; classification: ConnectedServiceRuntimeFailureClassification | null }) =>
      authorizeConnectedServiceRuntimeAuthFailureSource({ ...input, getChildren: () => [tracked],
        resolveRegisteredRuntimeAuthFailureSource: async () => sourceBinding });
    const recover = async (input: Parameters<typeof handleConnectedServiceRuntimeAuthFailureForSession>[0]) =>
      await handleConnectedServiceRuntimeAuthFailureForSession(input);
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: Date.now, jitterMs: () => 0,
      recover: async input => recover({ ...input, getChildren: () => [tracked], switchCoordinator: coordinator,
        resolveRegisteredRuntimeAuthFailureSource: async () => sourceBinding }) });
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, runtimeAuthRecoveryScheduler: scheduler,
      authorizeConnectedServiceRuntimeAuthFailure: authorize,
      handleConnectedServiceRuntimeAuthFailure: input => recover({ ...input, getChildren: () => [tracked], switchCoordinator: coordinator }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { reportId: 'runtime-auth-report:provider-goal',
          sessionId: tracked.happySessionId, classification: { kind: 'usage_limit', serviceId, profileId: null, groupId: null,
            quotaScope: 'account', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, result: { status: 'switch_attempted', result: { status: 'switched' } },
        recoveryReceipt: { reportId: 'runtime-auth-report:provider-goal' } });
      expect(state.activeProfileId).toBe('backup');
      expect(observedMembers.every(member => member === null)).toBe(true);
      expect(applied).toEqual(['backup']);
      expect(scheduler.readForSession(tracked.happySessionId)).toEqual([expect.objectContaining({
        profileId: null, classification: expect.objectContaining({ profileId: null, groupId: 'pool' }),
      })]);
    } finally { scheduler.dispose(); await app.close(); }
  });
  it('resolves group continuation policy after evidence-only Session failure receives its current binding', async () => {
    const serviceId = 'happier.agent.claude/claude-subscription';
    const tracked = { startedBy: 'daemon' as const, pid: 222, happySessionId: 'evidence-session', spawnOptions: { directory: '/project' } };
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ pid: tracked.pid, sessionId: tracked.happySessionId, agentId: 'claude',
      connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'current-pool' } } },
      connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{ kind: 'group', serviceId,
        groupId: 'current-pool', activeProfileId: 'current-member', fallbackProfileId: 'old', generation: 7,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }]) } });
    const unexpectedGroupEffect = async (): Promise<never> => { throw new Error('Capacity must not switch Accounts'); };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({ leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000, loadState: unexpectedGroupEffect, commitSwitch: unexpectedGroupEffect, applyGeneration: unexpectedGroupEffect });
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      authorizeConnectedServiceRuntimeAuthFailure: input => authorizeConnectedServiceRuntimeAuthFailureSource({ ...input, getChildren: () => [tracked],
        resolveRegisteredRuntimeAuthFailureSource: async () => readConnectedServiceRuntimeAuthFailureSourceBinding(registry.getBySessionId(tracked.happySessionId)!, serviceId) }),
      resolveConnectedServiceRuntimeAuthResumePromptMode: ({ classification, explicit }) => resolveRoutedUsageLimitRecoveryResumePromptMode({ explicit,
        accountSettings: { resumePromptMode: 'standard' },
        loadGroupPolicy: async () => classification.groupId === 'current-pool' ? { resumePromptMode: 'off' } : null }),
      handleConnectedServiceRuntimeAuthFailure: input => handleConnectedServiceRuntimeAuthFailure({ ...input,
        selection: registry.getBySessionId(tracked.happySessionId)!.connectedServiceSelections[0]!, switchCoordinator: coordinator }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: tracked.happySessionId,
          classification: { kind: 'capacity', serviceId, profileId: null, groupId: null, limitCategory: 'capacity', quotaScope: 'provider',
            resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, resumePromptMode: 'off' });
    } finally { await app.close(); }
  });
  it('arms the exact token-qualified profile quota attempt through the registered failure route', async () => {
    const nowMs = Date.now();
    const resetAtMs = nowMs + 60_000;
    const unexpectedGroupEffect = async (): Promise<never> => { throw new Error('Unexpected group recovery effect'); };
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => nowMs,
      loadState: unexpectedGroupEffect,
      commitSwitch: unexpectedGroupEffect, applyGeneration: unexpectedGroupEffect,
    });
    const recover = async (input: Readonly<{ sessionId: string; classification: ConnectedServiceRuntimeFailureClassification; switchesThisTurn?: number }>) =>
      await handleConnectedServiceRuntimeAuthFailure({ ...input,
        selection: { kind: 'profile', serviceId: input.classification.serviceId, profileId: 'primary' },
        switchCoordinator,
      });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => nowMs, jitterMs: () => 0, recover });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      runtimeAuthRecoveryScheduler: scheduler, handleConnectedServiceRuntimeAuthFailure: recover,
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: {
          reportId: 'runtime-auth-report:qualified-profile-quota', sessionId: 'qualified-profile-quota',
          classification: { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex',
            profileId: 'primary', groupId: null, quotaScope: 'account', resetsAtMs: resetAtMs,
            sourceProviderAccountId: 'same-provider-account', failingAccessTokenFingerprint: 'quota-token-fingerprint',
            expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', planType: null, rateLimits: null,
            source: 'structured_provider_error' },
        } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, recoveryReceipt: {
        attemptId: 'runtime-auth-attempt:qualified-profile-quota',
      } });
      expect(scheduler.readForSession('qualified-profile-quota')).toEqual([
        expect.objectContaining({ status: 'waiting', nextRetryAtMs: resetAtMs, attemptCount: 1,
          attemptId: 'runtime-auth-attempt:qualified-profile-quota', classification: expect.objectContaining({
            failingAccessTokenFingerprint: 'quota-token-fingerprint',
          }) }),
      ]);
    } finally { scheduler.dispose(); await app.close(); }
  });
});
