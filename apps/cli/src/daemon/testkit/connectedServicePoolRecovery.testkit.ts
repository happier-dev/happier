import axios, { AxiosError } from 'axios';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, type SessionTurnMutationV1, type SessionContinuationRecoveryIdentityV1, type ConnectedServiceAuthGroupV1, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import { configuration } from '@/configuration';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { captureClaudeRuntimeAuthRequestIdentity, surfaceClaudeRateLimitRuntimeIssue } from '@/backends/claude/connectedServices/surfaceClaudeRuntimeIssues';
import { createRuntimeAuthFailureReportIntake, type RuntimeAuthFailureReportBody } from '@/daemon/controlServer';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '../connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '../connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests } from '../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxDrainScheduler';
import { readRuntimeAuthFailureReportOutboxItems } from '../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import { createConnectedServiceProviderActivityProofRecorder, isProviderActivityTurnLifecycleEvent } from '../connectedServices/recovery/providerActivityProofRecorder';
import { buildContinuationRecoveryIdentityFromBindings } from '../connectedServices/continuation/continuationRecoveryIdentity';
import { resolveRuntimeAuthFailureSourceProfile } from '../connectedServices/runtimeAuth/resolveRuntimeAuthFailureSourceProfile';
import { readCredentialAccountIdentity } from '../connectedServices/quotas/coordinator/support';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

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

import { createLocalServerStormTracker, createRuntimeAuthRecoveryLocalServerGate } from '../serverWork/localServerStorm';

// Local control IPC is a genuine transport boundary. The receiver below uses the
// same sanitizer and report intake as the daemon, including its durable scheduler.
const controlTransport = vi.hoisted(() => ({
  report: null as null | ((body: Readonly<{ reportId?: string; sessionId: string; switchesThisTurn?: number; classification: unknown }>) => Promise<unknown>),
}));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: async (body: Parameters<NonNullable<typeof controlTransport.report>>[0]) => {
    if (!controlTransport.report) throw new Error('Synthetic daemon transport is unavailable');
    return controlTransport.report(body);
  },
  notifyDaemonConnectedServiceQuotaSnapshot: async () => ({ ok: true }),
  notifyDaemonConnectedServiceTurnLifecycle: async () => ({ ok: true }),
}));

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
  newerTurnBeforeAdmission?: boolean;
  enrichedSecondProducer?: boolean;
  deferFailureProjection?: boolean;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-pool-recovery-'));
  const now = () => Date.now();
  const serverDir = Object.getOwnPropertyDescriptor(configuration, 'activeServerDir')!;
  Object.defineProperty(configuration, 'activeServerDir', { ...serverDir, value: root });
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  const rawSessions = new Map<string, RawSessionRecord>();
  const turnMutations: SessionTurnMutationV1[] = [];
  const reports: RuntimeAuthFailureReportBody[] = [];
  const continuationIdentities = new Map<string, SessionContinuationRecoveryIdentityV1>();
  const providerCompletions: Array<{ sessionId: string; recoveryIdentity: SessionContinuationRecoveryIdentityV1 }> = [];
  const pendingProjections: Array<() => void> = [];

  const profiles = input.drift ? ['A', 'A-prime', 'B', 'C'] : ['A', 'B', 'C'];
  const failedProfile = input.drift ? 'A-prime' : 'A';
  const resetAt = (input.enrichedSecondProducer ? 1793871333659 : POOL_RECOVERY_START_MS) + 120_000;
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
  const originalAdapter = axios.defaults.adapter;
  // Genuine Happier HTTP boundary: production lookup/schema parsing, encryption
  // selection, canAdmit, and Pending serialization all execute before custody.
  axios.defaults.adapter = async config => {
    await assertServer();
    const path = new URL(config.url!).pathname;
    const match = /^\/v2\/sessions\/([^/]+)(\/pending)?$/.exec(path);
    const raw = match && rawSessions.get(decodeURIComponent(match[1]!));
    if (!match || !raw) throw new Error(`Unexpected synthetic session request: ${config.method} ${path}`);
    let data: unknown;
    if (config.method === 'get' && !match[2]) data = { session: structuredClone(raw) };
    else if (config.method === 'post' && match[2]) {
      const body = JSON.parse(config.data) as { localId: string; content: { t: string; v: { content: { text: string } } }; deliveryMode: string };
      if (body.content.t !== 'plain' || body.deliveryMode !== 'continuation_if_no_queued_user_input') throw new Error('Unexpected Pending envelope');
      if (!prompts.some(prompt => prompt.sessionId === raw.id && prompt.localId === body.localId)) {
        prompts.push({ sessionId: raw.id, message: body.content.v.content.text, localId: body.localId });
      }
      data = { didWrite: true, suppressed: false, terminal: false };
    } else throw new Error(`Unexpected synthetic session request: ${config.method} ${path}`);
    return { data, headers: {}, config, status: 200, statusText: 'OK' };
  };
  const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials });
  let scheduler: RuntimeAuthRecoveryScheduler;
  let activeRecovery: Readonly<{ attemptId: string; armedAtMs: number; runtimeIssueFingerprint?: string | null }> | null = null;
  const continueSession = async (sessionId: string) => {
    const recovery = activeRecovery;
    if (!recovery) throw new Error('Missing real recovery admission context');
    const raw = rawSessions.get(sessionId)!;
    if (input.newerTurnBeforeAdmission) {
      raw.latestTurnId = `newer-turn-${sessionId}`;
      raw.latestTurnStatus = 'failed';
      raw.latestTurnStatusObservedAt = now() + 1;
      if (raw.lastRuntimeIssue) raw.lastRuntimeIssue = { ...raw.lastRuntimeIssue, occurredAt: now() + 1, providerTurnId: `newer-provider-turn-${sessionId}` };
    }
    const targetProfileId = group.activeProfileId;
    if (!targetProfileId) throw new Error('Continuation requires an applied provider profile');
    const target = { source: 'connected', selection: 'group', groupId, profileId: targetProfileId } as const;
    const identity = buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set([serviceId]), bindings: { v: 1, bindingsByServiceId: { [serviceId]: target } },
      failureFingerprint: recovery.attemptId, targetGenerationByServiceId: { [serviceId]: group.generation },
    });
    if (!identity) throw new Error('Missing continuation recovery identity');
    const result = await dispatcher.enqueueInterruptedOriginContinuation({ sessionId, attemptId: recovery.attemptId,
      interruptedOriginId: recovery.attemptId, interruption: 'provider_failed_turn',
      resumePromptMode: 'standard', recoveryKind: 'usage_limit', runtimeAuthRecovery: {
        armedAtMs: recovery.armedAtMs, runtimeIssueFingerprint: recovery.runtimeIssueFingerprint,
        isCurrent: () => scheduler.readForSession(sessions[0]!.happySessionId!).some(intent => intent.attemptId === recovery.attemptId
          && ['waiting', 'checking', 'resumed_awaiting_proof'].includes(intent.status)),
        readActiveTurnId: () => sessions.find(session => session.happySessionId === sessionId)?.activeTurnId ?? null,
      } });
    if (result.status === 'enqueued') continuationIdentities.set(sessionId, identity);
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
    rawSessions.set(sessionId, { id: sessionId, seq: 0, createdAt: now(), updatedAt: now(),
      active: false, activeAt: now(), encryptionMode: 'plain', metadata: JSON.stringify({ connectedServices }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      latestTurnId: `session-turn:failed-turn-${sessionId}`, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now() });
    return { startedBy: 'daemon', pid: 900_000 + index, happySessionId: sessionId, activeTurnId: `session-turn:failed-turn-${sessionId}`,
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
    // K5:fsm_switch synthetic provider boundary applies the real switch coordinator's committed target.
    applyConnectedServiceAuthGeneration: async ({ sessionId, activeProfileId, generation }) => {
      if (!activeProfileId) throw new Error('Missing provider application target');
      applied.set(sessionId, activeProfileId);
      registry.adoptExactGroupApplicationForSession({ sessionId, serviceId, groupId, profileId: activeProfileId, generation, credentialRevision: revision });
      return { ok: true, action: 'hot_applied' };
    },
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
  const recover = async (value: Readonly<{ sessionId: string; classification: ConnectedServiceRuntimeFailureClassification; switchesThisTurn: number; source?: 'scheduler_retry'; interruptedOriginId?: string }>) => {
    const intent = scheduler.readForSession(value.sessionId)[0];
    if (!intent?.attemptId) throw new Error('Daemon intake did not create an attempt');
    activeRecovery = { attemptId: intent.attemptId, armedAtMs: intent.armedAtMs, runtimeIssueFingerprint: value.classification.runtimeIssueFingerprint };
    const classification = await resolveRuntimeAuthFailureSourceProfile({ classification: value.classification,
      getGroupMembers: async () => group.members,
      resolveProviderAccountIdentity: async profileId => {
        const record = records.find(record => record.profileId === profileId);
        return record ? readCredentialAccountIdentity(record) : null;
      } });
    const result = await handleConnectedServiceRuntimeAuthFailureForSession({ ...value, classification, getChildren: () => sessions,
      switchCoordinator: switching, recoveryInvocationSource: value.source ?? 'daemon_report',
      resolveRegisteredRuntimeAuthFailureSource: ({ sessionId }) => {
        const binding = registry.getBySessionId(sessionId)?.activeBindings[0];
        return binding ? { ...binding, serviceId, profileId: binding.profileId, credentialRevision: binding.credentialRevision ?? null } : null;
      },
      continueAfterRuntimeAuthSwitch: async ({ sessionId }) => continueSession(sessionId),
    });
    results.push(result);
    await fanoutRuntimeAuthUsageLimitRecovery({ sessionId: value.sessionId, classification,
      recovery: result, quotaCoordinator: quotas, supersedingSourceConverged: false });
    return result;
  };
  const makeScheduler = () => createRuntimeAuthRecoverySchedulerForDaemon({ activeServerDir: root, nowMs: now,
    jitterMs: () => 0, recover,
    gate: createRuntimeAuthRecoveryLocalServerGate({ nowMs: now, isShuttingDown: () => false,
      storm, threshold: 3, baseBackoffMs: 2_000, maxBackoffMs: 60_000, jitterMs: () => 0 }),
    recordDiagnostic: event => { storm.recordRecoveryDiagnostic(event); diagnostics.push(event); } });
  scheduler = makeScheduler().scheduler;
  const makeIntake = () => createRuntimeAuthFailureReportIntake({ runtimeAuthRecoveryScheduler: scheduler,
    handleConnectedServiceRuntimeAuthFailure: recover });
  let intake = makeIntake();
  controlTransport.report = async body => {
    const classification = sanitizeConnectedServiceRuntimeFailureClassification(body.classification);
    if (!classification) throw new Error('Producer emitted invalid classification');
    const report = { ...body, classification };
    reports.push(report);
    return intake(report);
  };
  const firstId = sessions[0]!.happySessionId!;
  const projectTurn = async (mutation: SessionTurnMutationV1) => {
    turnMutations.push(mutation);
    const apply = () => {
      const raw = rawSessions.get(mutation.sessionId)!;
      if (mutation.action === 'begin' || mutation.action === 'fail' || mutation.action === 'complete') {
        raw.latestTurnId = mutation.turnId;
        raw.latestTurnStatus = mutation.action === 'begin' ? 'in_progress' : mutation.action === 'fail' ? 'failed' : 'completed';
        raw.latestTurnStatusObservedAt = mutation.observedAt;
        if (mutation.action === 'fail') raw.lastRuntimeIssue = mutation.issue;
      }
      // Other recipients have the same provider-rejected boundary; their raw
      // projections arrive over the server boundary independently of this report.
      if (mutation.action === 'fail' && mutation.sessionId === firstId) {
        for (const session of sessions.slice(1)) {
          const other = rawSessions.get(session.happySessionId!)!;
          other.latestTurnStatus = 'failed';
          other.latestTurnStatusObservedAt = mutation.observedAt;
          other.lastRuntimeIssue = mutation.issue;
        }
      }
    };
    if (input.deferFailureProjection && mutation.action === 'fail') pendingProjections.push(apply);
    else apply();
  };
  const makeProducer = () => {
    const lifecycle = createSessionTurnLifecycle({ sessionId: firstId, now,
      createId: () => `failed-turn-${firstId}`, enqueueSessionTurn: projectTurn });
    const session = { client: { sessionId: firstId, sessionTurnLifecycle: lifecycle } };
    return { lifecycle, session };
  };
  const producer = makeProducer();
  const proofRecorder = createConnectedServiceProviderActivityProofRecorder({
    runtimeAuthRecovery: { readForSession: id => scheduler.readForSession(id),
      markProviderOutcomeProofByKey: value => scheduler.markProviderOutcomeProofByKey(value) }, nowMs: now,
  });
  const details = (resetAtMs: number | null) => ({ v: 1 as const, resetAtMs, retryAfterMs: null,
    limitCategory: 'usage_limit' as const, quotaScope: 'account' as const, recoverability: 'wait' as const,
    planType: null, utilization: null, overage: null, action: null, connectedService: null,
    providerLimitId: input.window ?? 'five_hour' });
  return {
    sessions, applied, prompts, providerRequests, providerCompletions, diagnostics, results, registry,
    reports, turnMutations, rawSessions, continuationIdentities,
    failedProfile, resetAt, group: () => group, scheduler: () => scheduler,
    async fail() {
      await writeFile(join(root, '.claude.json'), JSON.stringify({ oauthAccount: {
        accountUuid: `account-${failedProfile}`, organizationUuid: `org-${failedProfile}` } }));
      vi.stubEnv(HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, sessions[0]!.spawnOptions!.environmentVariables![HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]!);
      await producer.lifecycle.beginTurn({ provider: 'claude', providerTurnId: 'provider-failed-turn' });
      await captureClaudeRuntimeAuthRequestIdentity(producer.session);
      unavailableUntil = now() + (input.serverOutageMs ?? 0);
      const failureReset = input.window === 'seven_day' ? resetAt + 86_400_000 : profileResetAt(failedProfile);
      if (input.enrichedSecondProducer) {
        // Two genuine producer lifecycles observe the same accepted provider turn.
        // Hold their IPC at the boundary until both raw projections have arrived.
        const deliver = controlTransport.report!;
        const held: Array<{ body: Parameters<typeof deliver>[0]; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
        controlTransport.report = body => new Promise((resolve, reject) => held.push({ body, resolve, reject }));
        const firstAt = 1793871333659;
        vi.setSystemTime(firstAt);
        const first = surfaceClaudeRateLimitRuntimeIssue(producer.session, details(null), '[synthetic provider]');
        await vi.waitFor(() => { if (held.length !== 1) throw new Error('First report pending'); });
        const observer = makeProducer();
        await observer.lifecycle.beginTurn({ provider: 'claude', providerTurnId: 'provider-failed-turn' });
        await captureClaudeRuntimeAuthRequestIdentity(observer.session);
        vi.setSystemTime(firstAt + 45);
        const second = surfaceClaudeRateLimitRuntimeIssue(observer.session, details(failureReset), '[synthetic native observer]');
        await vi.waitFor(() => { if (held.length !== 2) throw new Error('Second report pending'); });
        vi.setSystemTime(firstAt + 2031);
        controlTransport.report = deliver;
        for (const pending of held) {
          try { pending.resolve(await deliver(pending.body)); } catch (error) { pending.reject(error); }
        }
        await Promise.all([first, second]);
        observer.lifecycle.dispose();
      } else await surfaceClaudeRateLimitRuntimeIssue(producer.session, details(failureReset), '[synthetic provider]');
      return reports.at(-1);
    },
    releaseFailureProjection() { for (const apply of pendingProjections.splice(0)) apply(); },
    async rehydrateScheduler() { scheduler.dispose(); const next = makeScheduler(); scheduler = next.scheduler; intake = makeIntake(); scheduler.hydrate(); return next.hydratedIntents; },
    async proveProviderActivity(proofInput?: Readonly<{ staleAttempt?: boolean }>) {
      // The provider boundary returns the identity frozen when its continuation
      // was accepted. Never synthesize it from the current intent during proof.
      for (const [sessionId, acceptedIdentity] of continuationIdentities) {
        const recoveryIdentity = proofInput?.staleAttempt
          ? { ...acceptedIdentity, failureFingerprint: 'runtime-auth-attempt:stale-provider-output' } : acceptedIdentity;
        const proofWrites: Promise<void>[] = [];
        const resumed = createSessionTurnLifecycle({ sessionId, now, enqueueSessionTurn: projectTurn,
          onTurnLifecycleEvent: (event, terminalStatus) => {
            if (!isProviderActivityTurnLifecycleEvent(event, terminalStatus)) return;
            providerCompletions.push({ sessionId, recoveryIdentity });
            proofWrites.push(proofRecorder({ sessionId, recoveryIdentities: [recoveryIdentity] }));
          } });
        const prompt = prompts.find(prompt => prompt.sessionId === sessionId);
        if (!prompt?.localId) throw new Error('Provider completion requires an admitted prompt');
        await resumed.beginTurn({ provider: 'claude', providerTurnId: `resumed-${prompt.localId}`, startingInputLocalIds: [prompt.localId] });
        await resumed.completeTurn({ provider: 'claude' });
        await Promise.all(proofWrites);
        resumed.dispose();
      }
      return scheduler.hydratePassive();
    },
    async outboxItems() { return readRuntimeAuthFailureReportOutboxItems(); },
    async dispose() {
      producer.lifecycle.dispose(); scheduler.dispose(); quotas.dispose(); storm.dispose();
      resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
      controlTransport.report = null; axios.defaults.adapter = originalAdapter;
      Object.defineProperty(configuration, 'activeServerDir', serverDir); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    },
  };
}
