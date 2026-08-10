import type { TrackedSession } from '@/daemon/types';
import {
  ConnectedServiceIdSchema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceCredentialRefreshResult,
  ConnectedServiceRuntimeAuthCredentialRefreshResult,
} from '../refresh/ConnectedServiceRefreshCoordinator';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../accountTransitions/acceptedConnectedServiceAccountVerification';

import {
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupSwitchResult,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import {
  createConnectedServiceSessionAuthSwitchCore,
  type ConnectedServiceSessionAuthSwitchReason,
  type ConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';
import { buildConnectedServiceSwitchContinuationAttemptId } from '../sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';
import {
  isGroupRuntimeRecoverySelection,
  resolveConnectedServiceRuntimeAuthRecoverySelection,
  type RuntimeRecoverySelection,
} from './resolveConnectedServiceRuntimeAuthRecoverySelection';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '../credentials/lifecycleTypes';

type SwitchCoordinatorLike = Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator'];
type SwitchAfterClassifiedFailureInput = Parameters<SwitchCoordinatorLike['switchAfterClassifiedFailure']>[0];
type TemporaryThrottleRecoveryLike = NonNullable<
  Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['temporaryThrottleRecovery']
>;
type SwitchAttemptTrackerLike = Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  | 'resolveSwitchesThisTurn'
  | 'recordSwitchResult'
  | 'countRecordedSwitchesInWindow'
  | 'hasFreshCredentialRefreshAttempt'
  | 'recordCredentialRefreshAttempt'
  | 'clearSession'
> & Partial<Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  | 'hasFreshSuccessfulCredentialRefreshAttempt'
  | 'recordCredentialRefreshSuccess'
>>;

type RuntimeCredentialRefreshService = Readonly<{
  refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sessionId: string;
  }>): Promise<ConnectedServiceRuntimeAuthCredentialRefreshResult>;
}>;

type RuntimeAuthSwitchContinuation = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  target?: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
  }>;
}>) => Promise<void> | void;

type RuntimeAuthSupersedingGenerationSettlement = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  fromProfileId: string | null;
  result: Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'superseded_after_apply' }>>;
}>) => Promise<void>;

type RuntimeAuthRecoverySuccessObserver = (input: Readonly<{
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
  status: 'switched' | 'observed_generation' | 'credential_refreshed';
  generation: number | null;
  // Provider-outcome proof carriers. The observer is a LOCAL-substep notification;
  // consumers MUST gate clearing recovery on these (post-switch account-adoption
  // verification, or a genuinely fresh candidate). A bare status is never proof.
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId | null;
  fromProfileId?: string | null;
}>) => Promise<void> | void;

type RuntimeAuthRecoveryDurableSessionResolver = (input: Readonly<{
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification;
}>) => Promise<TrackedSession | null> | TrackedSession | null;

type RuntimeAuthFailureSourceBinding = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  generation: number | null;
  credentialRevision: string | null;
}>;

type RuntimeAuthFailureSourceBindingResolver = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  classification: ConnectedServiceRuntimeFailureClassification;
}>) => Promise<RuntimeAuthFailureSourceBinding | null>;

type RegisteredRuntimeAuthFailureSourceBindingResolver = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  classification: ConnectedServiceRuntimeFailureClassification;
}>) => RuntimeAuthFailureSourceBinding | null;

type RuntimeAuthRestartFailureObserver = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  source: 'group_switch';
  error: unknown;
  groupSwitchResult?: ConnectedServiceAuthGroupSwitchResult;
}>) => Promise<void> | void;

type RuntimeAuthRestartCompletion =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: unknown }>;

type RuntimeAuthRecoveryActionRequired = Readonly<{
  status: 'recovery_action_required';
  action: Readonly<{
    kind: 'reconnect_profile' | 're_resolve_binding';
    serviceId: string;
    profileId: string;
    groupId: string | null;
    reason: ConnectedServiceRuntimeFailureClassification['kind'];
  }>;
}>;

type RuntimeAuthRecoveryInvocationSource = 'daemon_report' | 'scheduler_retry';

export type RuntimeAuthFailureSourceAuthorization =
  | Readonly<{
      status: 'authorized';
      tracked: TrackedSession | null;
      /** Exact live binding, when source authorization had to re-read the runtime. */
      sourceBinding?: RuntimeAuthFailureSourceBinding;
    }>
  | RuntimeAuthRecoverySuperseded;

export function applyAuthorizedRuntimeAuthFailureSourceBinding(
  classification: ConnectedServiceRuntimeFailureClassification,
  authorization: RuntimeAuthFailureSourceAuthorization | undefined,
): ConnectedServiceRuntimeFailureClassification {
  if (authorization?.status !== 'authorized' || !authorization.sourceBinding) return classification;
  const binding = authorization.sourceBinding;
  return {
    ...classification,
    serviceId: binding.serviceId,
    groupId: binding.groupId,
    profileId: binding.profileId,
    groupGeneration: binding.generation,
    credentialRevision:
      binding.credentialRevision as ConnectedServiceRuntimeFailureClassification['credentialRevision'],
  };
}

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
}> | Readonly<{
  status: 'recovery_superseded';
  reason: 'credential_revision_changed';
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
  reportedCredentialRevision: string;
  activeCredentialRevision: string | null;
}> | Readonly<{
  status: 'recovery_superseded';
  reason: 'source_tuple_unavailable' | 'source_tuple_mismatch';
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
}>;

type RuntimeAuthCredentialRefreshProviderOutcomeWaiting = Readonly<{
  status: 'credential_refreshed';
  restartRequested: false;
  pendingProviderOutcome: true;
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

export async function authorizeConnectedServiceRuntimeAuthFailureSource(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  resolveDurableSessionForRuntimeAuthRecovery?: RuntimeAuthRecoveryDurableSessionResolver | null;
  resolveRegisteredRuntimeAuthFailureSource?: RegisteredRuntimeAuthFailureSourceBindingResolver | null;
  resolveCurrentRuntimeAuthFailureSource?: RuntimeAuthFailureSourceBindingResolver | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification | null;
}>): Promise<RuntimeAuthFailureSourceAuthorization> {
  const tracked = await resolveRuntimeAuthRecoveryTrackedSession({
    children: input.getChildren(),
    sessionId: input.sessionId,
    classification: input.classification,
    resolveDurableSessionForRuntimeAuthRecovery: input.resolveDurableSessionForRuntimeAuthRecovery ?? null,
  });
  const classification = input.classification;
  const reportedProfileId = typeof classification?.profileId === 'string'
    ? classification.profileId.trim()
    : '';
  const reportedCredentialRevision = typeof classification?.credentialRevision === 'string'
    ? classification.credentialRevision.trim()
    : '';
  const reportedGroupId = typeof classification?.groupId === 'string'
    ? classification.groupId.trim()
    : null;
  const reportedGeneration = typeof classification?.groupGeneration === 'number'
    && Number.isInteger(classification.groupGeneration)
    && classification.groupGeneration >= 0
    ? classification.groupGeneration
    : null;
  const modernExactReport = classification !== null
    && reportedProfileId.length > 0
    && reportedCredentialRevision.length > 0
    && (
      (reportedGroupId !== null && reportedGroupId.length > 0 && reportedGeneration !== null)
      || ((reportedGroupId === null || reportedGroupId.length === 0) && reportedGeneration === null)
    );
  const directLiveHotAuth = input.runtimeAuthApply?.directLiveHotAuth;
  const exactLiveSourceResolverApplicable = typeof directLiveHotAuth === 'object'
    && directLiveHotAuth.requiresExactRuntimeIdentity === true;
  if (modernExactReport) {
    if (!tracked) {
      throw new Error('connected-service exact runtime source session temporarily unavailable');
    }
    const registeredBinding = input.resolveRegisteredRuntimeAuthFailureSource?.({
      sessionId: input.sessionId,
      tracked,
      classification,
    }) ?? null;
    if (!registeredBinding) {
      throw new Error('connected-service exact runtime source binding temporarily unavailable');
    }
    const registeredProfileId = registeredBinding.profileId.trim();
    const registeredCredentialRevision = registeredBinding.credentialRevision?.trim() ?? '';
    const registeredGroupIdRaw = registeredBinding.groupId?.trim() ?? '';
    const registeredGroupId = registeredGroupIdRaw.length > 0 ? registeredGroupIdRaw : null;
    const registeredGeneration = typeof registeredBinding.generation === 'number'
      && Number.isInteger(registeredBinding.generation)
      && registeredBinding.generation >= 0
      ? registeredBinding.generation
      : null;
    const registeredBindingIsExact = registeredProfileId.length > 0
      && registeredCredentialRevision.length > 0
      && (
        (registeredGroupId !== null && registeredGeneration !== null)
        || (registeredGroupId === null && registeredGeneration === null)
      );
    if (!registeredBindingIsExact) {
      throw new Error('connected-service exact runtime source binding temporarily unavailable');
    }
    const exactRegisteredBinding: RuntimeAuthFailureSourceBinding = {
      serviceId: registeredBinding.serviceId,
      groupId: registeredGroupId,
      profileId: registeredProfileId,
      generation: registeredGeneration,
      credentialRevision: registeredCredentialRevision,
    };
    const registeredBindingMatchesReport =
      exactRegisteredBinding.serviceId === classification.serviceId
      && registeredGroupId === (reportedGroupId || null)
      && registeredProfileId === reportedProfileId
      && registeredGeneration === reportedGeneration
      && registeredCredentialRevision === reportedCredentialRevision;
    if (registeredBindingMatchesReport) {
      return { status: 'authorized', tracked, sourceBinding: exactRegisteredBinding };
    }
    const registeredBindingProvesNewerGroupGeneration =
      exactRegisteredBinding.serviceId === classification.serviceId
      && registeredGroupId !== null
      && registeredGroupId === (reportedGroupId || null)
      && registeredGeneration !== null
      && reportedGeneration !== null
      && registeredGeneration > reportedGeneration;
    if (registeredBindingProvesNewerGroupGeneration) {
      const registeredBindingRetainsReportedTarget =
        registeredProfileId === reportedProfileId
        && registeredCredentialRevision === reportedCredentialRevision;
      if (registeredBindingRetainsReportedTarget) {
        return { status: 'authorized', tracked, sourceBinding: exactRegisteredBinding };
      }
      // A complete older report may finish after its own failure already caused a newer exact
      // target to hot-apply. When that current target changed profile or opaque revision, the
      // registry itself authoritatively supersedes the report without an additional live probe.
      // A generation-only advance retains the failure because it still describes the exact
      // current credential.
      return {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: classification.serviceId,
        groupId: classification.groupId,
        profileId: classification.profileId,
      };
    }
    const reportClaimsUnsettledNewerGroupGeneration =
      exactRegisteredBinding.serviceId === classification.serviceId
      && registeredGroupId !== null
      && registeredGroupId === (reportedGroupId || null)
      && registeredGeneration !== null
      && reportedGeneration !== null
      && reportedGeneration > registeredGeneration;
    if (reportClaimsUnsettledNewerGroupGeneration) {
      // The registry is the last exact recipient settlement. A newer runtime identity can describe
      // a requested or partially applied generation whose fan-out never acknowledged. It is not
      // provider-use evidence for the failed request and must not penalize the newer group member.
      // Returning the settled source lets the coordinator observe/reapply authoritative current
      // group truth without performing another selection CAS.
      return { status: 'authorized', tracked, sourceBinding: exactRegisteredBinding };
    }
    if (exactLiveSourceResolverApplicable) {
      if (!input.resolveCurrentRuntimeAuthFailureSource) {
        throw new Error('connected-service exact live runtime source resolver temporarily unavailable');
      }
      const confirmedBinding = await input.resolveCurrentRuntimeAuthFailureSource({
        sessionId: input.sessionId,
        tracked,
        classification,
      });
      if (
        confirmedBinding
        && confirmedBinding.serviceId === classification.serviceId
        && confirmedBinding.groupId === (reportedGroupId || null)
        && confirmedBinding.profileId === reportedProfileId
        && confirmedBinding.credentialRevision === reportedCredentialRevision
      ) {
        return { status: 'authorized', tracked, sourceBinding: confirmedBinding };
      }
    }
    return {
      status: 'recovery_superseded',
      reason: 'source_tuple_mismatch',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    };
  }

  // Only providers whose catalog lifecycle capability requires exact live runtime identity use
  // the narrow predecessor verifier. Other providers retain registry-only compatibility semantics.
  const requiresPredecessorVerification = exactLiveSourceResolverApplicable
    && classification !== null
    && classification.groupId !== null
    && (
      classification.recoveryAction?.kind === 'quota_recovery_required'
      || tracked?.reattachedFromDiskMarker === true
      || !tracked
    );
  if (!requiresPredecessorVerification) return { status: 'authorized', tracked };
  if (!tracked) {
    return {
      status: 'recovery_superseded',
      reason: 'source_tuple_unavailable',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    };
  }
  if (!reportedProfileId || reportedGroupId === null || !reportedGroupId || reportedGeneration === null) {
    return {
      status: 'recovery_superseded',
      reason: 'source_tuple_unavailable',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    };
  }
  // Hot apply changes a running process without mutating its immutable spawn descriptor.
  // Therefore every actionful exact-source report must be authorized against the live runtime,
  // regardless of whether this daemon originally spawned or later reattached the process.
  const resolvedLiveBinding = input.resolveCurrentRuntimeAuthFailureSource
    ? await input.resolveCurrentRuntimeAuthFailureSource({
        sessionId: input.sessionId,
        tracked,
        classification,
      })
    : null;
  const activeTuple = resolvedLiveBinding;
  if (!activeTuple || activeTuple.credentialRevision === null) {
    return {
      status: 'recovery_superseded',
      reason: 'source_tuple_unavailable',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    };
  }
  if (
    activeTuple.serviceId !== classification.serviceId
    || activeTuple.groupId !== classification.groupId
    || activeTuple.profileId !== classification.profileId
    || (
      classification.credentialRevision !== null
      && classification.credentialRevision !== undefined
      && activeTuple.credentialRevision !== classification.credentialRevision
    )
  ) {
    return {
      status: 'recovery_superseded',
      reason: 'source_tuple_mismatch',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    };
  }
  return { status: 'authorized', tracked, sourceBinding: activeTuple };
}

function requestRuntimeAuthRestart(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  source: 'group_switch';
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  onRestartFailure?: RuntimeAuthRestartFailureObserver | null;
  groupSwitchResult?: ConnectedServiceAuthGroupSwitchResult;
}>): Promise<RuntimeAuthRestartCompletion> | null {
  const restartSession = input.restartSession;
  if (!restartSession) return null;
  return Promise.resolve()
    .then(async () => {
      await restartSession(input.tracked);
      return { ok: true } as const;
    })
    .catch(async (error) => {
      await Promise.resolve(input.onRestartFailure?.({
        sessionId: input.sessionId,
        tracked: input.tracked,
        source: input.source,
        error,
        ...(input.groupSwitchResult === undefined ? {} : { groupSwitchResult: input.groupSwitchResult }),
      })).catch(() => {});
      return { ok: false, error } as const;
    });
}

function createCommitOnlySwitchCoordinator(
  switchCoordinator: SwitchCoordinatorLike,
): SwitchCoordinatorLike {
  return {
    switchAfterClassifiedFailure: async (input: SwitchAfterClassifiedFailureInput) => {
      const { sessionId: _liveSessionId, ...commitOnlyInput } = input;
      return await switchCoordinator.switchAfterClassifiedFailure(commitOnlyInput);
    },
  };
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

async function resolveRuntimeAuthRecoveryTrackedSession(input: Readonly<{
  children: ReadonlyArray<TrackedSession>;
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
  resolveDurableSessionForRuntimeAuthRecovery?: RuntimeAuthRecoveryDurableSessionResolver | null;
}>): Promise<TrackedSession | null> {
  const tracked = findTrackedSession(input.children, input.sessionId);
  if (tracked) return tracked;
  if (!input.classification || !input.resolveDurableSessionForRuntimeAuthRecovery) return null;
  const durableTracked = await input.resolveDurableSessionForRuntimeAuthRecovery({
    sessionId: input.sessionId,
    classification: input.classification,
  });
  if (!durableTracked) return null;
  return normalizeSessionId(durableTracked.happySessionId) === normalizeSessionId(input.sessionId)
    ? durableTracked
    : null;
}

function isRuntimeCredentialFailure(classification: ConnectedServiceRuntimeFailureClassification): boolean {
  return classification.kind === 'auth_expired'
    || classification.kind === 'refresh_failed'
    || classification.kind === 'permission_denied';
}

function isReconnectRequiredRefreshResult(result: ConnectedServiceCredentialRefreshResult): boolean {
  const category = result.diagnostic.category;
  return result.status === 'credential_missing'
    || category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function normalizeNullableProfileId(value: unknown): string | null {
  const normalized = normalizeSessionId(value);
  return normalized.length > 0 ? normalized : null;
}

function resolveAuthoritativeRecoveryProfileId(input: Readonly<{
  selection: RuntimeRecoverySelection;
  classifiedProfileId?: string | null;
}>): string {
  if (input.selection.kind === 'group') {
    return normalizeSessionId(
      input.selection.activeProfileId
      ?? input.selection.fallbackProfileId
      ?? input.classifiedProfileId
      ?? '',
    );
  }
  return normalizeSessionId(
    input.selection.profileId
    ?? input.classifiedProfileId
    ?? '',
  );
}

function buildReconnectProfileAfterRepeatedCredentialRefresh(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  selection: RuntimeRecoverySelection;
  profileId: string;
}>): RuntimeAuthRecoveryActionRequired {
  return {
    status: 'recovery_action_required',
    action: {
      kind: 'reconnect_profile',
      serviceId: input.selection.serviceId,
      profileId: input.profileId,
      groupId: input.classification.groupId ?? (
        input.selection.kind === 'group' ? input.selection.groupId : null
      ),
      reason: input.classification.kind,
    },
  };
}

function shouldSwitchAwayAfterRepeatedCredentialRefreshFailure(
  selection: RuntimeRecoverySelection,
): boolean {
  return selection.kind === 'group';
}

async function runRuntimeGroupSwitchRecovery(input: Readonly<{
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
  switchesThisTurn: number;
  switchCoordinator: SwitchCoordinatorLike;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  applyLiveSession?: boolean;
}>): Promise<Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>> {
  const effectiveSwitchesThisTurn = input.switchAttemptTracker?.resolveSwitchesThisTurn({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    profileId: normalizeNullableProfileId(input.classification.profileId),
    credentialRevision: input.classification.credentialRevision ?? null,
    reportedSwitchesThisTurn: input.switchesThisTurn,
  }) ?? input.switchesThisTurn;
  const sessionSwitchesThisHour = input.switchAttemptTracker?.countRecordedSwitchesInWindow({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    windowMs: SESSION_SWITCH_LIMIT_WINDOW_MS,
  });

  return await handleConnectedServiceRuntimeAuthFailure({
    sessionId: input.sessionId,
    selection: {
      kind: 'group',
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId,
      activeProfileId: resolveAuthoritativeRecoveryProfileId({
        selection: input.selection,
        classifiedProfileId: input.classification.profileId,
      }),
    },
    classification: {
      ...input.classification,
      groupId: input.classification.groupId ?? input.selection.groupId,
      profileId: normalizeNullableProfileId(resolveAuthoritativeRecoveryProfileId({
        selection: input.selection,
        classifiedProfileId: input.classification.profileId,
      })),
    },
    switchesThisTurn: effectiveSwitchesThisTurn,
    sessionSwitchesThisHour,
    switchCoordinator: input.applyLiveSession === false
      ? createCommitOnlySwitchCoordinator(input.switchCoordinator)
      : input.switchCoordinator,
    temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
  });
}

function finalizeRuntimeGroupSwitchAttempt(input: Readonly<{
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>;
  failedProfileId: string | null;
  failedCredentialRevision: string | null;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
}>): void {
  if (input.result.status !== 'switch_attempted') return;
  input.switchAttemptTracker?.recordSwitchResult({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    profileId: input.failedProfileId,
    credentialRevision: input.failedCredentialRevision,
    resultStatus: input.result.result.status,
  });
}

function maybeRestartAfterRuntimeGroupSwitch(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  result: ConnectedServiceAuthGroupSwitchResult;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  onRestartFailure?: RuntimeAuthRestartFailureObserver | null;
}>): Promise<RuntimeAuthRestartCompletion> | null {
  if (input.result.status !== 'switched') return null;
  if (input.result.mode !== 'spawn_next_turn') return null;
  return requestRuntimeAuthRestart({
    sessionId: input.sessionId,
    tracked: input.tracked,
    source: 'group_switch',
    restartSession: input.restartSession ?? null,
    onRestartFailure: input.onRestartFailure ?? null,
    groupSwitchResult: input.result,
  });
}

function doesRuntimeGroupSwitchProveUsableReplacement(
  result: ConnectedServiceAuthGroupSwitchResult,
): boolean {
  return result.status === 'switched'
    || result.status === 'observed_generation'
    || result.status === 'superseded_after_apply';
}

function resolveRuntimeGroupSwitchContinuationContext(
  result: ConnectedServiceAuthGroupSwitchResult,
  supersedingGenerationSettled = false,
): Readonly<{
  action: 'hot_applied' | 'restart_requested';
  activeProfileId: string | null;
  generation: number;
}> | null {
  if (result.status === 'superseded_after_apply' && supersedingGenerationSettled) {
    return { action: 'hot_applied', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  if (result.status === 'observed_generation') {
    return { action: 'hot_applied', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  if (result.status !== 'switched') return null;
  if (result.mode === 'hot_apply') {
    return { action: 'hot_applied', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  // A failure-driven `spawn_next_turn` switch requests a restart inside the live authorized
  // operation. Preserve that interruption classification so the thin continuation producer can
  // enqueue the configured prompt after replacement; it never reconstructs the original input or
  // gives daemon startup replay authority.
  if (result.mode === 'spawn_next_turn') {
    return { action: 'restart_requested', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  return null;
}

async function maybeContinueAfterRuntimeGroupSwitch(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: ConnectedServiceAuthGroupSwitchResult;
  supersedingGenerationSettled?: boolean;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const continuationContext = resolveRuntimeGroupSwitchContinuationContext(
    input.result,
    input.supersedingGenerationSettled === true,
  );
  if (!continuationContext) return;
  const { action } = continuationContext;
  const activeProfileId = normalizeSessionId(continuationContext.activeProfileId);
  if (!activeProfileId) return;

  const serviceId = input.selection.serviceId as ConnectedServiceId;
  const normalizedBindings = {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.selection.groupId,
        profileId: activeProfileId,
      },
    },
  } satisfies ConnectedServiceBindingsV1;
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action,
      serviceIds,
      normalizedBindings,
      expectedGroupGenerationByServiceId: {
        [serviceId]: continuationContext.generation,
      },
    }),
    normalizedBindings,
    serviceIds,
    action,
    switchReason: 'automatic_runtime_failure',
    target: {
      serviceId,
      groupId: input.selection.groupId,
      profileId: activeProfileId,
      generation: continuationContext.generation,
    },
  });
}

// A recovery driven by a failure attributed to a profile the live session is NOT
// running (e.g. a persisted stale rate-limit intent replayed by the scheduler) must
// never restart or steer the live session: the session is healthy on another group
// member, and the committed switch applies on the next natural spawn. Incident
// 2026-06-12 (cmq8y3nlx): a stale intent for an inactive profile restarted a healthy
// mid-work session on every scheduler retry, churning accounts for ~30 minutes.
function isRuntimeFailureForInactiveProfile(input: Readonly<{
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
}>): boolean {
  const failingProfileId = normalizeNullableProfileId(input.classification.profileId);
  const liveActiveProfileId = normalizeNullableProfileId(input.selection.activeProfileId);
  return Boolean(failingProfileId && liveActiveProfileId && failingProfileId !== liveActiveProfileId);
}

function hasExitedChildProcess(tracked: TrackedSession): boolean {
  const childProcess = tracked.childProcess;
  if (!childProcess) return false;
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function requestCredentialRefreshRelaunch(input: Readonly<{
  tracked: TrackedSession;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
}>): boolean {
  if (!hasExitedChildProcess(input.tracked)) return false;
  const restartSession = input.restartSession;
  if (!restartSession) return false;
  void Promise.resolve(restartSession(input.tracked)).catch(() => {});
  return true;
}

async function maybeContinueAfterCredentialRefresh(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  selection: RuntimeRecoverySelection;
  profileId: string;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const serviceId = input.selection.serviceId as ConnectedServiceId;
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);
  const normalizedBindings: ConnectedServiceBindingsV1 = {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: input.selection.kind === 'group'
        ? {
            source: 'connected',
            selection: 'group',
            groupId: input.selection.groupId,
            profileId: input.profileId,
          }
        : {
            source: 'connected',
            selection: 'profile',
            profileId: input.profileId,
          },
    },
  };

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

async function maybeRefreshCredentialBeforeRuntimeRecovery(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  classification: ConnectedServiceRuntimeFailureClassification;
  selection: RuntimeRecoverySelection;
  recoveryInvocationSource: RuntimeAuthRecoveryInvocationSource;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  credentialRefreshService?: RuntimeCredentialRefreshService | null;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
}>): Promise<
  | null
  | Readonly<{
      status: 'credential_refreshed';
      result: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | RuntimeAuthRecoveryActionRequired
  | RuntimeAuthCredentialRefreshProviderOutcomeWaiting
> {
  if (!input.credentialRefreshService || !isRuntimeCredentialFailure(input.classification)) return null;
  const profileId = resolveAuthoritativeRecoveryProfileId({
    selection: input.selection,
    classifiedProfileId: input.classification.profileId,
  });
  if (!profileId) return null;
  const serviceId = ConnectedServiceIdSchema.safeParse(input.selection.serviceId);
  if (!serviceId.success) return null;

  const attempt = {
    sessionId: input.sessionId,
    serviceId: serviceId.data,
    profileId,
    credentialRevision: input.classification.credentialRevision ?? null,
    reason: input.classification.kind,
  };
  if (input.switchAttemptTracker?.hasFreshSuccessfulCredentialRefreshAttempt?.(attempt)) {
    if (input.recoveryInvocationSource === 'scheduler_retry') {
      return {
        status: 'credential_refreshed',
        restartRequested: false,
        pendingProviderOutcome: true,
      };
    }
    if (shouldSwitchAwayAfterRepeatedCredentialRefreshFailure(input.selection)) {
      return null;
    }
    return buildReconnectProfileAfterRepeatedCredentialRefresh({
      classification: input.classification,
      selection: input.selection,
      profileId,
    });
  }
  if (input.switchAttemptTracker?.hasFreshCredentialRefreshAttempt(attempt)) return null;
  input.switchAttemptTracker?.recordCredentialRefreshAttempt(attempt);

  const result = await input.credentialRefreshService.refreshConnectedServiceCredentialForRuntimeAuthFailure({
    serviceId: serviceId.data,
    profileId,
    sessionId: input.sessionId,
  });
  if (result.runtimeAuthDisposition === 'superseded_by_current_group') {
    return null;
  }
  if (result.status === 'refreshed') {
    input.switchAttemptTracker?.recordCredentialRefreshSuccess?.(attempt);
    await input.onRuntimeAuthRecoverySuccess?.({
      sessionId: input.sessionId,
      serviceId: input.selection.serviceId,
      groupId: input.classification.groupId,
      profileId,
      status: 'credential_refreshed',
      generation: null,
    });
    const restartRequested = requestCredentialRefreshRelaunch({
      tracked: input.tracked,
      restartSession: input.restartSession ?? null,
    });
    if (restartRequested) {
      return {
        status: 'credential_refreshed',
        result,
        restartRequested: true,
      };
    }
    await maybeContinueAfterCredentialRefresh({
      tracked: input.tracked,
      sessionId: input.sessionId,
      selection: input.selection,
      profileId,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
    return {
      status: 'credential_refreshed',
      result,
      restartRequested: false,
    };
  }
  if (result.status === 'refresh_failed' && !isReconnectRequiredRefreshResult(result)) {
    return null;
  }
  return buildReconnectProfileAfterRepeatedCredentialRefresh({
    classification: input.classification,
    selection: input.selection,
    profileId,
  });
}

async function notifyRuntimeGroupSwitchRecoverySuccess(input: Readonly<{
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>;
}>): Promise<void> {
  if (input.result.status !== 'switch_attempted') return;
  if (input.result.result.status !== 'switched' && input.result.result.status !== 'observed_generation') return;
  // Surface the post-switch account-adoption verification (when present) so the
  // daemon's reactive proof gate can clear recovery on verified adoption. A bare
  // switched/observed_generation status without verification is NOT proof.
  const verificationByServiceId = input.result.result.verificationByServiceId ?? null;
  await input.onRuntimeAuthRecoverySuccess?.({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    profileId: input.result.result.activeProfileId,
    status: input.result.result.status,
    generation: input.result.result.generation,
    ...(verificationByServiceId ? { verificationByServiceId } : {}),
  });
}

export async function handleConnectedServiceRuntimeAuthFailureForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  switchCoordinator: SwitchCoordinatorLike | null;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  switchCore?: ConnectedServiceSessionAuthSwitchCore | null;
  resolveDurableSessionForRuntimeAuthRecovery?: RuntimeAuthRecoveryDurableSessionResolver | null;
  resolveRegisteredRuntimeAuthFailureSource?: RegisteredRuntimeAuthFailureSourceBindingResolver | null;
  resolveCurrentRuntimeAuthFailureSource?: RuntimeAuthFailureSourceBindingResolver | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  credentialRefreshService?: RuntimeCredentialRefreshService | null;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  settleSupersedingRuntimeGroupGeneration?: RuntimeAuthSupersedingGenerationSettlement | null;
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  onRuntimeAuthRestartFailure?: RuntimeAuthRestartFailureObserver | null;
  sessionId: string;
  switchesThisTurn: number;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
}>): Promise<
  | Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>
  | Readonly<{
      status: 'credential_refreshed';
      result: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | RuntimeAuthCredentialRefreshProviderOutcomeWaiting
  | RuntimeAuthRecoverySuperseded
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{
      status: 'switch_coordinator_unavailable';
      blocker: 'CLI has no connected-service auth-group load/commit API in this branch.';
    }>
> {
  const sourceAuthorization = input.sourceAuthorization ?? await authorizeConnectedServiceRuntimeAuthFailureSource(input);
  if (sourceAuthorization.status !== 'authorized') return sourceAuthorization;
  const tracked = sourceAuthorization.tracked;
  const classification = input.classification
    ? applyAuthorizedRuntimeAuthFailureSourceBinding(input.classification, sourceAuthorization)
    : null;
  if (!tracked) {
    const { selection } = classification
      ? resolveConnectedServiceRuntimeAuthRecoverySelection({
        classification,
        environmentVariables: {},
      })
      : { selection: null };
    if (classification && selection && isGroupRuntimeRecoverySelection(selection)) {
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
        execute: async () => await runRuntimeGroupSwitchRecovery({
          sessionId: input.sessionId,
          selection,
          classification,
          switchesThisTurn: input.switchesThisTurn,
          switchCoordinator,
          switchAttemptTracker: input.switchAttemptTracker ?? null,
          temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
          applyLiveSession: false,
        }),
      });
      finalizeRuntimeGroupSwitchAttempt({
        sessionId: input.sessionId,
        selection,
        result,
        failedProfileId: normalizeNullableProfileId(classification.profileId),
        failedCredentialRevision: classification.credentialRevision ?? null,
        switchAttemptTracker: input.switchAttemptTracker ?? null,
      });
      await notifyRuntimeGroupSwitchRecoverySuccess({
        onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
        sessionId: input.sessionId,
        selection,
        result,
      });
      return result;
    }
    input.switchAttemptTracker?.clearSession(input.sessionId);
    input.switchCore?.clearSession(input.sessionId);
    return { status: 'session_not_found' };
  }
  if (!classification) {
    return await handleConnectedServiceRuntimeAuthFailure({
      selection: null,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  const resolvedRecoverySelection = resolveConnectedServiceRuntimeAuthRecoverySelection({
    classification,
    environmentVariables: tracked.spawnOptions?.environmentVariables ?? {},
    trackedConnectedServices: tracked.spawnOptions?.connectedServices,
    sessionMetadataConnectedServices: tracked.happySessionMetadataFromLocalWebhook?.connectedServices,
  }).selection;
  // Exact source authorization is the single owner of a reattached runtime's current
  // binding. Do not let its stale launch descriptor win again while constructing the
  // recovery selection.
  const selection: RuntimeRecoverySelection | null = sourceAuthorization.sourceBinding
    ? sourceAuthorization.sourceBinding.groupId
      ? {
          kind: 'group',
          serviceId: sourceAuthorization.sourceBinding.serviceId,
          groupId: sourceAuthorization.sourceBinding.groupId,
          activeProfileId: sourceAuthorization.sourceBinding.profileId,
          fallbackProfileId: normalizeNullableProfileId(classification.profileId) ?? undefined,
        }
      : {
          kind: 'profile',
          serviceId: sourceAuthorization.sourceBinding.serviceId,
          profileId: sourceAuthorization.sourceBinding.profileId,
        }
    : resolvedRecoverySelection;
  if (!selection) {
    return await handleConnectedServiceRuntimeAuthFailure({
      sessionId: input.sessionId,
      selection,
      classification,
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
    && isGroupRuntimeRecoverySelection(selection)
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

  let groupRefreshReconnectAction: RuntimeAuthRecoveryActionRequired | null = null;
  const switchCore = input.switchCore ?? defaultSwitchCore;
  const result = await switchCore.run({
    sessionId: input.sessionId,
    reason: 'automatic_runtime_failure',
    execute: async () => {
      const refreshed = await maybeRefreshCredentialBeforeRuntimeRecovery({
        sessionId: input.sessionId,
        tracked,
        classification,
        selection,
        recoveryInvocationSource: input.recoveryInvocationSource ?? 'daemon_report',
        switchAttemptTracker: input.switchAttemptTracker ?? null,
        credentialRefreshService: input.credentialRefreshService ?? null,
        restartSession: input.restartSession ?? null,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
        onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
      });
      if (refreshed) {
        if (
          refreshed.status === 'recovery_action_required'
          && isGroupRuntimeRecoverySelection(selection)
        ) {
          // A group may still recover by selecting another member. Preserve the
          // reconnect action as the truthful fallback if no replacement commits.
          groupRefreshReconnectAction = refreshed;
        } else {
          return refreshed;
        }
      }

      if (!isGroupRuntimeRecoverySelection(selection)) {
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
      const groupSelection = selection;

      if (!input.switchCoordinator) {
        return groupRefreshReconnectAction ?? {
          status: 'switch_coordinator_unavailable',
          blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
        } as const;
      }

      const switchCoordinator = input.switchCoordinator;
      return await runRuntimeGroupSwitchRecovery({
        sessionId: input.sessionId,
        selection: groupSelection,
        classification,
        switchesThisTurn: input.switchesThisTurn,
        switchCoordinator,
        switchAttemptTracker: input.switchAttemptTracker ?? null,
        temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
      });
    },
  });
  if (
    groupRefreshReconnectAction
    && result.status === 'switch_attempted'
    && !doesRuntimeGroupSwitchProveUsableReplacement(result.result)
  ) {
    return groupRefreshReconnectAction;
  }
  if (result.status === 'switch_attempted' && isGroupRuntimeRecoverySelection(selection)) {
    finalizeRuntimeGroupSwitchAttempt({
      sessionId: input.sessionId,
      selection,
      result,
      failedProfileId: normalizeNullableProfileId(classification.profileId),
      failedCredentialRevision: classification.credentialRevision ?? null,
      switchAttemptTracker: input.switchAttemptTracker ?? null,
    });
    let supersedingGenerationSettled = false;
    if (
      result.result.status === 'superseded_after_apply'
      && input.settleSupersedingRuntimeGroupGeneration
    ) {
      await input.settleSupersedingRuntimeGroupGeneration({
        sessionId: input.sessionId,
        serviceId: selection.serviceId as ConnectedServiceId,
        groupId: selection.groupId,
        fromProfileId: normalizeNullableProfileId(classification.profileId),
        result: result.result,
      });
      supersedingGenerationSettled = true;
    }
    await notifyRuntimeGroupSwitchRecoverySuccess({
      onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
      sessionId: input.sessionId,
      selection,
      result,
    });
    const runtimeFailureForInactiveProfile = isRuntimeFailureForInactiveProfile({ selection, classification });
    const restartRequired = !runtimeFailureForInactiveProfile
      && result.result.status === 'switched'
      && result.result.mode === 'spawn_next_turn';
    const restartCompletion = restartRequired
      ? maybeRestartAfterRuntimeGroupSwitch({
        sessionId: input.sessionId,
        tracked,
        result: result.result,
        restartSession: input.restartSession ?? null,
        onRestartFailure: input.onRuntimeAuthRestartFailure ?? null,
      })
      : null;
    // A restart-required continuation must not become a `send_now` Pending row until the
    // restart callback proves the predecessor retired. Without a continuation, retain the
    // existing non-blocking recovery response while the restart proceeds independently.
    if (restartRequired && input.continueAfterRuntimeAuthSwitch) {
      if (!restartCompletion) {
        throw Object.assign(
          new Error('connected_service_restart_unavailable'),
          { code: 'connected_service_restart_unavailable', retryable: true },
        );
      }
      const completion = await restartCompletion;
      if (!completion.ok) {
        throw completion.error;
      }
    }
    // The inactive-profile veto above is a lifecycle safety rule for restart.
    // Scheduler retries for an inactive failing profile already returned as
    // `failing_profile_inactive` before entering the switch pipeline. A fresh
    // in-band origin that joins an already-applied generation still owns its
    // ordinary continuation and must not be suppressed by that restart guard.
    await maybeContinueAfterRuntimeGroupSwitch({
      tracked,
      sessionId: input.sessionId,
      selection,
      result: result.result,
      supersedingGenerationSettled,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
  }
  return result;
}
