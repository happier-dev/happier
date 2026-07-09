import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceBindingsV1, ConnectedServiceId } from '@happier-dev/protocol';

import {
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupSwitchResult,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import type { ConnectedServiceCredentialRefreshResult } from '../refresh/ConnectedServiceRefreshCoordinator';
import {
  createConnectedServiceSessionAuthSwitchCore,
  type ConnectedServiceSessionAuthSwitchReason,
  type ConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';
import { buildConnectedServiceSwitchContinuationAttemptId } from '../sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';
import {
  isGroupRuntimeRecoverySelection,
  resolveConnectedServiceRuntimeAuthRecoverySelection,
} from './resolveConnectedServiceRuntimeAuthRecoverySelection';

type SwitchCoordinatorLike = Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator'];
type TemporaryThrottleRecoveryLike = NonNullable<
  Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['temporaryThrottleRecovery']
>;
type SwitchAttemptTrackerLike = Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  'resolveSwitchesThisTurn' | 'recordSwitchResult' | 'countRecordedSwitchesInWindow' | 'clearSession'
>;
type RuntimeAuthRecoveryReaderLike = Readonly<{
  readForSession(sessionId: string): ReadonlyArray<Readonly<{
    serviceId: string;
    groupId: string | null;
    profileId: string | null;
    status: 'waiting' | 'checking' | 'resumed_awaiting_proof' | 'cancelled' | 'exhausted';
    lastError?: string | null;
    classification: Readonly<{ profileId: string | null }>;
    pendingTargetProfileId?: string | null;
    pendingTargetGeneration?: number | null;
  }>>;
}>;
type RuntimeAuthSwitchContinuation = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
}>) => Promise<void> | void;
type RuntimeAuthCredentialRefresh = (input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  sessionId: string;
}>) => Promise<ConnectedServiceCredentialRefreshResult>;
type RuntimeAuthRecoveryInvocationSource = 'daemon_report' | 'scheduler_retry';

// A scheduler replay of a persisted recovery intent whose failing profile the live
// session no longer runs. The group already moved off the failing profile, so there
// is nothing left to recover for this intent: the scheduler removes it so the same
// recovery key can re-arm on a genuine future failure.
export type RuntimeAuthRecoverySuperseded = Readonly<{
  status: 'recovery_superseded';
  reason: 'failing_profile_inactive';
  serviceId: string;
  groupId: string;
  failingProfileId: string | null;
  activeProfileId: string | null;
}>;

type RuntimeRecoveryActionRequired = Readonly<{
  status: 'recovery_action_required';
  action: Readonly<{
    kind: 'reconnect_profile';
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId: string | null;
    reason: ConnectedServiceRuntimeFailureClassification['kind'];
  }>;
}>;
type RuntimeCredentialRefreshed = Readonly<{
  status: 'credential_refreshed';
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string | null;
  refresh: ConnectedServiceCredentialRefreshResult;
  restartRequested: boolean;
}>;

const unavailableSwitchCoordinator: SwitchCoordinatorLike = {
  switchAfterClassifiedFailure: async () => ({
    status: 'no_eligible_member',
    generation: 0,
    groupExhausted: true,
    retryAtMs: null,
    excluded: [],
  }),
};

const defaultSwitchCore = createConnectedServiceSessionAuthSwitchCore();
function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableProfileId(value: unknown): string | null {
  const normalized = normalizeSessionId(value);
  return normalized.length > 0 ? normalized : null;
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

async function maybeRestartAfterRuntimeGroupSwitch(input: Readonly<{
  tracked: TrackedSession | null;
  result: ConnectedServiceAuthGroupSwitchResult;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
}>): Promise<void> {
  if (!input.tracked) return;
  if (input.result.status !== 'switched') return;
  if (input.result.mode !== 'spawn_next_turn') return;
  await input.restartSession?.(input.tracked);
}

async function maybeContinueAfterObservedRuntimeGeneration(input: Readonly<{
  tracked: TrackedSession | null;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  result: ConnectedServiceAuthGroupSwitchResult;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.tracked) return;
  if (!input.continueAfterRuntimeAuthSwitch) return;
  if (input.result.status !== 'observed_generation') return;
  const activeProfileId = normalizeSessionId(input.result.activeProfileId);
  if (!activeProfileId) return;

  const normalizedBindings = {
    v: 1,
    bindingsByServiceId: {
      [input.serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
        profileId: activeProfileId,
      },
    },
  } satisfies ConnectedServiceBindingsV1;
  const serviceIds = new Set<ConnectedServiceId>([input.serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'hot_applied',
      serviceIds,
      normalizedBindings,
      expectedGroupGenerationByServiceId: {
        [input.serviceId]: input.result.generation,
      },
    }),
    normalizedBindings,
    serviceIds,
    action: 'hot_applied',
    switchReason: 'automatic_runtime_failure',
  });
}

async function continueAfterRuntimeCredentialRefresh(input: Readonly<{
  tracked: TrackedSession | null;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.tracked) return;
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const normalizedBindings = {
    v: 1,
    bindingsByServiceId: {
      [input.serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
        profileId: input.profileId,
      },
    },
  } satisfies ConnectedServiceBindingsV1;
  const serviceIds = new Set<ConnectedServiceId>([input.serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'hot_applied',
      serviceIds,
      normalizedBindings,
    }),
    normalizedBindings,
    serviceIds,
    action: 'hot_applied',
    switchReason: 'automatic_runtime_failure',
  });
}

function isActiveProfileRefreshRuntimeFailure(
  classification: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return classification.kind === 'auth_expired';
}

function requiresProfileReconnectWithoutGroupSwitch(
  classification: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return classification.kind === 'account_changed';
}

function hasPendingProviderProofForRuntimeAuthIdentity(input: Readonly<{
  runtimeAuthRecovery?: RuntimeAuthRecoveryReaderLike | null;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string | null;
}>): boolean {
  if (!input.runtimeAuthRecovery) return false;
  return input.runtimeAuthRecovery.readForSession(input.sessionId).some((intent) => {
    const awaitingProviderProof = intent.status === 'resumed_awaiting_proof'
      || (
        intent.status === 'checking'
        && intent.lastError === 'recovery_unproven_awaiting_provider_outcome'
      );
    if (!awaitingProviderProof) return false;
    if (intent.serviceId !== input.serviceId) return false;
    if (input.groupId) return intent.groupId === input.groupId;
    return intent.groupId === null && intent.profileId === input.profileId;
  });
}

function reconnectProfileAction(input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
  reason: ConnectedServiceRuntimeFailureClassification['kind'];
}>): RuntimeRecoveryActionRequired {
  return {
    status: 'recovery_action_required',
    action: {
      kind: 'reconnect_profile',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      reason: input.reason,
    },
  };
}

// A recovery driven by a failure attributed to a profile the live session is NOT
// running (e.g. a persisted stale rate-limit intent replayed by the scheduler) must
// never restart or steer the live session: the session is healthy on another group
// member, and the committed switch applies on the next natural spawn. Incident
// 2026-06-12 (cmq8y3nlx): a stale intent for an inactive profile restarted a healthy
// mid-work session on every scheduler retry, churning accounts for ~30 minutes.
// `selection.activeProfileId` only exists for spawned-env (child_env) selections, so
// the guard is naturally scoped to provably-live spawn provenance.
function isRuntimeFailureForInactiveProfile(input: Readonly<{
  selection: Extract<ReturnType<typeof resolveConnectedServiceRuntimeAuthRecoverySelection>['selection'], Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
}>): boolean {
  const failingProfileId = normalizeNullableProfileId(input.classification.profileId);
  const liveActiveProfileId = normalizeNullableProfileId(input.selection.activeProfileId);
  return Boolean(failingProfileId && liveActiveProfileId && failingProfileId !== liveActiveProfileId);
}

function shouldCoalescePendingProofTargetReplay(input: Readonly<{
  runtimeAuthRecovery?: RuntimeAuthRecoveryReaderLike | null;
  sessionId: string;
  selection: Extract<ReturnType<typeof resolveConnectedServiceRuntimeAuthRecoverySelection>['selection'], Readonly<{ kind: 'group' }>>;
  result: ConnectedServiceAuthGroupSwitchResult;
}>): boolean {
  if (!input.runtimeAuthRecovery) return false;
  if (input.result.status !== 'switched' && input.result.status !== 'observed_generation') return false;
  const targetProfileId = normalizeSessionId(input.result.activeProfileId);
  if (!targetProfileId) return false;
  // The pending proof target is the PROFILE, deliberately NOT the group generation:
  // sibling sessions thrash the shared group generation between replays (incident
  // 2026-06-12, gen 81→87), so an exact-generation match never holds and every replay
  // re-kills/re-continues the live session. A fresher generation for the same target
  // profile is the same logical switch.
  return input.runtimeAuthRecovery.readForSession(input.sessionId).some((intent) => (
    intent.serviceId === input.selection.serviceId
    && intent.groupId === input.selection.groupId
    && (intent.profileId === null || intent.profileId === targetProfileId)
    && intent.status === 'resumed_awaiting_proof'
    && intent.pendingTargetProfileId === targetProfileId
    && Boolean(intent.classification.profileId && intent.classification.profileId !== targetProfileId)
  ));
}

export async function handleConnectedServiceRuntimeAuthFailureForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  resolveInactiveSession?(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    agentId?: string | null;
    connectedServices: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: unknown;
    vendorResumeId?: string | null;
    cwd?: string | null;
    candidatePersistedSessionFile?: string | null;
  }> | null>;
  switchCoordinator: SwitchCoordinatorLike | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  switchCore?: ConnectedServiceSessionAuthSwitchCore | null;
  runtimeAuthRecovery?: RuntimeAuthRecoveryReaderLike | null;
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  refreshConnectedServiceCredentialForRuntimeAuthFailure?: RuntimeAuthCredentialRefresh | null;
  sessionId: string;
  switchesThisTurn: number;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  classification: ConnectedServiceRuntimeFailureClassification | null;
}>): Promise<
  | Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{
      status: 'switch_coordinator_unavailable';
      blocker: 'CLI has no connected-service auth-group load/commit API in this branch.';
    }>
  | RuntimeRecoveryActionRequired
  | RuntimeCredentialRefreshed
  | RuntimeAuthRecoverySuperseded
> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  const inactive = tracked
    ? null
    : await input.resolveInactiveSession?.({ sessionId: input.sessionId }) ?? null;
  if (!tracked && !inactive) {
    input.switchAttemptTracker?.clearSession(input.sessionId);
    input.switchCore?.clearSession(input.sessionId);
    return { status: 'session_not_found' };
  }
  const classification = input.classification;
  if (!classification) {
    return await handleConnectedServiceRuntimeAuthFailure({
      sessionId: input.sessionId,
      selection: null,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  const { selection } = resolveConnectedServiceRuntimeAuthRecoverySelection({
    classification,
    environmentVariables: tracked?.spawnOptions?.environmentVariables ?? {},
    trackedConnectedServices: tracked?.spawnOptions?.connectedServices,
    sessionMetadataConnectedServices: tracked?.happySessionMetadataFromLocalWebhook?.connectedServices ?? inactive?.connectedServices,
  });
  if (!selection || !isGroupRuntimeRecoverySelection(selection)) {
    if (!input.switchCoordinator) {
      return await handleConnectedServiceRuntimeAuthFailure({
        sessionId: input.sessionId,
        selection,
        classification,
        switchesThisTurn: input.switchesThisTurn,
        switchCoordinator: unavailableSwitchCoordinator,
        temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
      });
    }
    return await handleConnectedServiceRuntimeAuthFailure({
      sessionId: input.sessionId,
      selection,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  const activeProfileId = selection.activeProfileId
    || classification.profileId
    || selection.fallbackProfileId
    || '';
  const observedProfileId = classification.profileId || activeProfileId || null;
  const activeGroupId = selection.groupId;

  if (classification.kind === 'temporary_throttle') {
    return await handleConnectedServiceRuntimeAuthFailure({
      sessionId: input.sessionId,
      selection: {
        kind: 'group',
        serviceId: selection.serviceId,
        groupId: activeGroupId,
        activeProfileId,
      },
      classification: {
        ...classification,
        groupId: classification.groupId ?? activeGroupId,
        profileId: observedProfileId,
      },
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  // Incident 2026-06-12 (cmq8y3nlx): a scheduler replay of a persisted intent whose failing
  // profile the live session no longer runs must be SUPERSEDED before any recovery work runs
  // (no credential refresh, no switch pipeline). Replaying the pipeline burned the per-session
  // switch budget and thrashed the shared group generation on every retry even after the live
  // restart was suppressed. In-band reports (daemon_report) are fresh evidence and unaffected;
  // a session still running the failing profile (spawned active == failing) is unaffected.
  if (
    input.recoveryInvocationSource === 'scheduler_retry'
    && isRuntimeFailureForInactiveProfile({ selection, classification })
  ) {
    return {
      status: 'recovery_superseded',
      reason: 'failing_profile_inactive',
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      failingProfileId: normalizeNullableProfileId(classification.profileId),
      activeProfileId: normalizeNullableProfileId(selection.activeProfileId),
    };
  }

  if (requiresProfileReconnectWithoutGroupSwitch(classification)) {
    return reconnectProfileAction({
      serviceId: selection.serviceId,
      profileId: observedProfileId,
      groupId: activeGroupId,
      reason: classification.kind,
    });
  }

  if (
    isActiveProfileRefreshRuntimeFailure(classification)
    && input.refreshConnectedServiceCredentialForRuntimeAuthFailure
    && activeProfileId
  ) {
    if (hasPendingProviderProofForRuntimeAuthIdentity({
      runtimeAuthRecovery: input.runtimeAuthRecovery ?? null,
      sessionId: input.sessionId,
      serviceId: selection.serviceId,
      groupId: activeGroupId,
      profileId: observedProfileId,
    })) {
      return reconnectProfileAction({
        serviceId: selection.serviceId,
        profileId: observedProfileId,
        groupId: activeGroupId,
        reason: classification.kind,
      });
    }

    const refresh = await input.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: selection.serviceId,
      profileId: activeProfileId,
      sessionId: input.sessionId,
    });
    if (refresh.status !== 'refreshed') {
      return reconnectProfileAction({
        serviceId: selection.serviceId,
        profileId: observedProfileId,
        groupId: activeGroupId,
        reason: classification.kind,
      });
    }
    await continueAfterRuntimeCredentialRefresh({
      tracked,
      sessionId: input.sessionId,
      serviceId: selection.serviceId,
      groupId: activeGroupId,
      profileId: activeProfileId,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
    return {
      status: 'credential_refreshed',
      serviceId: selection.serviceId,
      profileId: activeProfileId,
      groupId: activeGroupId,
      refresh,
      restartRequested: false,
    };
  }

  if (!input.switchCoordinator) {
    return {
      status: 'switch_coordinator_unavailable',
      blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
    };
  }

  const switchCoordinator = input.switchCoordinator;
  const switchCore = input.switchCore ?? defaultSwitchCore;
  const result = await switchCore.run({
    sessionId: input.sessionId,
    reason: 'automatic_runtime_failure',
    execute: async () => {
      const effectiveSwitchesThisTurn = input.switchAttemptTracker?.resolveSwitchesThisTurn({
        sessionId: input.sessionId,
        serviceId: selection.serviceId,
        groupId: selection.groupId,
        reportedSwitchesThisTurn: input.switchesThisTurn,
      }) ?? input.switchesThisTurn;
      const sessionSwitchesThisHour = input.switchAttemptTracker?.countRecordedSwitchesInWindow({
        sessionId: input.sessionId,
        serviceId: selection.serviceId,
        groupId: selection.groupId,
        windowMs: SESSION_SWITCH_LIMIT_WINDOW_MS,
      });

      return await handleConnectedServiceRuntimeAuthFailure({
        sessionId: input.sessionId,
        selection: {
          kind: 'group',
          serviceId: selection.serviceId,
          groupId: activeGroupId,
          activeProfileId,
        },
        classification: {
          ...classification,
          groupId: classification.groupId ?? activeGroupId,
          profileId: observedProfileId,
        },
        switchesThisTurn: effectiveSwitchesThisTurn,
        sessionSwitchesThisHour,
        switchCoordinator,
        temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
      });
    },
  });
  if (result.status === 'switch_attempted') {
    input.switchAttemptTracker?.recordSwitchResult({
      sessionId: input.sessionId,
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      resultStatus: result.result.status,
    });
    if (!shouldCoalescePendingProofTargetReplay({
      runtimeAuthRecovery: input.runtimeAuthRecovery ?? null,
      sessionId: input.sessionId,
      selection,
      result: result.result,
    })) {
      // A failure attributed to a profile the live session is NOT running must never
      // RESTART the healthy session — the committed switch applies on the next natural
      // spawn (incident 2026-06-12, cmq8y3nlx). Observed-generation continuations stay
      // unguarded: they re-continue the session's own interrupted turn on an
      // already-applied generation, they never kill the runner.
      if (!isRuntimeFailureForInactiveProfile({ selection, classification })) {
        await maybeRestartAfterRuntimeGroupSwitch({
          tracked,
          result: result.result,
          restartSession: input.restartSession ?? null,
        });
      }
      await maybeContinueAfterObservedRuntimeGeneration({
        tracked,
        sessionId: input.sessionId,
        serviceId: selection.serviceId,
        groupId: activeGroupId,
        result: result.result,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
      });
    }
  }
  return result;
}
