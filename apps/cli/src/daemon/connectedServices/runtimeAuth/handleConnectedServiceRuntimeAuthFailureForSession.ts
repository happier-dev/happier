import type { TrackedSession } from '@/daemon/types';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedAccountServiceKey, ConnectedServiceBindingsV2 } from '@happier-dev/protocol';

import {
  type ConnectedServiceAuthGroupSwitchCoordinator,
  type ConnectedServiceAuthGroupSwitchResult,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure, applyConnectedServiceRuntimeAuthFailureSourceBinding, prepareConnectedServiceRuntimeCredentialRecovery } from './handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { decideConnectedServiceRecovery, isConnectedServiceAccountRecoveryApplicable } from './ConnectedServiceRecoveryPolicy';
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
import { resolveFailedSwitchAttemptEventProjection } from '../sessionAuthSwitch/events/resolveFailedSwitchAttemptEventProjection';
import {
  isGroupRuntimeRecoverySelection,
  resolveConnectedServiceRuntimeAuthRecoverySelection,
  type RuntimeRecoverySelection,
} from './resolveConnectedServiceRuntimeAuthRecoverySelection';

import type { ConnectedServiceProviderAdoptedGenerationTarget } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

type SwitchCoordinatorLike = NonNullable<Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator']>
  & Partial<Pick<ConnectedServiceAuthGroupSwitchCoordinator, 'observeCurrentGenerationForRecovery'>>;
type TemporaryThrottleRecoveryLike = NonNullable<
  Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['temporaryThrottleRecovery']
>;
type RuntimeAuthSwitchContinuation = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV2;
  serviceIds: ReadonlySet<ConnectedAccountServiceKey>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
}>) => Promise<void> | void;
type RuntimeAuthSupersedingGenerationSettlement = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  fromProfileId: string | null;
  result: Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'superseded_after_apply' | 'observed_generation' }>>;
}>) => Promise<ConnectedServiceProviderAdoptedGenerationTarget>;
type RuntimeAuthCredentialRefresh = (input: Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  sessionId: string;
}>) => Promise<ConnectedServiceRuntimeAuthCredentialRefreshResult>;
type RuntimeAuthRecoveryInvocationSource = 'daemon_report' | 'scheduler_retry';
type InactiveRuntimeAuthSession = Readonly<{
  agentId?: string | null;
  connectedServices: ConnectedServiceBindingsV2;
  connectedServiceMaterializationIdentityV1?: unknown;
  vendorResumeId?: string | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
}>;
type RuntimeAuthFailureSourceBinding = Readonly<{
  serviceId: ConnectedAccountServiceKey;
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
  | Readonly<{ status: 'not_applicable'; reason: 'no_connected_service_binding' }>
  | Readonly<{
      status: 'authorized';
      tracked: TrackedSession | null;
      inactive: InactiveRuntimeAuthSession | null;
      /** Exact live binding, when source authorization had to re-read the runtime. */
      sourceBinding?: RuntimeAuthFailureSourceBinding;
      /** Current binding authorizes pool routing, not attribution of the failed turn. */
      sourceAttribution?: 'unattributed';
    }>
  | Readonly<{
      status: 'current_credential_revision';
      tracked: TrackedSession;
      inactive: null;
      sourceBinding: RuntimeAuthFailureSourceBinding;
    }>
  | (Extract<RuntimeAuthRecoverySuperseded, Readonly<{
      reason: 'source_tuple_unavailable' | 'source_tuple_mismatch';
    }>> & Readonly<{
      adoptedTarget: Readonly<{
        tracked: TrackedSession;
        sourceBinding: RuntimeAuthFailureSourceBinding & Readonly<{
          groupId: string;
          generation: number;
        }>;
      }>;
    }>)
  | RuntimeAuthRecoverySuperseded
  | Readonly<{ status: 'session_not_found' }>;

export function applyAuthorizedRuntimeAuthFailureSourceBinding(
  classification: ConnectedServiceRuntimeFailureClassification,
  authorization: RuntimeAuthFailureSourceAuthorization | undefined,
): ConnectedServiceRuntimeFailureClassification {
  if (authorization?.status !== 'authorized' || !authorization.sourceBinding) return classification;
  const binding = authorization.sourceBinding;
  if (authorization.sourceAttribution === 'unattributed') {
    return { ...classification, serviceId: binding.serviceId, groupId: binding.groupId,
      profileId: null, groupGeneration: null, expectedCredentialRevision: null };
  }
  if (classification.profileId === binding.profileId && classification.groupId === binding.groupId
    && (classification.expectedCredentialRevision || classification.providerReportedOrganizationId !== undefined)) {
    // Current authority routes recovery; it cannot replace the issued credential tuple.
    return classification;
  }
  return applyConnectedServiceRuntimeAuthFailureSourceBinding(classification, {
    ...binding, credentialRevision: binding.credentialRevision as ConnectedServiceRuntimeFailureClassification['expectedCredentialRevision'],
  });
}

export async function authorizeConnectedServiceRuntimeAuthFailureSource(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  resolveInactiveSession?: (input: Readonly<{ sessionId: string }>) => Promise<InactiveRuntimeAuthSession | null>;
  resolveRegisteredRuntimeAuthFailureSource?: RegisteredRuntimeAuthFailureSourceBindingResolver | null;
  resolveCurrentRuntimeAuthFailureSource?: RuntimeAuthFailureSourceBindingResolver | null;
  resolveProviderQualifiedRuntimeAuthFailureSource?: ProviderQualifiedRuntimeAuthFailureSourceResolver | null;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification | null;
}>): Promise<RuntimeAuthFailureSourceAuthorization> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  const inactive = tracked ? null : await input.resolveInactiveSession?.({ sessionId: input.sessionId }) ?? null;
  if (!tracked && !inactive) return { status: 'session_not_found' };
  let classification = input.classification;
  let providerQualifiedSourceBinding: RuntimeAuthFailureSourceBinding | null = null;
  if (
    (classification?.sourceProviderAccountId || classification?.providerReportedOrganizationId !== undefined)
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
        serviceId: resolvedClassification.serviceId,
        groupId: resolvedClassification.groupId,
        profileId: resolvedClassification.profileId,
        generation: resolvedClassification.groupGeneration ?? null,
        credentialRevision: resolvedClassification.expectedCredentialRevision ?? null,
      };
    }
    classification = resolvedClassification;
    if (!classification.profileId && classification.providerReportedOrganizationId === undefined) {
      return { status: 'recovery_superseded', reason: 'source_tuple_unavailable',
        serviceId: classification.serviceId, groupId: classification.groupId, profileId: null };
    }
  }
  if (providerQualifiedSourceBinding) {
    return {
      status: 'authorized',
      tracked,
      inactive,
      sourceBinding: providerQualifiedSourceBinding,
    };
  }
  if (classification && !classification.profileId
    && decideConnectedServiceRecovery({ actor: 'automatic', issue: classification, selection: null }).action !== 'temporary_retry') {
    if (!tracked) return { status: 'recovery_superseded', reason: 'source_tuple_unavailable',
      serviceId: classification.serviceId, groupId: classification.groupId, profileId: null };
    const binding = await input.resolveRegisteredRuntimeAuthFailureSource?.({ sessionId: input.sessionId, tracked, classification });
    if (findTrackedSession(input.getChildren(), input.sessionId)?.pid !== tracked.pid) {
      return { status: 'session_not_found' };
    }
    if (binding?.serviceId === classification.serviceId && binding.groupId
      && (!classification.groupId || classification.groupId === binding.groupId)) {
      return { status: 'authorized', tracked, inactive, sourceBinding: binding, sourceAttribution: 'unattributed' };
    }
    const selection = resolveConnectedServiceRuntimeAuthRecoverySelection({ classification,
      environmentVariables: tracked.spawnOptions?.environmentVariables,
      trackedConnectedServices: tracked.spawnOptions?.connectedServices,
      sessionMetadataConnectedServices: tracked.happySessionMetadataFromLocalWebhook?.connectedServices,
    }).selection;
    if (!binding && !selection && !classification.groupId) {
      return { status: 'not_applicable', reason: 'no_connected_service_binding' };
    }
    return { status: 'recovery_superseded', reason: 'source_tuple_unavailable',
      serviceId: classification.serviceId, groupId: classification.groupId, profileId: null };
  }
  const completeReportedBinding = classification !== null
    && classification.groupId !== null
    && classification.profileId !== null
    && classification.groupGeneration !== null
    && classification.groupGeneration !== undefined;
  // Fresh native evidence without credential attribution is qualified by the
  // current registered process. A scheduler replay retains its failed source.
  if (classification && tracked && input.recoveryInvocationSource !== 'scheduler_retry'
    && classification.profileId === null && classification.groupId === null
    && classification.groupGeneration == null && classification.expectedCredentialRevision == null) {
    const binding = await input.resolveRegisteredRuntimeAuthFailureSource?.({ sessionId: input.sessionId, tracked, classification });
    if (binding && binding.serviceId === classification.serviceId && binding.credentialRevision !== null
      && (binding.groupId === null || binding.generation !== null)
      && findTrackedSession(input.getChildren(), input.sessionId) === tracked) {
      return { status: 'authorized', tracked, inactive, sourceBinding: binding };
    }
    return { status: 'recovery_superseded', reason: 'source_tuple_unavailable', serviceId: classification.serviceId,
      groupId: classification.groupId, profileId: classification.profileId };
  }
  // A complete modern report identifies the credential actually used by the provider
  // operation. Hot apply can make that identity newer than immutable spawn metadata.
  // Reattached/untracked and quota reports additionally require exact current authority.
  const requiresCurrentSource = classification !== null
    && classification.groupId !== null
    && (
      completeReportedBinding
      || classification.recoveryAction?.kind === 'quota_recovery_required'
      || tracked?.reattachedFromDiskMarker === true
      || !tracked
    );
  if (!requiresCurrentSource) {
    // Predecessor reports can omit generation/revision. Attribute them at the same
    // registry admission as modern reports; stale launch selections cannot turn an
    // old member's failure into a new failure of its healthy replacement.
    if (classification?.profileId && tracked && input.resolveRegisteredRuntimeAuthFailureSource) {
      const binding = await input.resolveRegisteredRuntimeAuthFailureSource({ sessionId: input.sessionId, tracked, classification });
      if (findTrackedSession(input.getChildren(), input.sessionId)?.pid !== tracked.pid) return { status: 'session_not_found' };
      if (binding?.serviceId === classification.serviceId && binding.groupId !== null
        && (classification.groupId === null || binding.groupId === classification.groupId)
        && binding.generation !== null && binding.credentialRevision !== null) {
        if (binding.profileId !== classification.profileId) {
          return { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: classification.serviceId,
            groupId: classification.groupId, profileId: classification.profileId,
            adoptedTarget: { tracked, sourceBinding: { ...binding, groupId: binding.groupId, generation: binding.generation } } };
        }
        return { status: 'authorized', tracked, inactive, sourceBinding: binding };
      }
    }
    return { status: 'authorized', tracked, inactive };
  }
  if (classification === null) {
    return { status: 'authorized', tracked, inactive };
  }
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(classification.serviceId);
  if (!serviceId) {
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

  const registeredBindingProvesNewerGroupTarget =
    reportCarriesRevision
    && registeredBinding.serviceId === classification.serviceId
    && registeredBinding.groupId !== null
    && registeredBinding.groupId === classification.groupId
    && registeredBinding.generation !== null
    && classification.groupGeneration !== null
    && classification.groupGeneration !== undefined
    && registeredBinding.generation > classification.groupGeneration
    && (
      registeredBinding.profileId !== classification.profileId
      || registeredBinding.credentialRevision !== classification.expectedCredentialRevision
    );
  if (registeredBindingProvesNewerGroupTarget
    && !(input.recoveryInvocationSource === 'scheduler_retry' && registeredBinding.profileId === classification.profileId)) {
    // The report still belongs to the old credential, so it must not penalize or rotate the
    // replacement. A newer registered target proves supersession, not interrupted-work
    // custody. Only the scheduler's admitted recovery can continue on that target.
    const supersededResult = {
      status: 'recovery_superseded',
      reason: 'source_tuple_mismatch',
      serviceId: classification.serviceId,
      groupId: classification.groupId,
      profileId: classification.profileId,
    } as const;
    return {
      ...supersededResult,
      adoptedTarget: {
        tracked,
        sourceBinding: {
          ...registeredBinding,
          groupId: registeredBinding.groupId,
          generation: registeredBinding.generation,
        },
      },
    };
  }

  const scheduledRecoveryTargetsCurrentCredential =
    input.recoveryInvocationSource === 'scheduler_retry'
    && registeredBinding.serviceId === classification.serviceId
    && registeredBinding.groupId === classification.groupId
    && registeredBinding.profileId === classification.profileId
    && registeredBinding.credentialRevision !== classification.expectedCredentialRevision
    && registeredBinding.generation !== null
    && classification.groupGeneration !== null
    && classification.groupGeneration !== undefined
    && registeredBinding.generation >= classification.groupGeneration;
  if (reportCarriesRevision && scheduledRecoveryTargetsCurrentCredential) {
    // A persisted retry describes the failure that armed it, not a fresh failure from the
    // credential now installed on the same runtime target. Continue on that exact current
    // target and wait for provider proof; never re-attribute the old failure to the new
    // revision or select another account. Fresh daemon reports remain exact and fail closed.
    return {
      status: 'current_credential_revision',
      tracked,
      inactive: null,
      sourceBinding: registeredBinding,
    };
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

  if (currentBinding.serviceId === classification.serviceId && currentBinding.groupId === classification.groupId
    && currentBinding.groupId !== null && currentBinding.generation !== null
    && classification.groupGeneration != null && currentBinding.generation > classification.groupGeneration
    && currentBinding.profileId !== classification.profileId
    && runtimeAuthFailureSourceBindingsEqual(currentBinding, registeredBinding)) {
    return { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: classification.serviceId,
      groupId: classification.groupId, profileId: classification.profileId,
      adoptedTarget: { tracked, sourceBinding: { ...currentBinding, groupId: currentBinding.groupId, generation: currentBinding.generation } } };
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
    serviceId: ConnectedAccountServiceKey;
    profileId: string | null;
    groupId: string | null;
    reason: ConnectedServiceRuntimeFailureClassification['kind'];
  }>;
}>;
type RuntimeCredentialRefreshed =
  | Readonly<{
      status: 'credential_refreshed';
      serviceId: ConnectedAccountServiceKey;
      profileId: string;
      groupId: string | null;
      refresh: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | Readonly<{
      status: 'credential_refreshed';
      serviceId: ConnectedAccountServiceKey;
      profileId: string;
      groupId: string;
      restartRequested: false;
      pendingProviderOutcome: true;
      activeProfileId: string;
      generation: number;
      credentialRevision: string;
    }>;

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

async function emitRuntimeGroupSwitchApplyFailureEvent(input: Readonly<{
  emitSessionEvent?: ((sessionId: string, event: unknown) => void | Promise<void>) | null;
  sessionId: string;
  reason: ConnectedServiceRuntimeFailureClassification['kind'];
  result: ConnectedServiceAuthGroupSwitchResult;
}>): Promise<void> {
  if (input.result.status !== 'generation_apply_failed' || !input.emitSessionEvent) return;
  const projection = resolveFailedSwitchAttemptEventProjection({
    errorCode: input.result.errorCode,
    ...(input.result.errorCode.startsWith('hot_apply_')
      ? { attemptedAction: 'hot_applied' as const }
      : {}),
  });
  if (!projection) return;
  await input.emitSessionEvent(input.sessionId, {
    type: 'connected_service_account_switch_attempt',
    ok: false,
    action: projection.action,
    reason: input.reason,
    attemptedContinuityMode: projection.attemptedContinuityMode,
    outcome: projection.outcome,
    outcomeAction: projection.outcomeAction,
    errorCode: input.result.errorCode,
    groupGeneration: input.result.generation,
    partialState: null,
  });
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

function hasUsableQuotaRecovery(result: ConnectedServiceAuthGroupSwitchResult): boolean {
  if (result.status !== 'observed_generation') return false;
  const recovery = result.quotaRecovery;
  if (!recovery || recovery.receipt?.status === 'unknown_after_timeout') return false;
  const remainingPercent = recovery.quotaSnapshot.effectiveRemainingPercent;
  return typeof remainingPercent === 'number' && Number.isFinite(remainingPercent) && remainingPercent > 0
    && Number.isFinite(recovery.quotaSnapshot.capturedAtMs);
}

async function maybeContinueAfterRuntimeGroupGeneration(input: Readonly<{
  tracked: TrackedSession | null;
  sessionId: string;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  failedProfileId: string | null;
  failedCredentialRevision: string | null;
  result: ConnectedServiceAuthGroupSwitchResult;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.tracked) return;
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const observedUsableReplacement = input.result.status === 'observed_generation'
    && (
      hasUsableQuotaRecovery(input.result)
      || normalizeNullableProfileId(input.result.activeProfileId) !== input.failedProfileId
      || (
        input.result.credentialRevision !== null
        && input.result.credentialRevision !== undefined
        && input.failedCredentialRevision !== null
        && input.result.credentialRevision !== input.failedCredentialRevision
      )
    );
  const switched = input.result.status === 'switched';
  if (!observedUsableReplacement && !switched) return;
  const activeProfileId = normalizeSessionId(input.result.activeProfileId);
  if (!activeProfileId) return;

  const normalizedBindings = {
    v: 2,
    bindingsByServiceId: {
      [input.serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
      },
    },
  } satisfies ConnectedServiceBindingsV2;
  const serviceIds = new Set<ConnectedAccountServiceKey>([input.serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'hot_applied',
      serviceIds,
      normalizedBindings: {
        v: 2,
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
    action: switched && input.result.mode === 'spawn_next_turn' ? 'restart_requested' : 'hot_applied',
    switchReason: 'automatic_runtime_failure',
  });
}

async function continueAfterRuntimeAuthTargetAdoption(input: Readonly<{
  tracked: TrackedSession | null;
  sessionId: string;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  profileId: string;
  generation?: number | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.tracked) return;
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const normalizedBindings = {
    v: 2,
    bindingsByServiceId: {
      [input.serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
      },
    },
  } satisfies ConnectedServiceBindingsV2;
  const serviceIds = new Set<ConnectedAccountServiceKey>([input.serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'hot_applied',
      serviceIds,
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          [input.serviceId]: {
            source: 'connected',
            selection: 'group',
            groupId: input.groupId,
            profileId: input.profileId,
          },
        },
      },
      ...(typeof input.generation === 'number'
        ? { expectedGroupGenerationByServiceId: { [input.serviceId]: input.generation } }
        : {}),
    }),
    normalizedBindings,
    serviceIds,
    action: 'hot_applied',
    switchReason: 'automatic_runtime_failure',
  });
}

function requiresProfileReconnectWithoutGroupSwitch(
  classification: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return classification.kind === 'account_changed';
}

function reconnectProfileAction(input: Readonly<{
  serviceId: ConnectedAccountServiceKey;
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

function settledRuntimeGroupRecoveryResult(
  result: Parameters<RuntimeAuthSupersedingGenerationSettlement>[0]['result'],
  adopted: ConnectedServiceProviderAdoptedGenerationTarget,
): Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'observed_generation' }> {
  return { status: 'observed_generation', activeProfileId: adopted.profileId,
    generation: adopted.generation, credentialRevision: adopted.credentialRevision,
    ...(result.status === 'observed_generation' && result.activeProfileId === adopted.profileId
      && result.generation === adopted.generation && (result.credentialRevision ?? null) === adopted.credentialRevision
      && result.quotaRecovery ? { quotaRecovery: result.quotaRecovery } : {}) };
}

async function continueRuntimeAuthRecoveryOnCurrentGroup(input: Readonly<{
  tracked: TrackedSession | null;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, { kind: 'group' }>;
  classification: ConnectedServiceRuntimeFailureClassification;
  switchCoordinator: SwitchCoordinatorLike | null;
  authorizedSource?: RuntimeAuthFailureSourceBinding | null;
  settleSupersedingRuntimeGroupGeneration?: RuntimeAuthSupersedingGenerationSettlement | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<Readonly<{ status: 'switch_attempted'; result: ConnectedServiceAuthGroupSwitchResult }>
  | Readonly<{ status: 'switch_coordinator_unavailable'; blocker: 'CLI has no connected-service auth-group load/commit API in this branch.' }>> {
  if (!input.switchCoordinator?.observeCurrentGenerationForRecovery) {
    return { status: 'switch_coordinator_unavailable', blocker: 'CLI has no connected-service auth-group load/commit API in this branch.' };
  }
  let result = await input.switchCoordinator.observeCurrentGenerationForRecovery({
    serviceId: input.selection.serviceId, groupId: input.selection.groupId,
    observedProfileId: normalizeNullableProfileId(input.classification.profileId),
    ...(input.classification.quotaScope === 'model'
      ? { modelId: input.classification.providerLimitId } : {}),
    // Provider capacity/throttle is not evidence against the failed account.
    ...((input.classification.kind === 'capacity' || input.classification.kind === 'temporary_throttle')
      && input.classification.quotaScope === 'provider' ? {} : { failure: {
        reason: input.classification.kind, retryAfterMs: input.classification.retryAfterMs,
        resetsAtMs: input.classification.resetsAtMs, limitCategory: input.classification.limitCategory,
        quotaScope: input.classification.quotaScope, providerLimitId: input.classification.providerLimitId,
        planType: input.classification.planType,
      } }),
  });
  if (result.status === 'observed_generation') {
    const source = input.authorizedSource;
    const adopted = source?.serviceId === input.selection.serviceId && source.groupId === input.selection.groupId
      && source.profileId === result.activeProfileId && source.generation === result.generation
      && source.credentialRevision === (result.credentialRevision ?? null);
    if (!adopted) {
      if (!input.settleSupersedingRuntimeGroupGeneration) {
        const code = 'connected_service_runtime_auth_current_generation_not_settled';
        throw Object.assign(new Error(code), { code, retryable: true });
      }
      const settled = await input.settleSupersedingRuntimeGroupGeneration({ sessionId: input.sessionId,
        serviceId: input.selection.serviceId, groupId: input.selection.groupId,
        fromProfileId: source?.profileId ?? input.selection.activeProfileId ?? null, result });
      result = settledRuntimeGroupRecoveryResult(result, settled);
    }
  }
  await maybeContinueAfterRuntimeGroupGeneration({ ...input, serviceId: input.selection.serviceId, groupId: input.selection.groupId,
    result, failedProfileId: normalizeNullableProfileId(input.classification.profileId),
    failedCredentialRevision: input.classification.expectedCredentialRevision ?? null });
  return { status: 'switch_attempted', result };
}

// Predecessor reports without a proven runtime binding still use the existing launch-selection
// protection. Remove this compatibility fallback when their source owner supplies exact bindings.
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
    connectedServices: ConnectedServiceBindingsV2;
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
  switchCore?: ConnectedServiceSessionAuthSwitchCore | null;
  emitSessionEvent?: (sessionId: string, event: unknown) => void | Promise<void>;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  settleSupersedingRuntimeGroupGeneration?: RuntimeAuthSupersedingGenerationSettlement | null;
  refreshConnectedServiceCredentialForRuntimeAuthFailure?: RuntimeAuthCredentialRefresh | null;
  sessionId: string;
  switchesThisTurn?: number;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
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
  | Readonly<{ status: 'not_applicable'; reason: 'no_connected_service_binding' }>
> {
  if (input.classification && !isConnectedServiceAccountRecoveryApplicable(input.classification)) {
    return { status: 'not_classified' };
  }
  const sourceAuthorization = input.sourceAuthorization ?? await authorizeConnectedServiceRuntimeAuthFailureSource({
    ...input,
  });
  if (sourceAuthorization.status === 'recovery_superseded' && 'adoptedTarget' in sourceAuthorization) {
    const sourceBinding = sourceAuthorization.adoptedTarget.sourceBinding;
    if (input.classification && input.recoveryInvocationSource === 'scheduler_retry') {
      return await continueRuntimeAuthRecoveryOnCurrentGroup({
        tracked: sourceAuthorization.adoptedTarget.tracked, sessionId: input.sessionId,
        selection: { kind: 'group', serviceId: sourceBinding.serviceId, groupId: sourceBinding.groupId,
          activeProfileId: sourceBinding.profileId, fallbackProfileId: sourceBinding.profileId },
        classification: input.classification, switchCoordinator: input.switchCoordinator, authorizedSource: sourceBinding,
        settleSupersedingRuntimeGroupGeneration: input.settleSupersedingRuntimeGroupGeneration,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
      });
    }
    const { adoptedTarget: _adoptedTarget, ...supersededResult } = sourceAuthorization;
    return supersededResult;
  }
  if (sourceAuthorization.status === 'current_credential_revision') {
    const sourceBinding = sourceAuthorization.sourceBinding;
    if (
      sourceBinding.groupId === null
      || sourceBinding.generation === null
      || sourceBinding.credentialRevision === null
    ) {
      return {
        status: 'recovery_superseded',
        reason: 'source_tuple_unavailable',
        serviceId: sourceBinding.serviceId,
        groupId: sourceBinding.groupId,
        profileId: sourceBinding.profileId,
      };
    }
    await continueAfterRuntimeAuthTargetAdoption({
      tracked: sourceAuthorization.tracked,
      sessionId: input.sessionId,
      serviceId: sourceBinding.serviceId,
      groupId: sourceBinding.groupId,
      profileId: sourceBinding.profileId,
      generation: sourceBinding.generation,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
    return {
      status: 'credential_refreshed',
      serviceId: sourceBinding.serviceId,
      profileId: sourceBinding.profileId,
      groupId: sourceBinding.groupId,
      restartRequested: false,
      pendingProviderOutcome: true,
      activeProfileId: sourceBinding.profileId,
      generation: sourceBinding.generation,
      credentialRevision: sourceBinding.credentialRevision,
    };
  }
  if (sourceAuthorization.status !== 'authorized') {
    if (sourceAuthorization.status === 'session_not_found') {
      input.switchCore?.clearSession(input.sessionId);
    }
    return sourceAuthorization;
  }
  const { tracked, inactive } = sourceAuthorization;
  if (!tracked && !inactive) {
    input.switchCore?.clearSession(input.sessionId);
    return { status: 'session_not_found' };
  }
  const classification = input.classification
    ? applyAuthorizedRuntimeAuthFailureSourceBinding(input.classification, sourceAuthorization)
    : null;
  if (!classification) {
    return await handleConnectedServiceRuntimeAuthFailure({
      scope: { kind: 'session', sessionId: input.sessionId },
      sessionId: input.sessionId,
      selection: null,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator,
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
    return await handleConnectedServiceRuntimeAuthFailure({
      scope: { kind: 'session', sessionId: input.sessionId },
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
  const observedProfileId = classification.profileId;
  const activeGroupId = selection.groupId;

  if (classification.kind === 'temporary_throttle') {
    return await handleConnectedServiceRuntimeAuthFailure({
      scope: { kind: 'session', sessionId: input.sessionId },
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
      switchCoordinator: input.switchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  if (!sourceAuthorization.sourceBinding && input.recoveryInvocationSource === 'scheduler_retry'
    && isRuntimeFailureForInactiveProfile({ selection, classification })) {
    return await continueRuntimeAuthRecoveryOnCurrentGroup({ tracked, sessionId: input.sessionId, selection, classification,
      switchCoordinator: input.switchCoordinator,
      settleSupersedingRuntimeGroupGeneration: input.settleSupersedingRuntimeGroupGeneration,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch });
  }

  if (requiresProfileReconnectWithoutGroupSwitch(classification)) {
    return reconnectProfileAction({
      serviceId: selection.serviceId,
      profileId: observedProfileId,
      groupId: activeGroupId,
      reason: classification.kind,
    });
  }

  const credentialPreparation = await prepareConnectedServiceRuntimeCredentialRecovery({
    scope: { kind: 'session', sessionId: input.sessionId }, classification, activeProfileId,
    refresh: input.refreshConnectedServiceCredentialForRuntimeAuthFailure && classification.profileId && activeProfileId ? async () => await input.refreshConnectedServiceCredentialForRuntimeAuthFailure!({
      serviceId: selection.serviceId,
      profileId: activeProfileId,
      sessionId: input.sessionId,
    }) : null,
    onRefreshed: async (refresh, _scope, refreshedProfileId) => {
      await continueAfterRuntimeAuthTargetAdoption({
        tracked,
        sessionId: input.sessionId,
        serviceId: selection.serviceId,
        groupId: activeGroupId,
        profileId: refreshedProfileId,
        generation: classification.groupGeneration,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
      });
      return {
        status: 'credential_refreshed' as const,
        serviceId: selection.serviceId,
        profileId: refreshedProfileId,
        groupId: activeGroupId,
        refresh,
        restartRequested: false,
      };
    },
  });
  if (credentialPreparation.status === 'prepared') return credentialPreparation.result;
  const activeCredentialRefreshFailed = credentialPreparation.refreshFailed;

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
  let result = await switchCore.run({
    sessionId: input.sessionId,
    reason: 'automatic_runtime_failure',
    execute: async () => {
      return await handleConnectedServiceRuntimeAuthFailure({
        scope: { kind: 'session', sessionId: input.sessionId },
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
        switchCoordinator,
        temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
        ...((input.recoveryInvocationSource === 'scheduler_retry' || classification.profileId === null)
          && (classification.kind === 'usage_limit' || classification.kind === 'rate_limit')
          ? { allowCurrentProfileRetry: true }
          : {}),
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
    await emitRuntimeGroupSwitchApplyFailureEvent({
      emitSessionEvent: input.emitSessionEvent ?? null,
      sessionId: input.sessionId,
      reason: classification.kind,
      result: result.result,
    });
    if (
      result.result.status === 'superseded_after_apply'
      && input.settleSupersedingRuntimeGroupGeneration
    ) {
      const adopted = await input.settleSupersedingRuntimeGroupGeneration({
        sessionId: input.sessionId,
        serviceId: selection.serviceId,
        groupId: activeGroupId,
        fromProfileId: normalizeNullableProfileId(observedProfileId),
        result: result.result,
      });
      result = { ...result, result: settledRuntimeGroupRecoveryResult(result.result, adopted) };
    }
    const unqualifiedInactiveFailure = !sourceAuthorization.sourceBinding
      && isRuntimeFailureForInactiveProfile({ selection, classification });
    if (!unqualifiedInactiveFailure) {
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
      continueAfterRuntimeAuthSwitch: result.result.status === 'switched' && unqualifiedInactiveFailure
        ? null : input.continueAfterRuntimeAuthSwitch ?? null,
    });
  }
  return result;
}
