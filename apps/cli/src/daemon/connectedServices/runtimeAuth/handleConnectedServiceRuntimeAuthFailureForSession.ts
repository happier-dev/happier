import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '@/agent/catalog/types';
import {
  ConnectedServiceIdSchema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupSwitchResult,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import type {
  ConnectedServiceCredentialRefreshResult,
  ConnectedServiceRuntimeAuthCredentialRefreshResult,
} from '../refresh/ConnectedServiceRefreshCoordinator';
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

type SwitchCoordinatorLike = Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator'];
type TemporaryThrottleRecoveryLike = NonNullable<
  Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['temporaryThrottleRecovery']
>;
type SwitchAttemptTrackerLike = Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  'resolveSwitchesThisTurn' | 'recordSwitchResult' | 'countRecordedSwitchesInWindow' | 'clearSession'
>;
type RuntimeAuthSwitchContinuation = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
}>) => Promise<void> | void;
type RuntimeAuthSupersedingGenerationSettlement = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  fromProfileId: string | null;
  result: Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'superseded_after_apply' }>>;
}>) => Promise<void>;
type RuntimeAuthCredentialRefresh = (input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  sessionId: string;
}>) => Promise<ConnectedServiceRuntimeAuthCredentialRefreshResult>;
type RuntimeAuthRecoveryInvocationSource = 'daemon_report' | 'scheduler_retry';
type InactiveRuntimeAuthSession = Readonly<{
  agentId?: string | null;
  connectedServices: ConnectedServiceBindingsV1;
  connectedServiceMaterializationIdentityV1?: unknown;
  vendorResumeId?: string | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
}>;
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
type RegisteredRuntimeAuthFailureSourceBindingResolver = RuntimeAuthFailureSourceBindingResolver;
type ProviderQualifiedRuntimeAuthFailureSourceResolver = (input: Readonly<{
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification;
}>) => Promise<ConnectedServiceRuntimeFailureClassification>;

function runtimeAuthFailureSourceBindingMatchesReport(
  binding: RuntimeAuthFailureSourceBinding,
  classification: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return binding.serviceId === classification.serviceId
    && binding.groupId === classification.groupId
    && binding.profileId === classification.profileId
    && (
      classification.expectedCredentialRevision === null
      || classification.expectedCredentialRevision === undefined
      || binding.credentialRevision === classification.expectedCredentialRevision
    );
}

function runtimeAuthFailureSourceBindingsEqual(
  left: RuntimeAuthFailureSourceBinding,
  right: RuntimeAuthFailureSourceBinding,
): boolean {
  return left.serviceId === right.serviceId
    && left.groupId === right.groupId
    && left.profileId === right.profileId
    && left.generation === right.generation
    && left.credentialRevision === right.credentialRevision;
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
  reason: 'source_tuple_unavailable' | 'source_tuple_mismatch';
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
}>;

export type RuntimeAuthFailureSourceAuthorization =
  | Readonly<{
      status: 'authorized';
      tracked: TrackedSession | null;
      inactive: InactiveRuntimeAuthSession | null;
      /** Exact live binding, when source authorization had to re-read the runtime. */
      sourceBinding?: RuntimeAuthFailureSourceBinding;
    }>
  | RuntimeAuthRecoverySuperseded
  | Readonly<{ status: 'session_not_found' }>;

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
    expectedCredentialRevision:
      binding.credentialRevision as ConnectedServiceRuntimeFailureClassification['expectedCredentialRevision'],
  };
}

export async function authorizeConnectedServiceRuntimeAuthFailureSource(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  resolveInactiveSession?: (input: Readonly<{ sessionId: string }>) => Promise<InactiveRuntimeAuthSession | null>;
  resolveRegisteredRuntimeAuthFailureSource?: RegisteredRuntimeAuthFailureSourceBindingResolver | null;
  resolveCurrentRuntimeAuthFailureSource?: RuntimeAuthFailureSourceBindingResolver | null;
  resolveProviderQualifiedRuntimeAuthFailureSource?: ProviderQualifiedRuntimeAuthFailureSourceResolver | null;
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  runtimeAuthApplyCapability?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): Promise<RuntimeAuthFailureSourceAuthorization> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  const inactive = tracked ? null : await input.resolveInactiveSession?.({ sessionId: input.sessionId }) ?? null;
  if (!tracked && !inactive) return { status: 'session_not_found' };
  let classification = input.classification;
  let providerQualifiedSourceBinding: RuntimeAuthFailureSourceBinding | null = null;
  if (
    classification?.sourceProviderAccountId
    && input.resolveProviderQualifiedRuntimeAuthFailureSource
  ) {
    const resolvedClassification = await input.resolveProviderQualifiedRuntimeAuthFailureSource({
      sessionId: input.sessionId,
      classification,
    });
    if (
      resolvedClassification.serviceId === classification.serviceId
      && resolvedClassification.groupId === classification.groupId
      && resolvedClassification.profileId
      && resolvedClassification.profileId !== classification.profileId
    ) {
      providerQualifiedSourceBinding = {
        serviceId: resolvedClassification.serviceId as ConnectedServiceId,
        groupId: resolvedClassification.groupId,
        profileId: resolvedClassification.profileId,
        generation: resolvedClassification.groupGeneration ?? null,
        credentialRevision: resolvedClassification.expectedCredentialRevision ?? null,
      };
    }
    classification = resolvedClassification;
  }
  const directLiveHotAuth = input.runtimeAuthApplyCapability?.directLiveHotAuth;
  const requiresExactRuntimeIdentity = typeof directLiveHotAuth === 'object'
    && directLiveHotAuth.requiresExactRuntimeIdentity === true;
  const completeReportedBinding = classification !== null
    && classification.groupId !== null
    && classification.profileId !== null
    && classification.groupGeneration !== null
    && classification.groupGeneration !== undefined;
  // A complete modern report identifies the credential actually used by the provider
  // operation. Hot apply can make that identity newer than immutable spawn metadata.
  // Reattached/untracked and quota reports additionally require exact current authority.
  const requiresCurrentSource = requiresExactRuntimeIdentity
    && classification !== null
    && classification.groupId !== null
    && (
      completeReportedBinding
      || classification.recoveryAction?.kind === 'quota_recovery_required'
      || tracked?.reattachedFromDiskMarker === true
      || !tracked
    );
  if (!requiresCurrentSource) {
    return providerQualifiedSourceBinding
      ? { status: 'authorized', tracked, inactive, sourceBinding: providerQualifiedSourceBinding }
      : { status: 'authorized', tracked, inactive };
  }
  if (classification === null) {
    return { status: 'authorized', tracked, inactive };
  }
  const serviceId = ConnectedServiceIdSchema.safeParse(classification.serviceId);
  if (!serviceId.success) {
    return {
      status: 'recovery_superseded',
      reason: 'source_tuple_unavailable',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    };
  }
  if (!completeReportedBinding || !tracked) {
    return { status: 'recovery_superseded', reason: 'source_tuple_unavailable', serviceId: classification.serviceId, groupId: classification.groupId, profileId: classification.profileId };
  }
  // The runtime registry is the canonical association between this tracked process
  // and its current hot-applied binding. Immutable spawn state is not consulted,
  // and the provider RPC is not a second mandatory source of modern truth.
  const registeredBinding = input.resolveRegisteredRuntimeAuthFailureSource
    ? await input.resolveRegisteredRuntimeAuthFailureSource({
        sessionId: input.sessionId,
        tracked,
        classification,
      })
    : null;
  if (!registeredBinding || registeredBinding.credentialRevision === null) {
    if (input.resolveRegisteredRuntimeAuthFailureSource) {
      throw new Error('connected-service registered runtime binding unavailable');
    }
    return { status: 'recovery_superseded', reason: 'source_tuple_unavailable', serviceId: classification.serviceId, groupId: classification.groupId, profileId: classification.profileId };
  }
  const reportCarriesRevision = classification.expectedCredentialRevision !== null
    && classification.expectedCredentialRevision !== undefined;
  const registeredBindingMatchesReport = runtimeAuthFailureSourceBindingMatchesReport(
    registeredBinding,
    classification,
  );
  // A newer registered generation is current truth, not target replacement by itself.
  // The old report remains actionful when its service/group/profile/revision still match,
  // unless an available provider-qualified current fact disproves stale registry truth.
  if (reportCarriesRevision && registeredBindingMatchesReport) {
    if (!input.resolveCurrentRuntimeAuthFailureSource) {
      return { status: 'authorized', tracked, inactive, sourceBinding: registeredBinding };
    }
    let exactCurrentBinding: RuntimeAuthFailureSourceBinding | null = null;
    try {
      exactCurrentBinding = await input.resolveCurrentRuntimeAuthFailureSource({
        sessionId: input.sessionId,
        tracked,
        classification,
      });
    } catch {
      // The exact runtime registry remains sufficient current authority when the
      // confirmatory provider read is unavailable and agrees with the report.
      return { status: 'authorized', tracked, inactive, sourceBinding: registeredBinding };
    }
    if (!exactCurrentBinding || exactCurrentBinding.credentialRevision === null) {
      return { status: 'authorized', tracked, inactive, sourceBinding: registeredBinding };
    }
    return runtimeAuthFailureSourceBindingMatchesReport(exactCurrentBinding, classification)
      ? { status: 'authorized', tracked, inactive, sourceBinding: exactCurrentBinding }
      : { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: classification.serviceId, groupId: classification.groupId, profileId: classification.profileId };
  }

  const reportClaimsUnsettledNewerGroupGeneration =
    registeredBinding.serviceId === classification.serviceId
    && registeredBinding.groupId === classification.groupId
    && registeredBinding.generation !== null
    && classification.groupGeneration !== null
    && classification.groupGeneration !== undefined
    && classification.groupGeneration > registeredBinding.generation;
  if (reportCarriesRevision && reportClaimsUnsettledNewerGroupGeneration) {
    // The registry is the last exact recipient settlement. A newer logical/runtime identity may
    // describe an attempted application that never acknowledged. Keep the settled failure source
    // so the generic coordinator observes/reapplies current group truth instead of penalizing the
    // unacknowledged target.
    return { status: 'authorized', tracked, inactive, sourceBinding: registeredBinding };
  }

  // A provider-qualified exact current fact may repair stale bootstrap registry truth.
  // The provider reader returns a fact; this generic owner alone classifies report A/current B.
  const currentBinding = input.resolveCurrentRuntimeAuthFailureSource
    ? await input.resolveCurrentRuntimeAuthFailureSource({
        sessionId: input.sessionId,
        tracked,
        classification,
      })
    : null;
  if (!currentBinding || currentBinding.credentialRevision === null) {
    return { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: classification.serviceId, groupId: classification.groupId, profileId: classification.profileId };
  }

  if (reportCarriesRevision) {
    return runtimeAuthFailureSourceBindingMatchesReport(currentBinding, classification)
      ? { status: 'authorized', tracked, inactive, sourceBinding: currentBinding }
      : { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: classification.serviceId, groupId: classification.groupId, profileId: classification.profileId };
  }

  // Revision-free predecessor reports still require provider-owned compatibility
  // evidence and may adopt the current generation after exact same-identity proof.
  if (
    !registeredBindingMatchesReport
    || !runtimeAuthFailureSourceBindingsEqual(currentBinding, registeredBinding)
  ) {
    return { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: classification.serviceId, groupId: classification.groupId, profileId: classification.profileId };
  }
  return { status: 'authorized', tracked, inactive, sourceBinding: currentBinding };
}

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

async function maybeContinueAfterRuntimeGroupGeneration(input: Readonly<{
  tracked: TrackedSession | null;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  failedProfileId: string | null;
  failedCredentialRevision: string | null;
  result: ConnectedServiceAuthGroupSwitchResult;
  supersedingGenerationSettled?: boolean;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.tracked) return;
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const observedUsableReplacement = input.result.status === 'observed_generation'
    && (
      normalizeNullableProfileId(input.result.activeProfileId) !== input.failedProfileId
      || (
        input.result.credentialRevision !== null
        && input.result.credentialRevision !== undefined
        && input.failedCredentialRevision !== null
        && input.result.credentialRevision !== input.failedCredentialRevision
      )
    );
  if (!observedUsableReplacement
    && !(input.result.status === 'superseded_after_apply' && input.supersedingGenerationSettled === true)) return;
  const activeProfileId = normalizeSessionId(input.result.activeProfileId);
  if (!activeProfileId) return;

  const normalizedBindings = {
    v: 1,
    bindingsByServiceId: {
      [input.serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
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
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          [input.serviceId]: {
            source: 'connected',
            selection: 'group',
            groupId: input.groupId,
            profileId: activeProfileId,
          },
        },
      },
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
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          [input.serviceId]: {
            source: 'connected',
            selection: 'group',
            groupId: input.groupId,
            profileId: input.profileId,
          },
        },
      },
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
  resolveRegisteredRuntimeAuthFailureSource?: RegisteredRuntimeAuthFailureSourceBindingResolver | null;
  resolveCurrentRuntimeAuthFailureSource?: RuntimeAuthFailureSourceBindingResolver | null;
  resolveProviderQualifiedRuntimeAuthFailureSource?: ProviderQualifiedRuntimeAuthFailureSourceResolver | null;
  switchCoordinator: SwitchCoordinatorLike | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  switchCore?: ConnectedServiceSessionAuthSwitchCore | null;
  emitSessionEvent?: (sessionId: string, event: unknown) => void | Promise<void>;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  settleSupersedingRuntimeGroupGeneration?: RuntimeAuthSupersedingGenerationSettlement | null;
  refreshConnectedServiceCredentialForRuntimeAuthFailure?: RuntimeAuthCredentialRefresh | null;
  sessionId: string;
  switchesThisTurn: number;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
  runtimeAuthApplyCapability?: ConnectedServiceRuntimeAuthApplyCapability | null;
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
  const sourceAuthorization = input.sourceAuthorization ?? await authorizeConnectedServiceRuntimeAuthFailureSource({
    ...input,
    runtimeAuthApplyCapability: input.runtimeAuthApplyCapability ?? null,
  });
  if (sourceAuthorization.status !== 'authorized') {
    if (sourceAuthorization.status === 'session_not_found') {
      input.switchAttemptTracker?.clearSession(input.sessionId);
      input.switchCore?.clearSession(input.sessionId);
    }
    return sourceAuthorization;
  }
  const { tracked, inactive } = sourceAuthorization;
  if (!tracked && !inactive) {
    input.switchAttemptTracker?.clearSession(input.sessionId);
    input.switchCore?.clearSession(input.sessionId);
    return { status: 'session_not_found' };
  }
  const classification = input.classification
    ? applyAuthorizedRuntimeAuthFailureSourceBinding(input.classification, sourceAuthorization)
    : null;
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

  const resolvedRecoverySelection = resolveConnectedServiceRuntimeAuthRecoverySelection({
    classification,
    environmentVariables: tracked?.spawnOptions?.environmentVariables ?? {},
    trackedConnectedServices: tracked?.spawnOptions?.connectedServices,
    sessionMetadataConnectedServices: tracked?.happySessionMetadataFromLocalWebhook?.connectedServices ?? inactive?.connectedServices,
  }).selection;
  // Exact source authorization is the single owner of a reattached runtime's current
  // binding. Do not let its stale launch descriptor win again while constructing the
  // recovery selection.
  const selection: RuntimeRecoverySelection | null = sourceAuthorization.sourceBinding?.groupId
    ? {
        kind: 'group',
        serviceId: sourceAuthorization.sourceBinding.serviceId,
        groupId: sourceAuthorization.sourceBinding.groupId,
        activeProfileId: sourceAuthorization.sourceBinding.profileId,
        fallbackProfileId: normalizeNullableProfileId(classification.profileId) ?? undefined,
      }
    : resolvedRecoverySelection;
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

  let activeCredentialRefreshFailed = false;
  if (
    isActiveProfileRefreshRuntimeFailure(classification)
    && input.refreshConnectedServiceCredentialForRuntimeAuthFailure
    && activeProfileId
  ) {
    const refresh = await input.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: selection.serviceId,
      profileId: activeProfileId,
      sessionId: input.sessionId,
    });
    if (refresh.runtimeAuthDisposition === 'superseded_by_current_group') {
      // The refresh was real, but canonical group truth already moved this session to another
      // member. Let the existing group-generation consumer adopt that truth; do not report the
      // stale member as recovered or create a second continuation/restart path.
    } else if (refresh.status === 'refreshed') {
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
    } else {
      activeCredentialRefreshFailed = true;
    }
  }

  if (!input.switchCoordinator) {
    if (activeCredentialRefreshFailed) {
      return reconnectProfileAction({
        serviceId: selection.serviceId,
        profileId: observedProfileId,
        groupId: activeGroupId,
        reason: classification.kind,
      });
    }
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
        profileId: observedProfileId,
        credentialRevision: classification.expectedCredentialRevision ?? null,
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
  if (
    activeCredentialRefreshFailed
    && result.status === 'switch_attempted'
    && (
      result.result.status === 'no_eligible_member'
      || result.result.status === 'manual_strategy'
      || result.result.status === 'auto_switch_disabled'
      || result.result.status === 'switch_reason_disabled'
      || result.result.status === 'switch_limit_reached'
    )
  ) {
    return reconnectProfileAction({
      serviceId: selection.serviceId,
      profileId: observedProfileId,
      groupId: activeGroupId,
      reason: classification.kind,
    });
  }
  if (result.status === 'switch_attempted') {
    input.switchAttemptTracker?.recordSwitchResult({
      sessionId: input.sessionId,
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      profileId: observedProfileId,
      credentialRevision: classification.expectedCredentialRevision ?? null,
      resultStatus: result.result.status,
    });
    let supersedingGenerationSettled = false;
    if (
      result.result.status === 'superseded_after_apply'
      && input.settleSupersedingRuntimeGroupGeneration
    ) {
      await input.settleSupersedingRuntimeGroupGeneration({
        sessionId: input.sessionId,
        serviceId: selection.serviceId,
        groupId: activeGroupId,
        fromProfileId: normalizeNullableProfileId(observedProfileId),
        result: result.result,
      });
      supersedingGenerationSettled = true;
    }
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
    await maybeContinueAfterRuntimeGroupGeneration({
      tracked,
      sessionId: input.sessionId,
      serviceId: selection.serviceId,
      groupId: activeGroupId,
      failedProfileId: normalizeNullableProfileId(observedProfileId),
      failedCredentialRevision: classification.expectedCredentialRevision ?? null,
      result: result.result,
      supersedingGenerationSettled,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
  }
  return result;
}
