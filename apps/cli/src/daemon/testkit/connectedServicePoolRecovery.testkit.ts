import axios, { AxiosError } from 'axios';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, type ConnectedServiceAuthGroupV1, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import { createClaudeSubscriptionQuotaFetcher } from '@/backends/claude/connectedServices/quotaFetcher';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createConnectedServiceContinuationMessageDispatcher } from '../connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from '../connectedServices/descriptors/connectedAccountDescriptors';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { createRuntimeAuthRecoverySchedulerForDaemon } from '../connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon';
import { fanoutRuntimeAuthUsageLimitRecovery } from '../connectedServices/runtimeAuth/fanoutRuntimeAuthUsageLimitRecovery';
import { handleConnectedServiceRuntimeAuthFailureForSession } from '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import type { ConnectedServiceRuntimeFailureClassification } from '../connectedServices/runtimeAuth/types';
import type { RuntimeAuthRecoveryDiagnostic, RuntimeAuthRecoveryScheduler } from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from '../connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';

import { createLocalServerStormTracker, createRuntimeAuthRecoveryLocalServerGate } from '../serverWork/localServerStorm';

const serviceId = 'claude-subscription';
const groupId = 'synthetic-pool';
const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
export const POOL_RECOVERY_START_MS = Date.UTC(2026, 10, 4);

/** Compose production recovery owners; never boot a daemon or read a real credential. */
export async function createConnectedServicePoolRecoveryFixture(input: Readonly<{
  window?: 'five_hour' | 'seven_day';
  allExhausted?: boolean;
  drift?: boolean;
  serverOutageMs?: number;
  quotaProbeUnavailable?: boolean;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-pool-recovery-'));
  const now = () => Date.now();
  const profiles = input.drift ? ['A', 'A-prime', 'B', 'C'] : ['A', 'B', 'C'];
  const failedProfile = input.drift ? 'A-prime' : 'A';
  const resetAt = POOL_RECOVERY_START_MS + 120_000;
  const profileResetAt = (profileId: string) => resetAt + (input.allExhausted && profileId !== 'B' ? 60_000 : 0);
  let unavailableUntil = POOL_RECOVERY_START_MS;
  const serverClient = axios.create({ adapter: async config => {
    const response = { data: {}, headers: {}, config, status: now() < unavailableUntil ? 503 : 200, statusText: '' };
    if (response.status === 503) throw new AxiosError('synthetic Happier 503', 'ERR_BAD_RESPONSE', config, undefined, response);
    return response;
  } });
  const storm = createLocalServerStormTracker({ nowMs: now, windowMs: 60_000,
    serverUrl: 'https://pool-server.invalid', client: serverClient });
  const assertServer = async () => { await serverClient.get('https://pool-server.invalid/api/synthetic'); };
  let group: ConnectedServiceAuthGroupV1 = {
    v: 1, serviceId, groupId, displayName: null, activeProfileId: failedProfile,
    generation: input.drift ? 2 : 1, runtimeStateRevision: 0, state: { v: 1 },
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
    members: profiles.map((profileId, priority) => ({ v: 1, serviceId, groupId, profileId,
      priority, enabled: true, state: { v: 1 }, createdAt: 1, updatedAt: 1 })), createdAt: 1, updatedAt: 1,
  };
  const credentials = { token: 'synthetic-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) } };
  const records = profiles.map(profileId => buildConnectedServiceCredentialRecord({
    now: now(), serviceId, profileId, kind: 'oauth', expiresAt: now() + 86_400_000,
    oauth: { accessToken: `synthetic-${profileId}`, refreshToken: 'synthetic-refresh', idToken: null,
      scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE, tokenType: null, providerAccountId: `account-${profileId}`, providerEmail: null,
      raw: { claudeAiOauth: { organizationUuid: `org-${profileId}` } } },
  }));
  const providerRequests: string[] = [];
  // Genuine provider HTTP boundary. Unknown URLs fail closed: no network or real accounts.
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== 'https://pool-provider.invalid' || parsed.pathname !== '/api/oauth/usage') {
      throw new Error(`Unexpected provider request: ${parsed.origin}${parsed.pathname}`);
    }
    const profileId = new Headers(init?.headers).get('authorization')?.replace('Bearer synthetic-', '');
    if (!profileId || !profiles.includes(profileId)) throw new Error('Non-synthetic quota credential');
    providerRequests.push(profileId);
    const exhausted = now() < profileResetAt(profileId) && (input.allExhausted || profileId === failedProfile || (input.drift && profileId === 'A'));
    return new Response(JSON.stringify({
      five_hour: { utilization: input.window !== 'seven_day' && exhausted ? 100 : 10, resets_at: new Date(profileResetAt(profileId)).toISOString() },
      seven_day: { utilization: input.window === 'seven_day' && exhausted ? 100 : 10, resets_at: new Date(resetAt + 86_400_000).toISOString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const registry = new ConnectedServiceRuntimeRegistry({ nowMs: now });
  const snapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const usage = createProviderAccountUsageStore();
  const prompts: Array<{ sessionId: string; message: string; localId: string | undefined }> = [];
  const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials,
    sendMessage: async value => {
      await assertServer();
      prompts.push({ sessionId: value.idOrPrefix, message: value.message, localId: value.localId });
      return { ok: true, sessionId: value.idOrPrefix, localId: value.localId ?? 'missing', waited: false };
    },
  });
  const continueSession = async (sessionId: string) => {
    await dispatcher.enqueueInterruptedOriginContinuation({ sessionId, attemptId: 'synthetic-hard-limit',
      interruptedOriginId: `failed-turn-${sessionId}`, interruption: 'provider_failed_turn',
      resumePromptMode: 'standard', recoveryKind: 'usage_limit' });
  };
  const applied = new Map<string, string>();
  const sessions: TrackedSession[] = Array.from({ length: 12 }, (_, index) => {
    const sessionId = `synthetic-session-${index}`;
    const environmentVariables = { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
      kind: 'group', serviceId, groupId, activeProfileId: 'A', fallbackProfileId: 'B', generation: 1,
    }]) };
    const connectedServices: ConnectedServiceBindingsV1 = { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId } } };
    registry.registerTarget({ pid: 900_000 + index, sessionId,
      connectedServicesBindingsRaw: connectedServices, connectedServiceSelectionsEnv: environmentVariables });
    if (input.drift) registry.adoptExactGroupApplicationForSession({ sessionId, serviceId, groupId,
      profileId: failedProfile, generation: 2, credentialRevision: revision });
    applied.set(sessionId, failedProfile);
    return { startedBy: 'daemon', pid: 900_000 + index, happySessionId: sessionId,
      spawnOptions: { directory: root, environmentVariables, connectedServices } } satisfies TrackedSession;
  });
  const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
    resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'synthetic-provider-runtime' }),
    verifySharedGenerationApplication: async () => null,
    // Provider runtime application/notification are external boundaries, not selector fakes.
    applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
      const target = committedGeneration.decisionCommittedTarget;
      applied.set(sessionId, target.profileId);
      registry.adoptExactGroupApplicationForSession({ sessionId, ...target });
      return { reconciliationDisposition: 'converged', errorCode: null, providerAdoptedTarget: { ...target,
        proof: { status: 'verified', source: 'synthetic_claude_runtime', providerAccountId: `account-${target.profileId}`,
          credentialRevision: target.credentialRevision } } };
    },
    notifyCurrentGroupTruth: async () => ({ ok: true }),
    continueAfterExactRecipientApplication: async ({ sessionId }) => continueSession(sessionId),
  });
  const api = {
    getAccountEncryptionMode: async () => { await assertServer(); return 'plain'; },
    getAccountEncryptionModeUncached: async () => { await assertServer(); return 'plain'; },
    getConnectedServiceAuthGroup: async () => { await assertServer(); return group; },
    getConnectedServiceQuotaSnapshotPlain: async () => { await assertServer(); return null; },
    getConnectedServiceQuotaSnapshotSealed: async () => { await assertServer(); return null; },
    getConnectedServiceCredentialSealed: async () => { await assertServer(); return null; },
    getConnectedServiceCredentialPlain: async ({ profileId }: Readonly<{ profileId: string }>) => {
      await assertServer();
      const record = records.find(value => value.profileId === profileId);
      if (!record) throw new Error('Unknown synthetic profile');
      return { revisionSemantics: 'revisioned' as const, credentialRevision: revision, content: { t: 'plain' as const, v: record } };
    },
    acquireConnectedServiceRefreshLease: async () => { await assertServer(); return { acquired: true, leaseUntil: now() + 30_000 }; },
    updateConnectedServiceAuthGroupRuntimeState: async ({ memberStates }: Parameters<NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api']['updateConnectedServiceAuthGroupRuntimeState']>>[0]) => {
      await assertServer();
      group = { ...group, runtimeStateRevision: group.runtimeStateRevision + 1,
        members: group.members.map(member => ({ ...member, state: memberStates.find(value => value.profileId === member.profileId)?.state ?? member.state })) };
      return group;
    },
  } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
  let quotas: ConnectedServiceQuotasCoordinator;
  const switching = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
    api: { ...api, updateConnectedServiceAuthGroupActiveProfile: async ({ activeProfileId }) => {
      await assertServer(); group = { ...group, activeProfileId, generation: group.generation + 1 }; return group;
    } },
    accountUsageStore: usage, runtimeQuotaSnapshots: snapshots, quotaFreshnessMs: 300_000, nowMs: now,
    resolveCredentialRevision: () => revision, resolveCurrentCredentialRevision: async () => { await assertServer(); return revision; },
    consumeAvailableRecoveryCreditForProfile: value => quotas.consumeAvailableRecoveryCreditForProfile(value),
    probeQuotaSnapshotsForGroup: value => input.quotaProbeUnavailable
      ? Promise.resolve({ status: 'incomplete', reason: 'probe_unavailable', requestedProfileCount: value.profileIds.length,
        completedProfileCount: 0, completedProfileIds: [], deferredProfiles: [] })
      : quotas.probeGroupQuotaSnapshots(value),
    restartSession: async ({ sessionId, activeProfileId, generation }) => {
      if (!sessionId || !activeProfileId) throw new Error('Missing provider application target');
      applied.set(sessionId, activeProfileId);
      registry.adoptExactGroupApplicationForSession({ sessionId, serviceId, groupId, profileId: activeProfileId, generation, credentialRevision: revision });
    },
  });
  quotas = new ConnectedServiceQuotasCoordinator({ api, credentials, quotaFetchers: [createClaudeSubscriptionQuotaFetcher({
    usageUrl: 'https://pool-provider.invalid/api/oauth/usage', nowMs: now, userAgent: 'synthetic-pool-test' })],
    now, randomBytes, runtimeRegistry: registry, runtimeQuotaSnapshots: snapshots, accountUsageStore: usage,
    machineIdProvider: () => 'synthetic-machine', ownerIdProvider: () => 'synthetic-owner', discoveryEnabled: false,
    authGroupSwitchCoordinator: switching, sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
    consumeCommittedAuthGroupGeneration: value => consumer.consume(value),
  });
  const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
  const results: unknown[] = [];
  const failure: ConnectedServiceRuntimeFailureClassification = { kind: 'usage_limit', limitCategory: 'usage_limit',
    serviceId, groupId, profileId: failedProfile, groupGeneration: group.generation,
    sourceProviderAccountId: `account-${failedProfile}`, sourceProviderOrganizationId: `org-${failedProfile}`,
    resetsAtMs: input.window === 'seven_day' ? resetAt + 86_400_000 : profileResetAt(failedProfile),
    providerLimitId: input.window ?? 'five_hour', quotaScope: 'account',
    planType: null, rateLimits: null, source: 'structured_provider_error' };
  let scheduler: RuntimeAuthRecoveryScheduler;
  const recover = async (value: Readonly<{ sessionId: string; classification: ConnectedServiceRuntimeFailureClassification; switchesThisTurn: number }>) => {
    const result = await handleConnectedServiceRuntimeAuthFailureForSession({ ...value, getChildren: () => sessions,
      switchCoordinator: switching, recoveryInvocationSource: 'scheduler_retry',
      resolveRegisteredRuntimeAuthFailureSource: ({ sessionId }) => {
        const binding = registry.getBySessionId(sessionId)?.activeBindings[0];
        return binding ? { ...binding, serviceId, profileId: binding.profileId, credentialRevision: binding.credentialRevision ?? null } : null;
      },
      continueAfterRuntimeAuthSwitch: async ({ sessionId }) => continueSession(sessionId),
    });
    results.push(result);
    await fanoutRuntimeAuthUsageLimitRecovery({ sessionId: value.sessionId, classification: value.classification,
      recovery: result, quotaCoordinator: quotas, supersedingSourceConverged: false });
    return result;
  };
  const makeScheduler = () => createRuntimeAuthRecoverySchedulerForDaemon({ activeServerDir: root, nowMs: now,
    jitterMs: () => 0, recover,
    gate: createRuntimeAuthRecoveryLocalServerGate({ nowMs: now, isShuttingDown: () => false,
      storm, threshold: 3, baseBackoffMs: 2_000, maxBackoffMs: 60_000, jitterMs: () => 0 }),
    recordDiagnostic: event => { storm.recordRecoveryDiagnostic(event); diagnostics.push(event); } });
  scheduler = makeScheduler().scheduler;
  return {
    sessions, applied, prompts, providerRequests, diagnostics, results, registry,
    failedProfile, resetAt, group: () => group, scheduler: () => scheduler,
    async fail() {
      unavailableUntil = now() + (input.serverOutageMs ?? 0);
      await scheduler.beginClassifiedFailure({ sessionId: sessions[0]!.happySessionId!, switchesThisTurn: 0, classification: failure });
      try {
        const result = await recover({ sessionId: sessions[0]!.happySessionId!, switchesThisTurn: 0, classification: failure });
        const intent = scheduler.hydratePassive()[0];
        if (intent) {
          await scheduler.markDurableWaitForResultByKey({ recoveryKey: buildRuntimeAuthRecoveryKey(intent), result,
            classificationFailureKind: 'usage_limit', classificationResetsAtMs: failure.resetsAtMs });
          await scheduler.markAwaitingProviderOutcomeProofForResultByKey({ recoveryKey: buildRuntimeAuthRecoveryKey(intent), result });
        }
        return result;
      } catch (error) {
        await scheduler.enqueueHandlerFailure({ sessionId: sessions[0]!.happySessionId!, switchesThisTurn: 0, classification: failure, error });
        return { status: 'handler_failed' };
      }
    },
    async restart() { scheduler.dispose(); const next = makeScheduler(); scheduler = next.scheduler; scheduler.hydrate(); return next.hydratedIntents; },
    async proveProviderActivity() {
      // External provider output after the captured continuation, delivered to
      // the same public proof boundary used by daemon runtime activity.
      for (const intent of scheduler.hydratePassive()) {
        await scheduler.markProviderOutcomeProofByKey({ recoveryKey: buildRuntimeAuthRecoveryKey(intent),
          proofKind: 'provider_activity', expectedAttemptId: intent.attemptId, observedAtMs: now() });
      }
      return scheduler.hydratePassive();
    },
    async dispose() { scheduler.dispose(); quotas.dispose(); storm.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}
