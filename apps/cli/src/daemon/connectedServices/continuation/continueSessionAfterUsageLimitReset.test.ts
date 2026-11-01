import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accountSettingsParse, buildConnectedServiceCredentialRecord, buildUsageLimitIssueFingerprint, ConnectedServiceAuthGroupPolicyV1Schema, V2SessionRecordSchema, type ConnectedServiceBindingsV1, type SessionRuntimeIssueV1, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { createPiUsageLimitRecoveryControlAdapter } from '@/backends/pi/connectedServices/piUsageLimitRecoveryControlAdapter';
import { createOpenCodeUsageLimitRecoveryControlAdapter } from '@/backends/opencode/connectedServices/openCodeUsageLimitRecoveryControlAdapter';
import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { mergeUsageLimitRecoveryExplicitRearm } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import { buildNativeProviderAccountUsageSourceProfileId } from '../accountUsage/nativeSourceIdentity';

import { isCurrentUsageLimitRecoverySource } from '../runtimeAuth/isCurrentUsageLimitRecoveryCredential';
import { authorizeConnectedServiceRuntimeAuthFailureSource, handleConnectedServiceRuntimeAuthFailureForSession } from '../runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import type { ConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/types';
import { continueSessionAfterUsageLimitReset } from './continueSessionAfterUsageLimitReset';
import { createConnectedServiceContinuationHandler, createConnectedServiceContinuationMessageDispatcher } from './createConnectedServiceContinuationMessageDispatcher';
import { createConnectedServiceContinuationApplicationCorrelation } from './connectedServiceContinuationApplicationCorrelation';
import { RuntimeAuthRecoveryScheduler } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from '../runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry, type ConnectedServiceAuthGroupSwitchState } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { switchSessionConnectedServiceAuth } from '../sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/startDaemon';
import type { TrackedSession } from '@/daemon/types';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { buildConnectedServiceSwitchContinuationAttemptId } from '../sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';
import { mapCommittedGenerationApplyResult } from '../accountGroups/generation/mapCommittedGenerationApplyResult';
import { resolveConnectedServiceGenerationApplicationScope } from '@/backends/catalog';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import { ConnectedServiceRefreshCoordinator } from '../refresh/ConnectedServiceRefreshCoordinator';
import { classifyCodexConnectedServiceAuthFailure } from '@/backends/codex/connectedServices/classifyCodexConnectedServiceAuthFailure';
import { buildObservedFailureMemberRuntimeState } from '../accountGroups/memberRuntimeState';
import { resolveConnectedServiceRuntimeAuthFailureStatusMessage } from '../runtimeAuth/resolveConnectedServiceRuntimeAuthFailureStatusMessage';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '../credentials/lifecycleTypes';

const transport = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  enqueuePendingQueueV2MessageViaHttp: vi.fn(),
  callSessionRpc: vi.fn(),
}));
// Keep dispatcher, message owner, encryption, and Pending admission real; replace network only.
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: transport.fetchSessionById }));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({ enqueuePendingQueueV2MessageViaHttp: transport.enqueuePendingQueueV2MessageViaHttp }));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: transport.callSessionRpc }));

const credentials: Credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } };
const sessionId = 'c123456789012345678901234';
const issue: SessionRuntimeIssueV1 = {
  v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
  provider: 'claude', providerTurnId: 'interrupted-turn', occurredAt: 100,
  usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
    connectedService: { serviceId: 'claude-subscription', profileId: 'account-1', groupId: null } },
};
const recovery: SessionUsageLimitRecoveryV1 = {
  v: 1, status: 'waiting', issueFingerprint: 'recovery-attempt', runtimeAuthRecoveryAttemptId: 'recovery-attempt',
  armedAtMs: 110, resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
  lastProbeError: null, resumePromptMode: 'standard',
  selectedAuth: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'account-1' },
};

function fixture(overrides: Partial<RawSessionRecord> = {}) {
  const metadata = {
    claudeSessionId: 'saved-provider-thread',
    connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'account-1' } } },
    sessionUsageLimitRecoveryV1: recovery,
  };
  const rawSession = V2SessionRecordSchema.parse({
    id: sessionId, seq: 1, createdAt: 0, updatedAt: 100, active: true, activeAt: 100,
    encryptionMode: 'plain', metadata: JSON.stringify(metadata), metadataVersion: 1,
    agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    latestTurnStatus: 'failed', lastRuntimeIssue: issue, ...overrides,
  });
  transport.fetchSessionById.mockImplementation(async () => rawSession);
  return { credentials, sessionId, rawSession, metadata, recovery, nowMs: 200,
    isCurrent: () => true, ensureRuntime: vi.fn(async () => true) };
}

describe('continueSessionAfterUsageLimitReset', () => {
  it.each([
    ['independent_recoveries', 'recipient_bridge'], ['replacement', 'recipient_bridge'],
    ['independent_recoveries', 'recovery_owner'], ['replacement', 'recovery_owner'],
    ['refresh_same_daemon', 'recovery_owner'], ['refresh_replacement', 'recovery_owner'],
    ['immediate_refresh', 'recovery_owner'],
  ] as const)('keeps quota-reset identity owned by the interrupted recovery (%s, %s)', async (scenario, delivery) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-quota-continuation-'));
    const serviceId = 'openai-codex' as const;
    const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const bindings: ConnectedServiceBindingsV1 = { v: 1, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'B' },
    } };
    const tracked: TrackedSession = { startedBy: 'daemon', happySessionId: sessionId, pid: 123,
      activeTurnId: 'interrupted-turn', spawnOptions: { directory, backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, connectedServices: bindings } };
    const input = fixture({ latestTurnId: 'interrupted-turn', latestTurnStatusObservedAt: 100 });
    const immediateRefresh = scenario === 'immediate_refresh';
    const failure: ConnectedServiceRuntimeFailureClassification = { kind: immediateRefresh ? 'auth_expired' : 'usage_limit', serviceId, profileId: 'B', groupId: 'pool',
      groupGeneration: 2, credentialRevision: revision, resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' };
    let runtime = { serviceId, groupId: 'pool', profileId: 'B', generation: 2, credentialRevision: revision };
    let now = 110;
    let resets = 0;
    let applications = 0;
    let refreshes = 0;
    const exhausted = () => new Map([['B', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 0,
      meters: [{ meterId: 'weekly', limitCategory: 'usage_limit' as const, remainingPct: 0, resetAtMs: 100_000, providerLimitId: null }] } }]]);
    let state: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'B', generation: 2,
      credentialRevision: revision, runtimeStateRevision: 0,
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority', autoUseQuotaResetsWhenExhausted: true }),
      members: [{ profileId: 'B', priority: 0, enabled: true, createdAtMs: 1 }], memberStatesByProfileId: exhausted() };
    const consumed = new Set<string>();
    const sends: string[] = [];
    const origins: string[] = [];
    const targets: Array<Readonly<{ serviceId: string; groupId: string; profileId: string; generation: number }> | undefined> = [];
    let storedCredential = buildConnectedServiceCredentialRecord({ now, serviceId, profileId: 'B', kind: 'oauth', expiresAt: 3_600_000,
      oauth: { accessToken: 'synthetic-old-access', refreshToken: 'synthetic-refresh', idToken: null,
        scope: null, tokenType: null, providerAccountId: 'provider-B', providerEmail: null } });
    // Server credential/lease API and provider HTTP are the refresh system boundaries.
    const credentialApi = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceCredentialPlain: async () => ({ revisionSemantics: 'revisioned', credentialRevision: runtime.credentialRevision,
        content: { t: 'plain', v: storedCredential } }),
      acquireConnectedServiceRefreshLease: async () => ({ acquired: true, leaseUntil: now + 30_000,
        ownerId: 'fixture-machine', credentialRevision: runtime.credentialRevision }),
      registerConnectedServiceCredentialPlain: async ({ content }: { content: { v: typeof storedCredential } }) => {
        storedCredential = content.v;
        runtime = { ...runtime, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' };
        return { success: true, credentialRevision: runtime.credentialRevision };
      },
      updateConnectedServiceCredentialHealth: async () => {},
      getConnectedServiceAuthGroup: async () => ({ v: 1, serviceId, groupId: 'pool', displayName: 'Pool', activeProfileId: 'B',
        generation: 2, runtimeStateRevision: 0, policy: state.policy, state: { v: 1 },
        members: [{ v: 1, serviceId, groupId: 'pool', profileId: 'B', priority: 0, enabled: true,
          state: {}, createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 1 }),
    } as unknown as ApiClient;
    const refreshCoordinator = immediateRefresh ? new ConnectedServiceRefreshCoordinator({ api: credentialApi, credentials,
      machineIdProvider: () => 'fixture-machine', activeServerDir: directory, baseDir: directory,
      refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => now }) : undefined;
    refreshCoordinator?.registerSpawnTarget({ pid: tracked.pid, sessionId, agentId: 'codex', materializationKey: sessionId,
      connectedServicesBindingsRaw: bindings });
    const providerFetch = immediateRefresh ? vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      refreshes++;
      return new Response(JSON.stringify({ access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-refresh', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }) : undefined;
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async ({ body }: { body: { localId: string } }) => {
      sends.push(body.localId);
      const didWrite = !consumed.has(body.localId);
      consumed.add(body.localId);
      return { didWrite, terminal: false };
    });
    const core = createConnectedServiceSessionAuthSwitchCore();
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => now, quotaFreshnessMs: 60_000,
      loadState: async () => state,
      commitSwitch: async () => { throw new Error('same-account reset must retain generation'); },
      consumeAvailableRecoveryCreditForProfile: async () => {
        resets++;
        state = { ...state, memberStatesByProfileId: new Map([['B', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 80 } }]]) };
        return { ok: true, snapshot: null, receipt: { idempotencyKey: `reset-${resets}`, status: 'consumed' } };
      },
      applyGeneration: async () => {
        applications++;
        const result = await switchSessionConnectedServiceAuth({ core, switchReason: 'automatic_runtime_failure',
          api: { listConnectedServiceProfiles: async () => ({ serviceId, profiles: [{ profileId: 'B', status: 'connected' as const }] }),
            getConnectedServiceAuthGroup: async () => ({ v: 1, serviceId, groupId: 'pool', displayName: 'Pool',
              activeProfileId: 'B', generation: 2, runtimeStateRevision: 0, policy: ConnectedServiceAuthGroupPolicyV1Schema.parse(state.policy),
              state: { v: 1 }, members: [{ v: 1, serviceId, groupId: 'pool', profileId: 'B', priority: 0, enabled: true,
                state: {}, createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 1 }) },
          resolveContinuity: context => resolveSessionConnectedServiceSwitchContinuity({ sessionId, agentId: 'codex', serviceId,
            previousBinding: context.previous, nextBinding: context.next, fromBindingsRaw: context.previousBindings,
            toBindings: context.normalizedBindings, accountSettings: accountSettingsParse({}) }),
          getChildren: () => [tracked], request: { sessionId, agentId: 'codex', bindings,
            expectedGroupGenerationByServiceId: { [serviceId]: 2 } },
          hotApply: async () => ({ ok: true }), restartSession: async () => {}, persistSessionBindings: async () => {},
          registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
          verifyProviderAccountAdoption: async () => ({ status: 'verified', proofStrength: 'exact', providerAccountId: 'provider-B',
            generationApplication: { ...runtime, credentialFingerprint: 'provider-B-fingerprint' } }),
        });
        if (!result.ok) throw new Error(result.errorCode);
        return { ...result, mode: 'hot_apply' as const };
      },
    });
    type Context = Parameters<typeof createConnectedServiceContinuationHandler>[0];
    let correlation = createConnectedServiceContinuationApplicationCorrelation<Context>();
    const makeScheduler = () => {
      const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => now, jitterMs: () => 0,
        durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(directory, 'recovery.json')),
        recover: async (recoveryInput) => {
          origins.push(recoveryInput.interruptedOriginId!);
          const context: Context = { credentials, interruptedOriginId: recoveryInput.interruptedOriginId,
            resumePromptMode: 'standard', resolveInterruption: () => 'provider_failed_turn', runtimeAuthRecovery: {
              armedAtMs: scheduler.readForSession(sessionId)[0]!.armedAtMs,
              isCurrent: () => scheduler.readForSession(sessionId).some(intent => intent.attemptId === recoveryInput.interruptedOriginId
                && ['waiting', 'checking', 'resumed_awaiting_proof'].includes(intent.status)),
              readActiveTurnId: () => tracked.activeTurnId ?? null,
            } };
          return await handleConnectedServiceRuntimeAuthFailureForSession({ ...recoveryInput,
            recoveryInvocationSource: recoveryInput.source, getChildren: () => [tracked], switchCoordinator: coordinator,
            resolveRegisteredRuntimeAuthFailureSource: () => runtime,
            credentialRefreshService: refreshCoordinator,
            continueAfterRuntimeAuthSwitch: async (value) => {
              targets.push(value.target);
              if (delivery === 'recovery_owner') return await createConnectedServiceContinuationHandler(context)(value);
              const key = { sessionId, ...runtime };
              correlation.register(key, context);
              await correlation.settle(key, correlated => createConnectedServiceContinuationHandler(correlated)(value));
            },
          });
        },
      });
      return scheduler;
    };
    const first = makeScheduler();
    let replacement: RuntimeAuthRecoveryScheduler | undefined;
    try {
      await first.beginClassifiedFailure({ reportId: 'reset-report-1', sessionId, classification: failure, switchesThisTurn: 0 });
      await first.wake({ sessionId, reason: 'manual' });
      expect(first.readForSession(sessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof' });
      expect(consumed.size).toBe(1);
      expect(resets).toBe(immediateRefresh ? 0 : 1);
      if (immediateRefresh) {
        expect(targets[0]).toEqual({ serviceId, groupId: 'pool', profileId: 'B', generation: 2 });
      } else {
        expect(first.readForSession(sessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 });
      }
      if (scenario === 'independent_recoveries') {
        await first.markProviderOutcomeProofByKey({ recoveryKey: buildRuntimeAuthRecoveryKey({ sessionId, ...failure }),
          proofKind: 'provider_activity', expectedAttemptId: origins[0], observedAtMs: now + 1 });
        expect(first.readForSession(sessionId)[0]!.status).toBe('recovered');
        now = 210;
        tracked.activeTurnId = 'second-interrupted-turn';
        transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, latestTurnId: tracked.activeTurnId,
          latestTurnStatusObservedAt: 200, lastRuntimeIssue: { ...issue, providerTurnId: tracked.activeTurnId, occurredAt: 200 } });
        state = { ...state, memberStatesByProfileId: exhausted() };
        await first.beginClassifiedFailure({ reportId: 'reset-report-2', sessionId, classification: failure, switchesThisTurn: 0 });
        await first.wake({ sessionId, reason: 'manual' });
        expect(origins[1]).not.toBe(origins[0]);
        expect(resets).toBe(2);
        expect(consumed.size).toBe(2);
      } else {
        if (scenario === 'refresh_same_daemon' || scenario === 'refresh_replacement') {
          runtime = { ...runtime, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' };
          state = { ...state, credentialRevision: runtime.credentialRevision };
        }
        const replace = scenario === 'replacement' || scenario === 'refresh_replacement';
        if (replace) {
          first.dispose();
          correlation = createConnectedServiceContinuationApplicationCorrelation<Context>();
          replacement = makeScheduler();
          replacement.hydratePassive();
        }
        await (replacement ?? first).wake({ sessionId, reason: 'manual' });
        expect(origins[1]).toBe(origins[0]);
        expect(resets).toBe(immediateRefresh ? 0 : 1);
        expect(sends.length).toBeGreaterThanOrEqual(2);
        expect(consumed.size).toBe(1);
        if (scenario !== 'replacement') {
          expect(targets[1]).toEqual({ serviceId, groupId: 'pool', profileId: 'B', generation: 2 });
          expect(applications).toBe(immediateRefresh ? 0 : 1);
          expect(refreshes).toBe(immediateRefresh ? 1 : 0);
          expect((replacement ?? first).readForSession(sessionId)[0]!.status).toBe('resumed_awaiting_proof');
        }
      }
    } finally { first.dispose(); replacement?.dispose(); providerFetch?.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ['codex', 'plan', 'stopped_turn'], ['codex', 'capacity', 'stopped_turn'],
    ['claude', 'usage_limit', 'stopped_turn'], ['codex', 'plan', 'newer_work'],
    ['codex', 'plan', 'completed'], ['codex', 'plan', 'cancelled'],
    ['codex', 'plan', 'not_failed'], ['codex', 'plan', 'archived'],
    ['codex', 'plan', 'unknown_quota'], ['codex', 'plan', 'exhausted_quota'],
    ['codex', 'plan', 'provider_unproven'], ['codex', 'plan', 'predecessor'],
  ] as const)('keeps superseded interrupted reports under durable admission (%s, %s, %s)', async (agentId, kind, projection) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-superseded-recovery-'));
    let now = 110;
    const input = fixture({ latestTurnId: 'interrupted-turn', latestTurnStatus: 'in_progress', lastRuntimeIssue: null,
      latestTurnStatusObservedAt: 100 });
    const serviceId = agentId === 'codex' ? 'openai-codex' as const : 'claude-subscription' as const;
    const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const tracked: TrackedSession = { startedBy: 'daemon', happySessionId: sessionId, pid: 123,
      activeTurnId: 'interrupted-turn',
      ...(projection === 'predecessor' ? { reattachedFromDiskMarker: true } : {}),
      spawnOptions: { directory, backendTarget: { kind: 'builtInAgent', agentId }, connectedServices: {
        v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'A' } },
      } } };
    let classification: ConnectedServiceRuntimeFailureClassification = agentId === 'codex'
      ? classifyCodexConnectedServiceAuthFailure({ providerErrorPath: true, serviceId, groupId: 'pool', profileId: 'A',
          sourceAccountIdentity: { groupGeneration: 1, credentialRevision: revision },
          error: new Error(kind === 'capacity' ? 'Fatal error: application network permission was revoked'
            : "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.") })!
      : { kind: 'usage_limit', serviceId, groupId: 'pool', profileId: 'A', groupGeneration: 1,
          credentialRevision: revision, resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' };
    expect(classification.kind).toBe(kind);
    if (agentId === 'codex') expect(classification.limitCategory).toBe(kind === 'capacity' ? 'capacity' : 'plan_invalid');
    if (projection === 'predecessor') classification = { ...classification, credentialRevision: null };
    // The old member's reset must not defer checking the already-adopted member.
    if (projection === 'unknown_quota' || projection === 'exhausted_quota') classification = { ...classification, resetsAtMs: 604_800_000 };
    const runtimeAuthApply = {
      directLiveHotAuth: {
        supportsInTurnApply: true, requiresExactRuntimeIdentity: true, refreshSelectionResync: 'required',
        authMode: { kind: 'external_token_injection', surface: 'superseded-recovery-fixture' },
      },
    } satisfies ConnectedServiceRuntimeAuthApplyCapability;
    let runtime = { serviceId, groupId: 'pool', profileId: 'A', generation: 1, credentialRevision: revision };
    let state: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'A', generation: 1,
      credentialRevision: revision, runtimeStateRevision: 0,
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority', softSwitchRemainingPercent: 15 }),
      members: ['A', 'B'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
      memberStatesByProfileId: new Map([
        ['A', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 10 } }],
        ['B', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 80 } }],
      ]) };
    let commits = 0;
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => now, quotaFreshnessMs: 60_000,
      loadState: async () => state,
      commitSwitch: async value => { commits++; state = { ...state, activeProfileId: value.toProfileId, generation: state.generation + 1 }; return state; },
      applyGeneration: async value => {
        runtime = { ...runtime, profileId: value.activeProfileId!, generation: value.generation };
        return { mode: 'hot_apply' };
      },
      // This adapter is the persisted pool-state boundary; the real normalizer builds its state.
      recordObservedFailureState: async value => {
        const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
        memberStatesByProfileId.set(value.observedProfileId!, buildObservedFailureMemberRuntimeState({
          existing: memberStatesByProfileId.get(value.observedProfileId!) ?? null, policy: state.policy,
          reason: value.reason, limitCategory: value.limitCategory, quotaScope: value.quotaScope,
          providerLimitId: value.providerLimitId, retryAtMs: value.resetsAtMs ?? null,
          planType: value.planType, observedAtMs: now,
        }));
        state = { ...state, memberStatesByProfileId };
      },
    });
    const consumed = new Set<string>();
    const sends: string[] = [];
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async ({ body }: { body: { localId: string } }) => {
      sends.push(body.localId);
      const didWrite = !consumed.has(body.localId);
      consumed.add(body.localId);
      return { didWrite, terminal: false };
    });
    const file = join(directory, 'recoveries.json');
    let scheduler: RuntimeAuthRecoveryScheduler;
    const run = async (value: { sessionId: string; switchesThisTurn: number; classification: ConnectedServiceRuntimeFailureClassification;
      interruptedOriginId?: string; source?: 'scheduler_retry'; sourceAuthorization?: Awaited<ReturnType<typeof authorizeConnectedServiceRuntimeAuthFailureSource>> }) => {
      const intent = scheduler.readForSession(sessionId)[0];
      return await handleConnectedServiceRuntimeAuthFailureForSession({ ...value, getChildren: () => [tracked], switchCoordinator: coordinator,
        recoveryInvocationSource: value.source, resolveRegisteredRuntimeAuthFailureSource: () => runtime,
        runtimeAuthApply, resolveCurrentRuntimeAuthFailureSource: async () => runtime,
        continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({ credentials, interruptedOriginId: value.interruptedOriginId,
          resumePromptMode: 'standard', resolveInterruption: () => 'provider_failed_turn',
          ...(intent ? { runtimeAuthRecovery: { armedAtMs: intent.armedAtMs,
            isCurrent: () => scheduler.readForSession(sessionId).some(current => current.attemptId === value.interruptedOriginId
              && ['waiting', 'checking', 'resumed_awaiting_proof'].includes(current.status)), readActiveTurnId: () => tracked.activeTurnId ?? null } } : {}),
        }),
      });
    };
    const createScheduler = () => new RuntimeAuthRecoveryScheduler({ nowMs: () => now, recover: run,
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(file), baseBackoffMs: 1_000,
      jitterMs: () => 0, maxAttempts: 3, maxCoalescedReplays: 1, maxDegradedAttempts: 2 });
    scheduler = createScheduler();
    const createApp = () => createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, runtimeAuthRecoveryScheduler: scheduler,
      authorizeConnectedServiceRuntimeAuthFailure: value => authorizeConnectedServiceRuntimeAuthFailureSource({ ...value,
        getChildren: () => [tracked], resolveRegisteredRuntimeAuthFailureSource: () => runtime,
        runtimeAuthApply, resolveCurrentRuntimeAuthFailureSource: async () => runtime }),
      handleConnectedServiceRuntimeAuthFailure: run,
    });
    let app = createApp();
    try {
      // A real soft switch hot-applies while the original provider turn is still running.
      expect(await coordinator.switchBeforeTurn({ sessionId, serviceId, groupId: 'pool', reason: 'soft_threshold', observedProfileId: 'A' }))
        .toMatchObject({ status: 'switched', activeProfileId: 'B', generation: 2 });
      expect(input.rawSession.latestTurnStatus).toBe('in_progress');
      tracked.activeTurnId = projection === 'newer_work' ? 'new-consumed-user-turn' : 'interrupted-turn';
      transport.fetchSessionById.mockResolvedValue({ ...input.rawSession,
        latestTurnStatus: projection === 'not_failed' ? 'in_progress'
          : projection === 'completed' || projection === 'cancelled' ? projection : 'failed',
        latestTurnStatusObservedAt: projection === 'completed' || projection === 'cancelled' ? now + 1 : 100,
        archivedAt: projection === 'archived' ? now : null,
        lastRuntimeIssue: projection === 'completed' || projection === 'cancelled' || projection === 'not_failed' ? null : issue });
      if (projection === 'unknown_quota' || projection === 'exhausted_quota') {
        state = { ...state, memberStatesByProfileId: new Map([['B', projection === 'unknown_quota' ? {} : {
          quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 0,
            meters: [{ meterId: 'weekly', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 180_000, providerLimitId: null }] },
        }]]) };
      }
      const report = () => app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId, classification, reportId: 'late-A-report', switchesThisTurn: 0 } });
      const [response, duplicate] = await Promise.all([report(), report()]);
      expect(response.statusCode).toBe(200);
      expect(duplicate.json()).toEqual(response.json());
      expect(response.json()).toMatchObject({ ok: true, result: { status: 'recovery_retry_scheduled' } });
      expect(resolveConnectedServiceRuntimeAuthFailureStatusMessage(response.json())?.code).toBe('recovery_retry_scheduled');
      const initial = scheduler.readForSession(sessionId)[0]!;
      expect(initial).toMatchObject({ status: 'waiting', lastSettledTransition: 'scheduled', classification });
      expect(initial.nextRetryAtMs).toBe(1_110);
      expect(sends).toHaveLength(0);
      now = initial.nextRetryAtMs!;
      await scheduler.wake({ sessionId, reason: 'timer' });
      if (projection === 'unknown_quota' || projection === 'exhausted_quota') {
        const wait = scheduler.readForSession(sessionId)[0]!;
        expect(wait.lastError).toBe(projection === 'unknown_quota' ? 'quota_proof_unavailable' : 'no_eligible_member');
        expect(wait.nextRetryAtMs).toBe(projection === 'unknown_quota' ? now + 30_000 : 180_000);
        expect(sends).toHaveLength(0);
        now = wait.nextRetryAtMs!;
        state = { ...state, memberStatesByProfileId: new Map([...state.memberStatesByProfileId,
          ['B', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 80 } }]]) };
        await scheduler.wake({ sessionId, reason: 'timer' });
      }
      const shouldSend = projection !== 'newer_work' && projection !== 'completed' && projection !== 'cancelled'
        && projection !== 'not_failed' && projection !== 'archived';
      expect(consumed.size).toBe(shouldSend ? 1 : 0);
      if (kind !== 'capacity') {
        expect(state.memberStatesByProfileId.get('A')).toMatchObject({ lastFailureKind: kind });
        expect(state.memberStatesByProfileId.get('B')?.lastFailureKind).toBeUndefined();
      }
      const firstSends = sends.length;
      const beforeReplacement = scheduler.readForSession(sessionId)[0]!;
      scheduler.dispose();
      scheduler = createScheduler();
      scheduler.hydratePassive();
      await app.close();
      app = createApp();
      expect(scheduler.readForSession(sessionId)[0]!.attemptId).toBe(initial.attemptId);
      await report();
      expect(scheduler.readForSession(sessionId)[0]!.attemptId).toBe(initial.attemptId);
      now = beforeReplacement.nextRetryAtMs!;
      await scheduler.wake({ sessionId, reason: 'timer' });
      expect(consumed.size).toBe(shouldSend ? 1 : 0);
      if (shouldSend) {
        expect(sends.length).toBeGreaterThan(firstSends);
        expect(new Set(sends).size).toBe(1);
      }
      if (projection === 'provider_unproven') {
        for (let attempt = 0; attempt < 5; attempt++) {
          const current = scheduler.readForSession(sessionId)[0]!;
          if (current.nextRetryAtMs !== null) now = current.nextRetryAtMs;
          await scheduler.wake({ sessionId, reason: 'timer' });
        }
        expect(scheduler.readForSession(sessionId)[0]).toMatchObject({ status: 'exhausted', nextRetryAtMs: null,
          lastError: 'recovery_unproven_awaiting_provider_outcome' });
        const terminalSends = sends.length;
        await scheduler.wake({ sessionId, reason: 'manual' });
        expect(sends).toHaveLength(terminalSends);
        // A replay cannot revive exhausted work. A genuinely different failed
        // turn still needs custody even when it reports the same old account.
        await app.close();
        app = createApp();
        await report();
        expect(scheduler.readForSession(sessionId)[0]!.status).toBe('exhausted');
        tracked.activeTurnId = 'next-interrupted-turn';
        transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, latestTurnId: tracked.activeTurnId,
          latestTurnStatus: 'failed', latestTurnStatusObservedAt: now, lastRuntimeIssue: { ...issue, occurredAt: now } });
        const nextReport = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
          headers: { 'x-happier-daemon-token': 'token' }, payload: {
            sessionId, classification, reportId: 'next-late-A-report', switchesThisTurn: 0,
          } });
        expect(nextReport.json()).toMatchObject({ ok: true, result: { status: 'recovery_retry_scheduled' } });
        const nextRecovery = scheduler.readForSession(sessionId)[0]!;
        expect(nextRecovery.attemptId).not.toBe(initial.attemptId);
        expect(nextRecovery.status).toBe('waiting');
        state = { ...state, memberStatesByProfileId: new Map([...state.memberStatesByProfileId,
          ['B', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 80 } }]]) };
        now = nextRecovery.nextRetryAtMs!;
        await scheduler.wake({ sessionId, reason: 'timer' });
        expect(consumed.size).toBe(2);
      } else if (shouldSend) {
        expect(scheduler.readForSession(sessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof', pendingTargetProfileId: 'B', pendingTargetGeneration: 2 });
        await scheduler.markProviderOutcomeProofByKey({ recoveryKey: buildRuntimeAuthRecoveryKey({ sessionId, ...classification }),
          proofKind: 'provider_activity', expectedAttemptId: initial.attemptId });
        expect(scheduler.readForSession(sessionId)[0]!.status).toBe('recovered');
        await app.close();
        app = createApp();
        await report();
        await scheduler.wake({ sessionId, reason: 'manual' });
        expect(scheduler.readForSession(sessionId)[0]!.status).toBe('recovered');
        expect(consumed.size).toBe(1);
      }
      expect(commits).toBe(1);
    } finally { scheduler.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ['codex', 'failed'], ['claude', 'failed'],
    ['codex', 'newer_work'], ['claude', 'newer_work'],
    ['codex', 'delayed_projection'], ['claude', 'delayed_projection'],
  ] as const)('keeps automatic primitive application under recovery identity and admission (%s, %s)', async (agentId, projection) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-continuation-primitive-'));
    const serviceId = agentId === 'codex' ? 'openai-codex' : 'claude-subscription';
    const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const makeBindings = (profileId: string): ConnectedServiceBindingsV1 => ({ v: 1, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool', profileId },
    } });
    const tracked: TrackedSession = { startedBy: 'daemon', happySessionId: sessionId, pid: 123,
      activeTurnId: projection === 'newer_work' ? 'new-user-turn' : 'interrupted-turn',
      spawnOptions: { directory, backendTarget: { kind: 'builtInAgent', agentId }, connectedServices: makeBindings('A') } };
    const settings = accountSettingsParse({ connectedServicesProviderStateSharingSettingsV1: {
      v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: {},
    } });
    const vendorResumeId = 'interrupted-provider-thread';
    const claudeConfigDir = join(directory, 'claude-home');
    const projectDir = join(claudeConfigDir, 'projects', 'fixture');
    await mkdir(projectDir, { recursive: true });
    const sessionFile = join(projectDir, `${vendorResumeId}.jsonl`);
    await writeFile(sessionFile, '{}\n');
    const input = fixture({ latestTurnId: 'interrupted-turn',
      latestTurnStatus: projection === 'delayed_projection' ? 'in_progress' : 'failed',
      latestTurnStatusObservedAt: 100, lastRuntimeIssue: projection === 'delayed_projection' ? null : issue });
    const consumed = new Set<string>();
    const sends: string[] = [];
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async ({ body }: { body: { localId: string } }) => {
      sends.push(body.localId);
      const didWrite = !consumed.has(body.localId);
      consumed.add(body.localId); // Promotion consumes the row, but its local-ID receipt survives.
      return { didWrite, terminal: false };
    });
    let state: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'pool', activeProfileId: 'A', generation: 1,
      credentialRevision: revision, runtimeStateRevision: 0,
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority' }),
      members: ['A', 'B'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
      memberStatesByProfileId: new Map([['B', { quotaSnapshot: { capturedAtMs: 110, effectiveRemainingPercent: 60 } }]]),
    };
    let runtime: { serviceId: typeof serviceId; groupId: string; profileId: string; generation: number; credentialRevision: string } = {
      serviceId, groupId: 'pool', profileId: 'A', generation: 1, credentialRevision: revision,
    };
    let restarts = 0;
    let generationFanoutEntered = false;
    const core = createConnectedServiceSessionAuthSwitchCore();
    type Continuation = { interruptedOriginId: string; runtimeAuthRecovery: {
      armedAtMs: number; isCurrent: () => boolean; readActiveTurnId: () => string | null;
    } };
    let correlation = createConnectedServiceContinuationApplicationCorrelation<Continuation>();
    let continuation: Continuation;
    const key = () => ({ sessionId, serviceId, groupId: 'pool', profileId: 'B', generation: 2 });
    const send = async (attemptId: string, context: Partial<Continuation> & { interruptedOriginId: string }) => {
      await createConnectedServiceContinuationHandler({ credentials, ...context,
        resolveInterruption: () => 'provider_failed_turn', resumePromptMode: 'standard' })({
        sessionId, attemptId, action: 'hot_applied', switchReason: 'automatic_runtime_failure',
      });
    };
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => await resolveConnectedServiceGenerationApplicationScope(serviceId, agentId),
      verifySharedGenerationApplication: async () => null,
      applyCommittedGeneration: async ({ committedGeneration }) => {
        const target = committedGeneration.decisionCommittedTarget;
        const result = await makeCoordinator(false).applyCommittedGeneration({ sessionId, serviceId,
          groupId: target.groupId, activeProfileId: target.profileId, generation: target.generation,
          credentialRevision: target.credentialRevision, reason: 'usage_limit' });
        return mapCommittedGenerationApplyResult({ committedGeneration, result });
      },
      notifyCurrentGroupTruth: async () => ({ ok: true }),
      continueAfterExactRecipientApplication: async () => {
        await correlation.settle(key(), context => send(buildConnectedServiceSwitchContinuationAttemptId({
          action: 'hot_applied', serviceIds: new Set([serviceId]), normalizedBindings: makeBindings('B'),
          expectedGroupGenerationByServiceId: { [serviceId]: 2 },
        }), context));
      },
    });
    // These are the production application's correlation-first/fallback composition and the
    // outer recovery composition. All deciding owners below them remain real.
    const makeCoordinator = (applicationContinuation: boolean): ConnectedServiceAuthGroupSwitchCoordinator => new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 110, quotaFreshnessMs: 60_000,
      loadState: async () => state,
      commitSwitch: async ({ toProfileId }) => state = { ...state, activeProfileId: toProfileId, generation: 2 },
      applyGeneration: async (generation) => {
        const result = await switchSessionConnectedServiceAuth({ core, switchReason: 'automatic_runtime_failure',
          groupSwitchTriggerReason: 'usage_limit', getChildren: () => [tracked],
          api: { listConnectedServiceProfiles: async () => ({ serviceId, profiles: ['A', 'B'].map(profileId => ({ profileId, status: 'connected' as const })) }),
            getConnectedServiceAuthGroup: async () => ({ v: 1, serviceId, groupId: 'pool', displayName: 'Pool',
              activeProfileId: state.activeProfileId, generation: state.generation, runtimeStateRevision: 0,
              policy: ConnectedServiceAuthGroupPolicyV1Schema.parse(state.policy), state: { v: 1 },
              members: ['A', 'B'].map(profileId => ({ v: 1, serviceId, groupId: 'pool', profileId, priority: 1,
                enabled: true, state: {}, createdAt: 1, updatedAt: 1 })), createdAt: 1, updatedAt: 1 }) },
          resolveContinuity: context => resolveSessionConnectedServiceSwitchContinuity({
            sessionId, agentId, serviceId, previousBinding: context.previous, nextBinding: context.next,
            fromBindingsRaw: context.previousBindings, toBindings: context.normalizedBindings, accountSettings: settings,
            connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', createdAtMs: 1 },
            vendorResumeId, targetMaterializedRoot: directory, targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
            cwd: directory, candidatePersistedSessionFile: sessionFile,
          }),
          // Provider adoption, process replacement, and binding persistence are boundaries.
          hotApply: async () => {
            runtime = { ...runtime, profileId: 'B', generation: 2 };
            // Application has taken effect before its RPC reply. Concurrent generation
            // reconciliation can now observe proof and settle the registered continuation.
            if (!generationFanoutEntered) {
              generationFanoutEntered = true;
              await consumer.consume({
                committedGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
                  decisionId: 'runtime-recovery-B', provenance: 'runtime_failure',
                  decisionCommittedTarget: { serviceId, groupId: 'pool', profileId: 'B', generation: 2, credentialRevision: revision },
                }),
                switchReason: 'automatic_runtime_failure', executionAuthority: 'runtime_recovery',
                sessions: [{ sessionId, activity: 'live' }],
              });
            }
            return { ok: true };
          },
          restartSession: async () => { restarts++; runtime = { ...runtime, profileId: 'B', generation: 2 }; },
          persistSessionBindings: async () => {}, registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
          verifyProviderAccountAdoption: async () => ({ status: 'verified', proofStrength: 'exact', providerAccountId: 'provider-B',
            generationApplication: { serviceId, groupId: 'pool', profileId: 'B', generation: 2,
              credentialRevision: revision, credentialFingerprint: 'provider-B-fingerprint' } }),
          continueAfterRuntimeAuthSwitch: applicationContinuation ? async ({ attemptId }) => {
            if (await correlation.settle(key(), context => send(attemptId, context))) return;
            await send(attemptId, { interruptedOriginId: continuation.interruptedOriginId });
          } : undefined,
          request: { sessionId, agentId, bindings: makeBindings(generation.activeProfileId!),
            expectedGroupGenerationByServiceId: { [serviceId]: generation.generation } },
        });
        if (!result.ok) throw Object.assign(new Error(result.errorCode), { retryable: true });
        return { ...result, mode: result.action === 'hot_applied' ? 'hot_apply' as const : 'spawn_next_turn' as const };
      },
    });
    const coordinator = makeCoordinator(true);
    const makeScheduler = () => {
      const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 110, jitterMs: () => 0,
        durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(directory, 'recovery.json')),
        recover: async (recoveryInput) => {
          continuation = { interruptedOriginId: recoveryInput.interruptedOriginId!, runtimeAuthRecovery: {
            armedAtMs: 110, readActiveTurnId: () => tracked.activeTurnId ?? null,
            isCurrent: () => scheduler.readForSession(sessionId).some(intent => intent.attemptId === recoveryInput.interruptedOriginId
              && (intent.status === 'waiting' || intent.status === 'checking' || intent.status === 'resumed_awaiting_proof')),
          } };
          correlation.register(key(), continuation);
          return await handleConnectedServiceRuntimeAuthFailureForSession({ ...recoveryInput,
            recoveryInvocationSource: recoveryInput.source, getChildren: () => [tracked], switchCoordinator: coordinator,
            resolveRegisteredRuntimeAuthFailureSource: () => runtime,
            restartSession: async () => { restarts++; runtime = { ...runtime, profileId: 'B', generation: 2 }; },
            continueAfterRuntimeAuthSwitch: async ({ attemptId }) => {
              correlation.register(key(), continuation);
              await correlation.settle(key(), context => send(attemptId, context));
            },
          });
        },
      });
      return scheduler;
    };
    const first = makeScheduler();
    let replacement: RuntimeAuthRecoveryScheduler | undefined;
    try {
      await first.beginClassifiedFailure({ reportId: 'runtime-auth-report:primitive', sessionId, switchesThisTurn: 0,
        classification: { kind: 'usage_limit', serviceId, profileId: 'A', groupId: 'pool', groupGeneration: 1,
          credentialRevision: revision, resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } });
      await first.wake({ sessionId, reason: 'manual' });
      expect(runtime.profileId).toBe('B');
      expect(restarts).toBe(agentId === 'claude' ? 1 : 0);
      expect(consumed.size).toBe(projection === 'failed' ? 1 : 0);
      // A repeated committed-generation application reaches unchanged-binding rematerialization
      // after correlation has settled. The old lower fallback must not gain admission authority.
      await expect(coordinator.applyCommittedGeneration({ sessionId, serviceId, groupId: 'pool', activeProfileId: 'B',
        generation: 2, credentialRevision: revision, reason: 'usage_limit' })).resolves.toMatchObject({ status: 'observed_generation' });
      expect(consumed.size).toBe(projection === 'failed' ? 1 : 0);
      first.dispose();
      correlation = createConnectedServiceContinuationApplicationCorrelation<Continuation>();
      replacement = makeScheduler();
      replacement.hydratePassive();
      await replacement.wake({ sessionId, reason: 'manual' });
      expect(consumed.size).toBe(projection === 'failed' ? 1 : 0);
      if (projection === 'failed') {
        expect(sends.length).toBeGreaterThanOrEqual(2);
        expect(replacement.readForSession(sessionId)[0]).toMatchObject({ status: 'resumed_awaiting_proof' });
      }
      if (projection === 'delayed_projection') {
        expect(replacement.readForSession(sessionId)[0]).toMatchObject({ status: 'waiting' });
        transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, latestTurnStatus: 'failed', lastRuntimeIssue: issue });
        await replacement.wake({ sessionId, reason: 'manual' });
        expect(consumed.size).toBe(1);
        await replacement.wake({ sessionId, reason: 'manual' });
        expect(consumed.size).toBe(1);
      }
    } finally { first.dispose(); replacement?.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each([90, 150])('retains correlation while the original failure projection is delayed (observedAt=%s)', async (observedAt) => {
    const input = fixture({ latestTurnId: 'interrupted-turn', latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: observedAt, lastRuntimeIssue: null });
    const classification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit', serviceId: 'claude-subscription', groupId: 'pool', profileId: 'A',
      resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
    };
    const key = { sessionId, serviceId: 'claude-subscription', groupId: 'pool', profileId: 'B', generation: 2 };
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials });
    const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId, ...classification });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 110,
      recover: async ({ interruptedOriginId }) => {
        correlation.register(key, interruptedOriginId!);
        await correlation.settle(key, async (origin) => {
          await dispatcher.enqueueInterruptedOriginContinuation({ sessionId, attemptId: 'switch-B',
            interruptedOriginId: origin, interruption: 'provider_failed_turn', resumePromptMode: 'standard',
            runtimeAuthRecovery: { armedAtMs: 110, isCurrent: () => true, readActiveTurnId: () => 'interrupted-turn' } });
        });
        return { status: 'switch_attempted', result: { status: 'observed_generation', activeProfileId: 'B', generation: 2 } };
      },
    });
    try {
      await scheduler.enqueueHandlerFailure({ sessionId, classification, switchesThisTurn: 0,
        error: Object.assign(new Error('endpoint unavailable'), { code: 'ECONNRESET' }) });
      await scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
      expect(scheduler.readByKeyPassive(recoveryKey)).toMatchObject({ status: 'waiting' });
      // The same T becomes terminal after its unawaited durable write completes.
      transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, latestTurnStatus: 'failed',
        latestTurnStatusObservedAt: 150, lastRuntimeIssue: issue });
      await scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      await scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      const localIds = transport.enqueuePendingQueueV2MessageViaHttp.mock.calls.map(([value]) => value.body.localId);
      expect(localIds).toHaveLength(2);
      expect(new Set(localIds).size).toBe(1);
      expect(scheduler.readByKeyPassive(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof' });
    } finally { scheduler.dispose(); }
  });

  it.each([
    { status: 'in_progress', observedAt: 150, failureAt: 100, activeTurn: 'new-user-turn', admitted: false },
    { status: 'completed', observedAt: 150, failureAt: 100, activeTurn: null, admitted: false },
    { status: 'failed', observedAt: 150, failureAt: 150, activeTurn: null, admitted: false },
    { status: 'failed', observedAt: 100, failureAt: 100, activeTurn: 'new-user-turn', admitted: false },
    { status: 'failed', observedAt: 100, failureAt: 100, activeTurn: null, admitted: true },
    { status: 'failed', observedAt: 100, failureAt: 100, activeTurn: 'interrupted-turn', admitted: true },
    { status: 'failed', observedAt: 150, failureAt: 100, activeTurn: null, admitted: true },
  ] as const)('admits restored runtime-auth work only while its interrupted turn is current ($status/$observedAt/$activeTurn)', async ({ status, observedAt, failureAt, activeTurn, admitted }) => {
    const input = fixture({ latestTurnId: 'interrupted-turn', latestTurnStatus: status, latestTurnStatusObservedAt: observedAt,
      lastRuntimeIssue: { ...issue, occurredAt: failureAt } });
    transport.fetchSessionById.mockResolvedValue(input.rawSession);
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials });
    const result = await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId, attemptId: 'switch-B', interruptedOriginId: 'durable-recovery-A',
      interruption: 'provider_failed_turn', resumePromptMode: 'standard',
      runtimeAuthRecovery: { armedAtMs: 110, isCurrent: () => true, readActiveTurnId: () => activeTurn },
    });
    expect(result.status).toBe(admitted ? 'enqueued' : 'suppressed_newer_user_input');
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(admitted ? 1 : 0);
  });
  beforeEach(() => {
    vi.resetAllMocks();
    transport.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({ didWrite: true, terminal: false });
    transport.callSessionRpc.mockResolvedValue({ ok: true });
  });

  it('continues the same untimed failure after a provider probe supplies its due reset', async () => {
    const untimedIssue: SessionRuntimeIssueV1 = { ...issue,
      usageLimit: { ...issue.usageLimit!, resetAtMs: null } };
    const input = fixture({ lastRuntimeIssue: untimedIssue });
    const enriched: SessionUsageLimitRecoveryV1 = { ...recovery, runtimeAuthRecoveryAttemptId: undefined,
      issueFingerprint: buildUsageLimitIssueFingerprint(untimedIssue), resetAtMs: 200, nextCheckAtMs: 200 };
    const metadata = { ...input.metadata, sessionUsageLimitRecoveryV1: enriched };
    input.rawSession.metadata = JSON.stringify(metadata);

    expect(await continueSessionAfterUsageLimitReset({ ...input, metadata, recovery: enriched }))
      .toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledOnce();
  });

  it('uses the exact owner mode while fresh presentation still has off mode', async () => {
    const input = fixture();
    const presented = { ...input.metadata, sessionUsageLimitRecoveryV1: { ...recovery, resumePromptMode: 'off' } };
    transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, metadata: JSON.stringify(presented) });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(1);
  });

  it('puts continuation in ordinary Pending and wakes a healthy runner at reset', async () => {
    const input = fixture();
    const result = await continueSessionAfterUsageLimitReset(input);
    expect(result).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith(expect.objectContaining({
      sessionId, body: expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-continuation:/),
        deliveryMode: 'continuation_if_no_queued_user_input', requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: expect.objectContaining({ role: 'user', content: { type: 'text', text: 'Usage limits are lifted. Continue where you left off.' } }) },
      }),
    }));
    expect(transport.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({ method: `${sessionId}:session.pendingQueue.wake.v1` }));
    expect(input.ensureRuntime).toHaveBeenCalled();
  });

  it.each([true, false])('qualifies the provider account and organization before Pending admission with a live runner=%s', async (live) => {
    const input = fixture({ active: live });
    const classification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit', serviceId: 'claude-subscription', profileId: 'account-1', groupId: null,
      credentialRevision: 'original-revision', sourceProviderAccountId: 'original-account',
      sourceProviderOrganizationId: 'original-organization',
      resetsAtMs: 200, planType: null, rateLimits: null, source: 'structured_provider_error',
    };
    const tracked = { startedBy: 'daemon' as const, happySessionId: sessionId, pid: 123,
      spawnOptions: { directory: '/tmp/project' } };
    let boundProfileId = 'account-1';
    const authorizeLiveSource = async () => {
      const authorization = await authorizeConnectedServiceRuntimeAuthFailureSource({
        getChildren: () => [tracked], sessionId, classification, recoveryInvocationSource: 'scheduler_retry',
        resolveRegisteredRuntimeAuthFailureSource: () => ({ serviceId: 'claude-subscription', groupId: null,
          profileId: boundProfileId, generation: null, credentialRevision: 'refreshed-revision' }),
      });
      return authorization.status === 'authorized' || authorization.status === 'current_credential_revision';
    };
    const run = (providerAccountId: string, organizationUuid = 'original-organization') => continueSessionAfterUsageLimitReset({
      ...input, isCurrent: () => isCurrentUsageLimitRecoverySource({ classification,
        resolveCredential: async () => ({ credentialRevision: 'refreshed-revision',
          record: buildConnectedServiceCredentialRecord({ now: 100, serviceId: 'claude-subscription',
            profileId: 'account-1', kind: 'oauth', expiresAt: 1000,
            oauth: { accessToken: 'access', refreshToken: 'refresh', providerAccountId,
              idToken: null, scope: null, tokenType: null, providerEmail: null,
              raw: { claudeAiOauth: { organizationUuid } } } }),
        }), ...(live ? { authorizeLiveSource } : {}),
      }),
    });
    expect(await run('replacement-account')).toEqual({ status: 'superseded' });
    expect(await run('original-account', 'replacement-organization')).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(await run('original-account')).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledOnce();
    if (live) {
      boundProfileId = 'replacement-profile';
      expect(await run('original-account')).toEqual({ status: 'superseded' });
      expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledOnce();
    }
  });

  it('checks canonical runtime adoption after admission when the active projection outlives its runner', async () => {
    const input = fixture({ active: true });
    input.ensureRuntime.mockResolvedValue(false);
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'runtime_unavailable' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('does not admit a continuation when recovery is cancelled during session transport lookup', async () => {
    const input = fixture();
    let current = true;
    transport.fetchSessionById.mockImplementation(async () => {
      current = false;
      return input.rawSession;
    });
    expect(await continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current }))
      .toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('keeps admitted ordinary input when cancellation follows Pending acceptance and suppresses later recovery', async () => {
    const input = fixture({ active: false });
    let current = true;
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async () => {
      current = false;
      return { didWrite: true, terminal: false };
    });
    const run = () => continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(1);
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('uses the persisted canonical failed turn when SDK issue evidence lacks a provider turn id', async () => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn', lastRuntimeIssue: { ...issue, providerTurnId: undefined } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('keeps the same interrupted issue qualified when terminal projection delivery follows recovery arming', async () => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn', latestTurnStatusObservedAt: 150 });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it.each([
    ['a newer completed turn', { latestTurnId: 'newer-canonical-turn', latestTurnStatus: 'completed' }, {}],
    ['a newer failed turn', { latestTurnId: 'newer-canonical-turn', latestTurnStatus: 'failed',
      lastRuntimeIssue: { ...issue, providerTurnId: 'newer-provider-turn', occurredAt: 120 } }, {}],
    ['a replaced canonical turn with identical issue evidence', { latestTurnId: 'newer-canonical-turn' },
      { lastRuntimeIssue: { ...issue, providerTurnId: undefined } }],
    ['changed account evidence with the same fingerprint', { lastRuntimeIssue: {
      ...issue, usageLimit: { ...issue.usageLimit!, connectedService: {
        serviceId: 'claude-subscription', profileId: 'account-2', groupId: null,
      } },
    } }, {}],
  ] as const)('suppresses %s during transport lookup', async (_name, freshOverrides, initialOverrides) => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn', ...initialOverrides });
    transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, ...freshOverrides });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('retains one Pending identity while retrying unavailable runtime attachment', async () => {
    const input = fixture({ active: false });
    const pending = new Map<string, unknown>();
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async ({ body }) => {
      pending.set(body.localId, body.content);
      return { didWrite: true, terminal: false };
    });
    input.ensureRuntime.mockImplementation(async () => {
      expect(pending.size).toBe(1);
      expect(input.metadata.claudeSessionId).toBe('saved-provider-thread');
      return false;
    });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'runtime_unavailable' });
    input.ensureRuntime.mockResolvedValueOnce(true);
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(pending.size).toBe(1);
    expect(transport.enqueuePendingQueueV2MessageViaHttp.mock.calls[1]?.[0])
      .toEqual(transport.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0]);
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
  });

  it('uses custom continuation text without reconstructing original user input', async () => {
    const input = fixture();
    input.recovery = { ...input.recovery, resumePromptMode: 'custom' };
    await continueSessionAfterUsageLimitReset({ ...input, customResumePrompt: 'Resume the interrupted work' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0].body.content.v.content.text)
      .toBe('Resume the interrupted work');
  });

  it('honors atomic Pending suppression when explicit input is already queued', async () => {
    const input = fixture({ active: false });
    transport.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({ didWrite: false, terminal: false, suppressed: true });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(input.ensureRuntime).not.toHaveBeenCalled();
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
  });

  it('does not ensure a runtime when Pending custody is unconfirmed', async () => {
    const input = fixture({ active: false });
    transport.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue(new Error('network disconnected'));
    await expect(continueSessionAfterUsageLimitReset(input)).rejects.toThrow('continuation_prompt_send_failed:timeout');
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled', 'in_progress', null] as const)('rejects latest turn status %s despite historic issue evidence', async (latestTurnStatus) => {
    const input = fixture({ latestTurnStatus });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it.each([
    ['newer failed turn', { ...issue, providerTurnId: 'newer-turn', occurredAt: 111 }],
    ['new reset', { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: 201 } }],
    ['new account', { ...issue, usageLimit: { ...issue.usageLimit!, connectedService: { serviceId: 'claude-subscription', profileId: 'account-2', groupId: null } } }],
    ['authentication failure', { ...issue, source: 'auth_error', usageLimit: undefined }],
    ['unidentified turn', { ...issue, providerTurnId: undefined }],
  ])('rejects %s as an obsolete interruption', async (_name, lastRuntimeIssue) => {
    const input = fixture({ lastRuntimeIssue: lastRuntimeIssue as SessionRuntimeIssueV1 });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('rejects changed current bindings even when the latest issue still describes the failed account', async () => {
    const input = fixture();
    input.metadata.connectedServices.bindingsByServiceId['claude-subscription'].profileId = 'account-2';
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'exhausted', 'paused'] as const)('does not revive an owner-tagged %s attempt', async (status) => {
    const input = fixture();
    input.metadata.sessionUsageLimitRecoveryV1 = { ...recovery, status };
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('rejects a replacement attempt', async () => {
    const input = fixture();
    input.metadata.sessionUsageLimitRecoveryV1 = { ...recovery, runtimeAuthRecoveryAttemptId: 'replacement' };
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('waits before reset and keeps off mode passive when reset is due', async () => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, nowMs: 199 })).toEqual({ status: 'not_ready' });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, resumePromptMode: 'off' } }))
      .toEqual({ status: 'disabled' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('uses a due provider reset for a manual owned retry despite a later local backoff check', async () => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, nextCheckAtMs: 300 } }))
      .toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it.each(['waiting', 'cancelled', 'paused'] as const)('continues the current native failed issue after explicit enable from %s', async (status) => {
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue, providerTurnId: undefined,
      usageLimit: { ...issue.usageLimit!, connectedService: null } };
    const input = fixture({ active: false, lastRuntimeIssue: nativeIssue });
    const previous: SessionUsageLimitRecoveryV1 = { ...recovery, status,
      runtimeAuthRecoveryAttemptId: undefined, armedAtMs: 100, nextCheckAtMs: null,
      issueFingerprint: 'usage-limit:claude:unknown-turn:100:200', selectedAuth: { kind: 'native' } };
    const nativeRecovery = mergeUsageLimitRecoveryExplicitRearm(previous, { ...previous, status: 'waiting', nextCheckAtMs: 200 });
    expect(nativeRecovery.armedAtMs).toBe(status === 'waiting' ? 100 : 101);
    input.rawSession.metadata = JSON.stringify({ sessionUsageLimitRecoveryV1: nativeRecovery });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: nativeRecovery,
      metadata: { sessionUsageLimitRecoveryV1: nativeRecovery } })).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
    expect(input.ensureRuntime).toHaveBeenCalled();
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...nativeRecovery, issueFingerprint: 'historic-issue' }, metadata: {} }))
      .toEqual({ status: 'superseded' });
  });

  it('retains ready native backoff without a provider reset instead of adding another clock owner', async () => {
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue,
      usageLimit: { ...issue.usageLimit!, resetAtMs: null, connectedService: null } };
    const input = fixture({ lastRuntimeIssue: nativeIssue });
    const nativeRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, status: 'paused',
      runtimeAuthRecoveryAttemptId: undefined, armedAtMs: 100, resetAtMs: null, nextCheckAtMs: null,
      issueFingerprint: 'usage-limit:claude:interrupted-turn:100:no-reset', selectedAuth: { kind: 'native' } };
    input.rawSession.metadata = JSON.stringify({ sessionUsageLimitRecoveryV1: nativeRecovery });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: nativeRecovery,
      metadata: { sessionUsageLimitRecoveryV1: nativeRecovery } })).toEqual({ status: 'continued' });
  });

  it('admits native quota-source evidence without requiring a connected account binding', async () => {
    const sourceId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: '/native/config' });
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!,
      connectedService: { serviceId: 'claude-subscription', profileId: sourceId, groupId: null } } };
    const input = fixture({ lastRuntimeIssue: nativeIssue });
    const nativeRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, status: 'paused',
      runtimeAuthRecoveryAttemptId: undefined, armedAtMs: 100, nextCheckAtMs: null,
      issueFingerprint: 'usage-limit:claude:interrupted-turn:100:200', selectedAuth: { kind: 'native', serviceId: 'claude-subscription' } };
    const metadata = { sessionUsageLimitRecoveryV1: nativeRecovery };
    input.rawSession.metadata = JSON.stringify(metadata);
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: nativeRecovery, metadata })).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('qualifies a group without requiring its metadata to expose the applied profile', async () => {
    const groupIssue: SessionRuntimeIssueV1 = { ...issue,
      usageLimit: { ...issue.usageLimit!, connectedService: { serviceId: 'claude-subscription', profileId: 'account-1', groupId: 'group-1' } } };
    const input = fixture({ lastRuntimeIssue: groupIssue });
    const groupRecovery: SessionUsageLimitRecoveryV1 = { ...recovery,
      selectedAuth: { kind: 'group', serviceId: 'claude-subscription', profileId: 'account-1', groupId: 'group-1' } };
    const metadata = { sessionUsageLimitRecoveryV1: groupRecovery,
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'group-1' } } } };
    input.rawSession.metadata = JSON.stringify(metadata);
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: groupRecovery, metadata })).toEqual({ status: 'continued' });
    metadata.connectedServices.bindingsByServiceId['claude-subscription'].groupId = 'group-2';
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: groupRecovery, metadata })).toEqual({ status: 'superseded' });
  });

  it.each(['pi', 'opencode'] as const)('continues a provider-less %s issue and suppresses replacement provider evidence', async (provider) => {
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue, provider: undefined,
      usageLimit: { ...issue.usageLimit!, connectedService: null } };
    const input = fixture({ active: false, lastRuntimeIssue: nativeIssue });
    const metadata = { agentRuntimeDescriptorV1: { v: 1, providerId: provider } };
    const adapter = provider === 'pi' ? createPiUsageLimitRecoveryControlAdapter({ nowMs: () => 200 })
      : createOpenCodeUsageLimitRecoveryControlAdapter({ nowMs: () => 200 });
    const ready = await adapter.checkNow!({ credentials, token: 'token', sessionId,
      rawSession: input.rawSession, metadata, currentMachineId: null, sessionMachineId: null, cwd: null,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }, mode: 'plain', resumePromptMode: 'standard' }) as { ok: boolean; status: string; metadata: Record<string, unknown> };
    expect(ready).toMatchObject({ ok: true, status: 'ready' });
    const nativeRecovery = ready.metadata.sessionUsageLimitRecoveryV1 as SessionUsageLimitRecoveryV1;
    expect(nativeRecovery.issueFingerprint).toBe(`usage-limit:${provider}:interrupted-turn:100:200`);
    input.rawSession.metadata = JSON.stringify(ready.metadata);
    expect(await continueSessionAfterUsageLimitReset({ ...input, metadata: ready.metadata, recovery: nativeRecovery }))
      .toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledOnce();
    transport.fetchSessionById.mockResolvedValue({ ...input.rawSession,
      lastRuntimeIssue: { ...nativeIssue, provider: 'claude' } });
    expect(await continueSessionAfterUsageLimitReset({ ...input, metadata: ready.metadata, recovery: nativeRecovery }))
      .toEqual({ status: 'suppressed' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledOnce();
  });

});
