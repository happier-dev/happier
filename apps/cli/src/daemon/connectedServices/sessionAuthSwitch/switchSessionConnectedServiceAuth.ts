import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceUxDiagnosticCodeV1Schema,
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  isConnectedServiceCredentialHealthStatusReconnectRequired,
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
  type ConnectedServiceUxDiagnosticV1,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import { AGENTS_CORE } from '@happier-dev/agents';

import type { CatalogAgentId, ConnectedServiceResumeContinuityDiagnostics } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
  type ConnectedServiceChildSelection,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import { createConnectedServiceAuthGenerationApplyFailureError } from '../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import {
  createConnectedServiceMaterializationIdentity,
  readConnectedServiceMaterializationIdentityV1,
} from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';

import type {
  ConnectedServiceSessionAuthSwitchCore,
  ConnectedServiceSessionAuthSwitchReason,
} from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import {
  CONNECTED_SERVICE_MATERIALIZATION_REASONS,
  collectBlockingConnectedServicesMaterializationDiagnostics,
  isAuthoritativeGroupTargetSupersededMaterializationDiagnostic,
  type ConnectedServicesMaterializationDiagnostic,
} from '../materialize/providerMaterializerTypes';
import type {
  ConnectedServiceAccountAdoptionVerificationInput,
  ConnectedServiceAccountTransitionVerificationResult,
} from '../accountTransitions/connectedServiceAccountTransition';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '../credentials/lifecycleTypes';
import type {
  AcceptedConnectedServiceAccountVerification,
  AcceptedConnectedServiceAccountVerificationByServiceId,
} from '../accountTransitions/acceptedConnectedServiceAccountVerification';
import type { ConnectedServiceTransitionLockMode } from './locking/connectedServiceTransitionLockMode';
import { runSerializedConnectedServiceTransition } from './locking/runSerializedConnectedServiceTransition';
import { buildConnectedServiceUxDiagnostic } from '../diagnostics/connectedServiceUxDiagnostics';
import { sanitizeConnectedServiceDiagnosticString } from '../diagnostics/sanitizeConnectedServiceDiagnosticString';
import { buildConnectedServiceSwitchContinuationAttemptId } from './buildConnectedServiceSwitchContinuationAttemptId';
import { resolveTrackedConnectedServiceVendorResumeId } from './resolveTrackedConnectedServiceSwitchContinuityContext';
import {
  buildRestartFailureOptions,
  buildSwitchFailureResult as failureResult,
  sanitizeConnectedServiceSwitchUnderlyingError,
  summarizeConnectedServiceSwitchApplyError,
} from './diagnostics/buildSwitchFailureResult';
import { resolveSwitchUxDiagnosticSource } from './diagnostics/resolveSwitchUxDiagnosticSource';
import {
  evaluateConnectedServiceSwitchApplyPolicy,
  evaluatePredictiveSoftSwitchSessionApplyPolicy,
} from '../accountGroups/switching/predictiveSoftSwitchPolicy';
import {
  resolveSwitchAttemptEventOutcomeForFailure,
  resolveSwitchAttemptEventOutcomeForSuccess,
} from './events/resolveSwitchAttemptEventOutcome';
import {
  runPostSwitchVerification,
  type RuntimeAuthSelectionsByServiceId,
} from './verification/runPostSwitchVerification';

type ConnectedServiceBinding = ConnectedServiceBindingsV1['bindingsByServiceId'][string];
type AgentConnectedServiceSupport = Readonly<{
  connectedServices?: Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
  }> | null;
}>;
type SessionConnectedServiceAuthSwitchFailure = Extract<
  SessionConnectedServiceAuthSwitchResult,
  Readonly<{ ok: false }>
>;
type SessionConnectedServiceAuthSwitchPostSwitchOutcome = Readonly<{
  failure: SessionConnectedServiceAuthSwitchFailure | null;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>;

function spreadPostSwitchVerification(
  outcome: Pick<SessionConnectedServiceAuthSwitchPostSwitchOutcome, 'verificationByServiceId'>,
): Readonly<{ verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId }> {
  return outcome.verificationByServiceId && Object.keys(outcome.verificationByServiceId).length > 0
    ? { verificationByServiceId: outcome.verificationByServiceId }
    : {};
}

/**
 * INC-6: surface the PROVEN continuity context on success results so switch telemetry carries
 * vendorResumeId / candidatePersistedSessionFile / targetMaterializedRoot / effectiveStateMode
 * instead of all-null fields for spawn_next_turn/restart switches.
 */
function spreadContinuityProofDiagnostics(
  diagnostics: ConnectedServiceResumeContinuityProofDiagnostics | null | undefined,
): Readonly<{ diagnostics?: Readonly<{ continuity: ConnectedServiceResumeContinuityProofDiagnostics }> }> {
  return diagnostics ? { diagnostics: { continuity: diagnostics } } : {};
}
type PublicConnectedServiceResumeContinuityDiagnostics = Pick<
  ConnectedServiceResumeContinuityDiagnostics,
  'requestedStateMode' | 'effectiveStateMode' | 'reachabilityMissReason'
>;

export type SessionConnectedServiceAuthSwitchErrorCode =
  | 'session_not_found'
  | 'agent_mismatch'
  | 'unsupported_service'
  | 'continuity_unsupported'
  | 'profile_missing'
  | 'profile_disconnected'
  | 'group_missing'
  | 'group_generation_conflict'
  | 'provider_state_sharing_required'
  | 'provider_state_sharing_unavailable'
  // Settings snapshot missing (daemon not bootstrapped yet) — retryable, unlike the genuine
  // "provider cannot share state" code above (incident Jun-11 H-A).
  | 'provider_state_sharing_settings_unavailable'
  | 'provider_session_state_unavailable_for_resume'
  | 'metadata_update_failed'
  | 'restart_failed'
  | 'hot_apply_failed'
  | 'credential_revision_superseded'
  | 'bindings_rollback_failed'
  | 'post_switch_recovery_failed'
  | 'hot_apply_succeeded_but_recovery_failed'
  | 'provider_account_adoption_mismatch'
  | 'post_switch_verification_failed'
  | 'profile_action_required'
  | 'hot_apply_restart_required'
  | 'restart_disallowed_by_execution_policy';

export type SessionConnectedServiceAuthSwitchServiceResult = Readonly<{
  status: 'applied' | 'failed' | 'not_attempted';
  errorCode?: string;
}>;

export type SessionConnectedServiceAuthSwitchDiagnostics = Readonly<{
  failurePhase?: 'session_lookup' | 'agent_validation' | 'normalization' | 'continuity' | 'materialization' | 'metadata' | 'restart' | 'hot_apply' | 'rollback' | 'post_switch_recovery' | 'post_switch_verification';
  attemptedAction?: 'restart_requested' | 'hot_applied' | 'metadata_updated';
  partialState?: 'metadata_may_reference_new_binding' | 'runtime_auth_applied' | 'runtime_auth_partially_applied';
  retryable?: boolean;
  continuity?: PublicConnectedServiceResumeContinuityDiagnostics;
  /**
   * Sanitized summary (name + RPC code + bounded message) of the underlying error when an apply
   * threw — notably the Codex app-server `account/login/start` RPC error during hot-apply, which was
   * previously swallowed (bare `catch`), leaving `hot_apply_failed` undiagnosable. This is the
   * provider's error RESPONSE (describes WHY it failed), never our request tokens.
   */
  underlyingError?: string;
  serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
  actionRequired?: Readonly<{
    kind: 'reconnect_profile' | 'profile_action_required';
    profileId: string;
    healthStatus?: ConnectedServiceCredentialHealthStatusV1;
  }>;
  accountSettingsFreshness?: Readonly<{
    requestedVersion: number | null;
    status: 'succeeded' | 'failed';
    error?: string;
  }>;
  verification?: Readonly<{
    expectedProviderAccountId?: string | null;
    actualProviderAccountId?: string | null;
    reason?: string;
    errorClassification?: unknown;
  }>;
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
}>;

/**
 * What a PROVEN continuity resolution verified: the post-materialization target, resume id, and
 * state mode the next spawn will read. Surfaced on successful switch results so switch telemetry
 * (INC-6) is not all-null for spawn_next_turn/restart switches — the exact regression class of the
 * Jun-10 incident stays visible.
 */
export type ConnectedServiceResumeContinuityProofDiagnostics = Omit<
  ConnectedServiceResumeContinuityDiagnostics,
  'reachabilityMissReason'
>;

export type SessionConnectedServiceSwitchContinuity =
  | Readonly<{
      mode: 'restart_rematerialize';
      warnings?: readonly string[];
      diagnostics?: ConnectedServiceResumeContinuityProofDiagnostics;
    }>
  | Readonly<{
      mode: 'hot_apply';
      warnings?: readonly string[];
      diagnostics?: ConnectedServiceResumeContinuityProofDiagnostics;
    }>
  | Readonly<{
      mode: 'unsupported';
      errorCode: Extract<
        SessionConnectedServiceAuthSwitchErrorCode,
        | 'provider_state_sharing_required'
        | 'provider_state_sharing_unavailable'
        | 'provider_state_sharing_settings_unavailable'
        | 'provider_session_state_unavailable_for_resume'
        | 'unsupported_service'
        | 'continuity_unsupported'
      >;
      warnings?: readonly string[];
      diagnostics?: ConnectedServiceResumeContinuityDiagnostics;
    }>;

export type SessionConnectedServiceAuthSwitchResult =
  | Readonly<{
      ok: true;
      action: 'unchanged' | 'restart_requested' | 'hot_applied' | 'metadata_updated';
      normalizedBindings: ConnectedServiceBindingsV1;
      continuityByServiceId: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>;
      warnings: readonly string[];
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
      /** Proven continuity context of the switch (INC-6 telemetry); absent when nothing was proven. */
      diagnostics?: Readonly<{ continuity: ConnectedServiceResumeContinuityProofDiagnostics }>;
    }>
  | Readonly<{
      ok: false;
      errorCode: SessionConnectedServiceAuthSwitchErrorCode;
      serviceId?: string;
      continuityByServiceId?: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>;
      diagnostics?: SessionConnectedServiceAuthSwitchDiagnostics;
    }>;

function withSwitchAttemptedAction(
  failure: SessionConnectedServiceAuthSwitchFailure,
  attemptedAction: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['attemptedAction']>,
): SessionConnectedServiceAuthSwitchFailure {
  return {
    ...failure,
    diagnostics: {
      ...(failure.diagnostics ?? {}),
      attemptedAction,
    },
  };
}

export type SessionConnectedServiceAuthSwitchRequest = Readonly<{
  sessionId: string;
  agentId: string;
  bindings: ConnectedServiceBindingsV1;
  rematerializeServiceId?: ConnectedServiceId;
  expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
  accountSettingsVersionHint?: number;
}>;

type ConnectedServiceProfilesApi = Readonly<{
  listConnectedServiceProfiles(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceCredentialHealthStatusV1;
    }>>;
  }>>;
  getConnectedServiceAuthGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null>;
}>;

type EffectiveBinding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>;
type ConnectedServiceGroupRuntimeMetadata = Readonly<{
  groupId: string;
  activeProfileId: string;
  fallbackProfileId: string;
  generation: number;
}>;
type ConnectedServiceAccountSwitchMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';
export type SessionConnectedServiceRuntimeAuthSelectionMaterializerMode = 'apply' | 'preflight';

export type SessionConnectedServiceRuntimeAuthSelectionMaterializerInput = Readonly<{
  mode: SessionConnectedServiceRuntimeAuthSelectionMaterializerMode;
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previous: EffectiveBinding | null;
  next: EffectiveBinding;
  previousBindings: ConnectedServiceBindingsV1;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadata?: ConnectedServiceGroupRuntimeMetadata;
  applyReason?: 'usage_limit' | 'same_provider_account_exhausted' | 'soft_threshold' | 'manual' | 'diagnostic';
  requireDirectLiveHotApply?: boolean;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
}>;

type PostSwitchRecoveryResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode?: string }>;

type SwitchContinuationRecoveryInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
}>;

export type SwitchSessionConnectedServiceAuthInput = Readonly<{
  core: ConnectedServiceSessionAuthSwitchCore;
  transitionLockMode?: ConnectedServiceTransitionLockMode;
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  executionPolicy?: Readonly<{
    allowRestartResume: boolean;
    allowContinuation: boolean;
    source: 'startup_reconciliation' | 'runtime';
  }>;
  /**
   * Group-switch trigger reason (e.g. `soft_threshold`) threaded from the group switch
   * coordinator. A predictive soft-threshold switch must never disrupt a live session, so when
   * the resolved continuity is anything but a hot apply the FSM refuses BEFORE committing
   * bindings or requesting a restart (RD-SW-9) instead of relying on the coordinator's
   * post-apply backstop.
   */
  groupSwitchTriggerReason?: string;
  postSwitchVerificationMode?: Readonly<{
    kind: 'disabled_for_test_only';
    reason: string;
  }>;
  sessionEventReason?: string;
  /**
   * Per-service override for the transcript switch event's "from" profile. The persisted GROUP
   * binding does not track the live active member, so an automatic group switch would emit a null
   * "from" (rendered as the native / "CLI Auth" label). The daemon threads the pre-switch member
   * here so the transcript shows the real account it switched away from. Falls back to the previous
   * binding's profile when absent (correct for a manual native->profile switch).
   */
  emitFromProfileIdByServiceId?: ReadonlyMap<ConnectedServiceId, string | null>;
  getChildren: () => ReadonlyArray<TrackedSession>;
  resolveInactiveSession?(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    /** Session working directory — drives the source-aware resume-reachability probe at continuity. */
    cwd?: string | null;
    /** Persisted vendor session-file hint (provider-derived by the caller) — reachability fast path. */
    candidatePersistedSessionFile?: string | null;
  }> | null>;
  api: ConnectedServiceProfilesApi;
  resolveContinuity(input: Readonly<{
    tracked: TrackedSession | null;
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    previous: EffectiveBinding | null;
    next: EffectiveBinding;
    previousBindings: ConnectedServiceBindingsV1;
    normalizedBindings: ConnectedServiceBindingsV1;
    runtimeAuthSelection?: unknown;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    /**
     * For an INACTIVE switch (tracked=null) the daemon adapter cannot read cwd/target root from a
     * tracked session, so the switch forwards the inactive session's working directory and persisted
     * session-file hint here. The adapter uses them (plus the deterministic reconstructed materialized
     * root) to prove shared-state resume reachability instead of fail-closing a resumable session.
     */
    cwd?: string | null;
    candidatePersistedSessionFile?: string | null;
  }>): Promise<SessionConnectedServiceSwitchContinuity>;
  materializeRuntimeAuthSelection?(
    input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput,
  ): Promise<unknown | null>;
  expectedCredentialRevisionByServiceId?: Readonly<
    Partial<Record<ConnectedServiceId, ConnectedServiceCredentialRevisionV1>>
  >;
  runtimeAuthApplyCapabilityResolver?(input: Readonly<{
    tracked: TrackedSession | null;
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
  }>): Promise<ConnectedServiceRuntimeAuthApplyCapability | null | undefined> | ConnectedServiceRuntimeAuthApplyCapability | null | undefined;
  restartSession(tracked: TrackedSession): Promise<void>;
  hotApply(input: Readonly<{
    tracked: TrackedSession;
    normalizedBindings: ConnectedServiceBindingsV1;
    serviceIds?: ReadonlySet<ConnectedServiceId>;
    runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  }>): Promise<
    | Readonly<{
        ok: true;
        verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
      }>
    | Readonly<{
        ok: false;
        errorCode?: string;
        serviceId?: string;
        serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
        underlyingError?: string;
      }>
  >;
  recoverAfterRuntimeAuthSwitch?(input: Readonly<{
    tracked: TrackedSession;
    normalizedBindings: ConnectedServiceBindingsV1;
    serviceIds: ReadonlySet<ConnectedServiceId>;
    action: 'hot_applied' | 'restart_requested';
    runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  }>): Promise<PostSwitchRecoveryResult>;
  continueAfterRuntimeAuthSwitch?(input: SwitchContinuationRecoveryInput): Promise<void>;
  verifyProviderAccountAdoption?(
    input: ConnectedServiceAccountAdoptionVerificationInput,
  ): Promise<ConnectedServiceAccountTransitionVerificationResult>;
  persistSessionBindings?(input: Readonly<{
    sessionId: string;
    normalizedBindings: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  }>): Promise<void>;
  registerHotApplyTargets(
    tracked: TrackedSession,
    context?: Readonly<{
      runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
    }>,
  ): void;
  emitSessionEvent(sessionId: string, event: unknown): void;
  dryRun?: boolean;
  request: SessionConnectedServiceAuthSwitchRequest;
}>;

async function rollbackPersistedSessionBindings(input: Readonly<{
  persistSessionBindings: SwitchSessionConnectedServiceAuthInput['persistSessionBindings'];
  sessionId: string;
  previousBindings: ConnectedServiceBindingsV1;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<boolean> {
  if (!input.persistSessionBindings) return true;
  try {
    await input.persistSessionBindings({
      sessionId: input.sessionId,
      normalizedBindings: input.previousBindings,
      ...(input.connectedServiceMaterializationIdentityV1
        ? { connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1 }
        : {}),
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveTrackedVendorResumeId(input: Readonly<{
  agentId: CatalogAgentId;
  tracked: TrackedSession;
}>): string | null {
  return resolveTrackedConnectedServiceVendorResumeId({
    agentId: input.agentId,
    tracked: input.tracked,
  });
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readGroupGeneration(value: unknown): number {
  return readNonNegativeInteger(value) ?? 0;
}

function resolveGroupFallbackProfileId(input: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  requestedFallbackProfileId?: string | null;
  activeProfileId: string;
}>): string {
  const requestedFallbackProfileId = readNonEmptyString(input.requestedFallbackProfileId);
  if (requestedFallbackProfileId) {
    const requestedFallbackMember = input.group.members.find((member) =>
      member.profileId === requestedFallbackProfileId && member.enabled !== false
    ) ?? null;
    if (requestedFallbackMember) return requestedFallbackProfileId;
  }
  return input.activeProfileId;
}

function groupHasEnabledMember(input: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  profileId: string;
}>): boolean {
  return input.group.members.some((member) =>
    member.profileId === input.profileId && member.enabled !== false
  );
}

function findTrackedSession(children: ReadonlyArray<TrackedSession>, sessionId: string): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function readExpectedGeneration(
  expectedByServiceId: Readonly<Record<string, number>> | undefined,
  serviceId: string,
): number | null {
  const value = expectedByServiceId?.[serviceId];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function toEffectiveBinding(
  serviceId: ConnectedServiceId,
  binding: ConnectedServiceBinding | undefined,
): EffectiveBinding | null {
  if (!binding) return null;
  if (binding.source === 'native') {
    return {
      source: 'native',
      selection: 'native',
      serviceId,
      profileId: null,
      groupId: null,
    };
  }
  if (binding.selection === 'group') {
    return {
      source: 'connected',
      selection: 'group',
      serviceId,
      profileId: binding.profileId ?? null,
      groupId: binding.groupId,
    };
  }
  return {
    source: 'connected',
    selection: 'profile',
    serviceId,
    profileId: binding.profileId,
    groupId: null,
  };
}

function effectiveBindingChanged(previous: EffectiveBinding | null, next: EffectiveBinding): boolean {
  if (!previous) return next.source !== 'native';
  return previous?.source !== next.source
    || previous.selection !== next.selection
    || previous.profileId !== next.profileId
    || previous.groupId !== next.groupId;
}

function readHotApplyFailurePartialState(
  serviceResultsByServiceId: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>> | undefined,
): NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['partialState']> | undefined {
  if (!serviceResultsByServiceId) return undefined;
  return Object.values(serviceResultsByServiceId).some((result) => result.status === 'applied')
    ? 'runtime_auth_partially_applied'
    : undefined;
}

function hotApplyFailureRequiresRestart(input: Readonly<{
  errorCode?: string;
  serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
}>): boolean {
  const serviceResults = Object.values(input.serviceResultsByServiceId ?? {});
  if (input.errorCode === 'hot_apply_restart_required') return true;
  if (input.errorCode === 'hot_apply_unavailable') {
    return serviceResults.length === 0 || !serviceResults.some((result) => result.status === 'applied');
  }
  if (serviceResults.some((result) => (
    result.errorCode === 'hot_apply_restart_required'
  ))) {
    return true;
  }

  if (input.errorCode !== 'hot_apply_failed') return false;
  if (serviceResults.length === 0) return true;
  return !serviceResults.some((result) => result.status === 'applied')
    && serviceResults.every((result) => (
      result.status !== 'failed' || result.errorCode === 'hot_apply_failed'
    ));
}

function normalizeSwitchApplyReason(reason: string | undefined): 'usage_limit' | 'same_provider_account_exhausted' | 'soft_threshold' | 'manual' | 'diagnostic' {
  return reason === 'usage_limit'
    || reason === 'same_provider_account_exhausted'
    || reason === 'soft_threshold'
    || reason === 'manual'
    || reason === 'diagnostic'
    ? reason
    : 'manual';
}

function resolveSwitchApplyPolicyContext(reason: string | undefined): Parameters<typeof evaluateConnectedServiceSwitchApplyPolicy>[0]['context'] {
  if (reason === 'same_provider_account_exhausted') return 'healthy_sibling';
  if (reason === 'soft_threshold') return 'healthy_live_session';
  if (reason === 'usage_limit') return 'original_failed_session';
  return 'manual';
}

function resolveSwitchApplyPolicy(input: Readonly<{
  groupSwitchTriggerReason: string | undefined;
  applyMode?: 'hot_apply' | 'restart_resume' | 'spawn_next_turn' | 'transport_recycle' | 'direct_live_hot_auth' | null;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): ReturnType<typeof evaluateConnectedServiceSwitchApplyPolicy> {
  const reason = normalizeSwitchApplyReason(input.groupSwitchTriggerReason);
  return evaluateConnectedServiceSwitchApplyPolicy({
    context: resolveSwitchApplyPolicyContext(reason),
    reason,
    applyMode: input.applyMode,
    runtimeAuthApply: input.runtimeAuthApply,
  });
}

function switchPolicyAllowsRestartResumeFallback(
  groupSwitchTriggerReason: string | undefined,
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null,
): boolean {
  return resolveSwitchApplyPolicy({
    groupSwitchTriggerReason,
    applyMode: 'restart_resume',
    runtimeAuthApply,
  }).allowRestartResume;
}

function shouldRequireDirectLiveHotApply(
  groupSwitchTriggerReason: string | undefined,
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null,
): boolean {
  const decision = resolveSwitchApplyPolicy({
    groupSwitchTriggerReason,
    applyMode: 'hot_apply',
    runtimeAuthApply,
  });
  return decision.allowDirectLiveHotApply
    && !decision.allowRestartResume
    && !decision.allowTransportRecycle;
}

function switchPolicyAllowsRestartResumeFallbackForServices(input: Readonly<{
  groupSwitchTriggerReason: string | undefined;
  runtimeAuthApplyByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceRuntimeAuthApplyCapability | null>;
  serviceIds: Iterable<ConnectedServiceId>;
  failedServiceId?: string;
}>): boolean {
  const failedServiceId = Array.from(input.runtimeAuthApplyByServiceId.keys())
    .find((serviceId) => serviceId === input.failedServiceId);
  const fallbackServiceIds = failedServiceId
    ? [failedServiceId]
    : Array.from(input.serviceIds);
  if (fallbackServiceIds.length === 0) {
    return switchPolicyAllowsRestartResumeFallback(input.groupSwitchTriggerReason);
  }
  return fallbackServiceIds.every((serviceId) => switchPolicyAllowsRestartResumeFallback(
    input.groupSwitchTriggerReason,
    input.runtimeAuthApplyByServiceId.get(serviceId) ?? null,
  ));
}

function markHotApplyContinuityAsRestart(
  continuityByServiceId: Readonly<Record<string, SessionConnectedServiceSwitchContinuity['mode']>>,
): Record<string, SessionConnectedServiceSwitchContinuity['mode']> {
  return Object.fromEntries(
    Object.entries(continuityByServiceId).map(([serviceId, mode]) => [
      serviceId,
      mode === 'hot_apply' ? 'restart_rematerialize' : mode,
    ]),
  );
}

function buildConnectedServiceChildSelection(input: Readonly<{
  serviceId: ConnectedServiceId;
  binding: Extract<ConnectedServiceBinding, Readonly<{ source: 'connected' }>>;
  runtimeAuthSelection?: unknown;
  previousSelection?: ConnectedServiceChildSelection;
  groupMetadata?: ConnectedServiceGroupRuntimeMetadata;
}>): ConnectedServiceChildSelection | null {
  const runtimeAuthSelection = readRecord(input.runtimeAuthSelection);
  if (input.binding.selection === 'profile') {
    return {
      kind: 'profile',
      serviceId: input.serviceId,
      profileId: input.binding.profileId,
      credentialRevision: ConnectedServiceCredentialRevisionV1Schema.safeParse(
        runtimeAuthSelection?.credentialRevision,
      ).data ?? input.previousSelection?.credentialRevision ?? null,
    };
  }

  const previousGroupSelection = input.previousSelection?.kind === 'group'
    ? input.previousSelection
    : null;
  const groupMetadata = input.groupMetadata?.groupId === input.binding.groupId ? input.groupMetadata : null;
  const groupId = readNonEmptyString(runtimeAuthSelection?.groupId)
    || groupMetadata?.groupId
    || input.binding.groupId;
  const activeProfileId = readNonEmptyString(
    runtimeAuthSelection?.activeProfileId ?? runtimeAuthSelection?.profileId,
  ) || groupMetadata?.activeProfileId || input.binding.profileId;
  if (!groupId || !activeProfileId) return null;

  return {
    kind: 'group',
    serviceId: input.serviceId,
    groupId,
    activeProfileId,
    fallbackProfileId: readNonEmptyString(runtimeAuthSelection?.fallbackProfileId)
      || groupMetadata?.fallbackProfileId
      || previousGroupSelection?.fallbackProfileId
      || activeProfileId,
    generation: readNonNegativeInteger(runtimeAuthSelection?.generation)
      ?? groupMetadata?.generation
      ?? previousGroupSelection?.generation
      ?? 0,
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.safeParse(
      runtimeAuthSelection?.credentialRevision,
    ).data ?? previousGroupSelection?.credentialRevision ?? null,
  };
}

function buildTrackedSessionEnvironmentVariables(input: Readonly<{
  existingEnvironmentVariables?: Record<string, string>;
  normalizedBindings: ConnectedServiceBindingsV1;
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  groupMetadataByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
}>): Record<string, string> | undefined {
  const environmentVariables = input.existingEnvironmentVariables
    ? { ...input.existingEnvironmentVariables }
    : {};
  const previousSelectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceChildSelection>(
    readConnectedServiceChildSelectionsFromEnv(environmentVariables).map((selection) => [selection.serviceId, selection]),
  );
  const nextSelections: ConnectedServiceChildSelection[] = [];

  for (const [serviceIdRaw, binding] of Object.entries(input.normalizedBindings.bindingsByServiceId)) {
    if (binding.source !== 'connected') continue;
    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!serviceIdParsed.success) continue;
    const nextSelection = buildConnectedServiceChildSelection({
      serviceId: serviceIdParsed.data,
      binding,
      runtimeAuthSelection: input.runtimeAuthSelectionsByServiceId?.get(serviceIdParsed.data),
      previousSelection: previousSelectionsByServiceId.get(serviceIdParsed.data),
      groupMetadata: input.groupMetadataByServiceId?.get(serviceIdParsed.data),
    });
    if (nextSelection) {
      nextSelections.push(nextSelection);
    }
  }

  if (nextSelections.length > 0) {
    environmentVariables[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify(nextSelections);
  } else {
    delete environmentVariables[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  }

  return Object.keys(environmentVariables).length > 0 ? environmentVariables : undefined;
}

async function validateConnectedProfile(input: Readonly<{
  api: ConnectedServiceProfilesApi;
  serviceId: ConnectedServiceId;
  profileId: string;
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  const profiles = await input.api.listConnectedServiceProfiles({ serviceId: input.serviceId });
  const profile = profiles.profiles.find((candidate) => candidate.profileId === input.profileId) ?? null;
  if (!profile) {
    return { ok: false, errorCode: 'profile_missing', serviceId: input.serviceId };
  }
  const healthStatus = normalizeConnectedServiceCredentialHealthStatus(profile.status);
  if (isConnectedServiceCredentialHealthStatusReconnectRequired(healthStatus)) {
	    return failureResult('profile_action_required', {
	      serviceId: input.serviceId,
	      failurePhase: 'normalization',
	      diagnosticSource: input.diagnosticSource,
	      actionRequired: {
        kind: 'reconnect_profile',
        profileId: input.profileId,
        healthStatus: 'needs_reauth',
      },
    });
  }
  if (!isConnectedServiceCredentialHealthStatusUsable(healthStatus)) {
    return { ok: false, errorCode: 'profile_disconnected', serviceId: input.serviceId };
  }
  return null;
}

async function normalizeRequestedBindings(input: Readonly<{
  api: ConnectedServiceProfilesApi;
  agentId: CatalogAgentId;
  request: SessionConnectedServiceAuthSwitchRequest;
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  dryRun?: boolean;
}>): Promise<
  | Readonly<{
      ok: true;
      normalized: ConnectedServiceBindingsV1;
      effectiveByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
      groupMetadataByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
    }>
  | SessionConnectedServiceAuthSwitchFailure
> {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(input.request.bindings);
  if (!parsed.success) {
    return { ok: false, errorCode: 'unsupported_service' };
  }

  const effectiveByServiceId = new Map<ConnectedServiceId, EffectiveBinding>();
  const groupMetadataByServiceId = new Map<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>();
  const normalizedBindingsByServiceId: ConnectedServiceBindingsV1['bindingsByServiceId'] = {};

  for (const [serviceIdRaw, binding] of Object.entries(parsed.data.bindingsByServiceId)) {
    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!serviceIdParsed.success) {
      return { ok: false, errorCode: 'unsupported_service', serviceId: serviceIdRaw };
    }
    const serviceId = serviceIdParsed.data;
    const agent = (AGENTS_CORE as Partial<Record<CatalogAgentId, AgentConnectedServiceSupport>>)[input.agentId] ?? null;
    const supportedServiceIds = agent?.connectedServices?.supportedServiceIds ?? [];
    if (!supportedServiceIds.includes(serviceId)) {
      return { ok: false, errorCode: 'unsupported_service', serviceId };
    }
    if (binding.source === 'native') {
      normalizedBindingsByServiceId[serviceId] = { source: 'native' };
      effectiveByServiceId.set(serviceId, {
        source: 'native',
        selection: 'native',
        serviceId,
        profileId: null,
        groupId: null,
      });
      continue;
    }

    if (binding.selection === 'group') {
      const group = await input.api.getConnectedServiceAuthGroup({
        serviceId,
        groupId: binding.groupId,
      });
      if (!group) {
        return { ok: false, errorCode: 'group_missing', serviceId };
      }
      const expectedGeneration = readExpectedGeneration(input.request.expectedGroupGenerationByServiceId, serviceId);
      const currentGeneration = readGroupGeneration(group.generation);
      const prospectiveProfileId = readNonEmptyString(binding.profileId);
      const isProspectiveDryRunGeneration = input.dryRun === true
        && expectedGeneration !== null
        && expectedGeneration === currentGeneration + 1
        && prospectiveProfileId.length > 0
        && groupHasEnabledMember({ group, profileId: prospectiveProfileId });
      // Generation semantics are CONVERGENCE, not CAS, for real applies: the caller's expected
      // generation is a snapshot taken before a fan-out that legitimately overlaps other group
      // writers (concurrent daemons, recovery switches, member edits — observed live 2026-07-10 as
      // per-session "group_generation_conflict" transcript errors on every settings pool switch).
      // The switch below applies the group's CURRENT active profile + generation, which is always
      // the correct target regardless of how the generation advanced. Only DRY-RUN preflights keep
      // the strict check: they validate a PROSPECTIVE (not-yet-committed) generation and must abort
      // on any other mismatch so the coordinator re-resolves before committing.
      if (
        input.dryRun === true
        && expectedGeneration !== null
        && expectedGeneration !== currentGeneration
        && !isProspectiveDryRunGeneration
      ) {
        return { ok: false, errorCode: 'group_generation_conflict', serviceId };
      }
      const activeProfileId = isProspectiveDryRunGeneration
        ? prospectiveProfileId
        : typeof group.activeProfileId === 'string' ? group.activeProfileId.trim() : '';
      if (!activeProfileId) {
        return { ok: false, errorCode: 'profile_missing', serviceId };
      }
      const fallbackProfileId = resolveGroupFallbackProfileId({
        group,
        requestedFallbackProfileId: binding.profileId,
        activeProfileId,
      });
	      const profileError = await validateConnectedProfile({
	        api: input.api,
	        serviceId,
	        profileId: activeProfileId,
	        diagnosticSource: input.diagnosticSource,
	      });
      if (profileError) return profileError;
      if (fallbackProfileId !== activeProfileId) {
	        const fallbackProfileError = await validateConnectedProfile({
	          api: input.api,
	          serviceId,
	          profileId: fallbackProfileId,
	          diagnosticSource: input.diagnosticSource,
	        });
        if (fallbackProfileError) return fallbackProfileError;
      }

      normalizedBindingsByServiceId[serviceId] = {
        source: 'connected',
        selection: 'group',
        groupId: binding.groupId,
        profileId: activeProfileId,
      };
      groupMetadataByServiceId.set(serviceId, {
        groupId: binding.groupId,
        activeProfileId,
        fallbackProfileId,
        generation: isProspectiveDryRunGeneration && expectedGeneration !== null
          ? expectedGeneration
          : currentGeneration,
      });
      effectiveByServiceId.set(serviceId, {
        source: 'connected',
        selection: 'group',
        serviceId,
        profileId: activeProfileId,
        groupId: binding.groupId,
      });
      continue;
    }

    const profileBindingGroupId = readNonEmptyString(readRecord(binding)?.groupId);
    if (profileBindingGroupId) {
      const group = await input.api.getConnectedServiceAuthGroup({
        serviceId,
        groupId: profileBindingGroupId,
      });
      if (group && groupHasEnabledMember({ group, profileId: binding.profileId })) {
        const expectedGeneration = readExpectedGeneration(input.request.expectedGroupGenerationByServiceId, serviceId);
        const currentGeneration = readGroupGeneration(group.generation);
        // Same convergence rule as the group-selection branch above: real applies converge onto the
        // group's CURRENT truth; only dry-run preflights abort on a generation mismatch.
        if (input.dryRun === true && expectedGeneration !== null && expectedGeneration !== currentGeneration) {
          return { ok: false, errorCode: 'group_generation_conflict', serviceId };
        }
        const activeProfileId = typeof group.activeProfileId === 'string' ? group.activeProfileId.trim() : '';
        if (!activeProfileId) {
          return { ok: false, errorCode: 'profile_missing', serviceId };
        }
        const fallbackProfileId = resolveGroupFallbackProfileId({
          group,
          requestedFallbackProfileId: binding.profileId,
          activeProfileId,
        });
	      const activeProfileError = await validateConnectedProfile({
	        api: input.api,
	        serviceId,
	        profileId: activeProfileId,
	        diagnosticSource: input.diagnosticSource,
	      });
        if (activeProfileError) return activeProfileError;
        if (fallbackProfileId !== activeProfileId) {
	        const fallbackProfileError = await validateConnectedProfile({
	          api: input.api,
	          serviceId,
	          profileId: fallbackProfileId,
	          diagnosticSource: input.diagnosticSource,
	        });
          if (fallbackProfileError) return fallbackProfileError;
        }
        normalizedBindingsByServiceId[serviceId] = {
          source: 'connected',
          selection: 'group',
          groupId: profileBindingGroupId,
          profileId: activeProfileId,
        };
        groupMetadataByServiceId.set(serviceId, {
          groupId: profileBindingGroupId,
          activeProfileId,
          fallbackProfileId,
          generation: currentGeneration,
        });
        effectiveByServiceId.set(serviceId, {
          source: 'connected',
          selection: 'group',
          serviceId,
          profileId: activeProfileId,
          groupId: profileBindingGroupId,
        });
        continue;
      }
    }

	    const profileError = await validateConnectedProfile({
	      api: input.api,
	      serviceId,
	      profileId: binding.profileId,
	      diagnosticSource: input.diagnosticSource,
	    });
    if (profileError) return profileError;
    normalizedBindingsByServiceId[serviceId] = {
      source: 'connected',
      selection: 'profile',
      profileId: binding.profileId,
    };
    effectiveByServiceId.set(serviceId, {
      source: 'connected',
      selection: 'profile',
      serviceId,
      profileId: binding.profileId,
      groupId: null,
    });
  }

  return {
    ok: true,
    normalized: {
      v: 1,
      bindingsByServiceId: normalizedBindingsByServiceId,
    },
    effectiveByServiceId,
    groupMetadataByServiceId,
  };
}

function previousEffectiveBindings(raw: unknown): ReadonlyMap<ConnectedServiceId, EffectiveBinding> {
  const parsed = readConnectedServiceBindingsOrEmpty(raw);
  const out = new Map<ConnectedServiceId, EffectiveBinding>();
  for (const [serviceIdRaw, binding] of Object.entries(parsed.bindingsByServiceId)) {
    const serviceId = serviceIdRaw as ConnectedServiceId;
    const effective = toEffectiveBinding(serviceId, binding);
    if (effective) out.set(serviceId, effective);
  }
  return out;
}

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 1, bindingsByServiceId: {} };
}

function bindingsRequireMaterializationIdentity(bindings: ConnectedServiceBindingsV1): boolean {
  return Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

function resolveMaterializationIdentityForAcceptedBindings(input: Readonly<{
  existingIdentity: unknown;
  normalizedBindings: ConnectedServiceBindingsV1;
}>): ConnectedServiceMaterializationIdentityV1 | null {
  const existing = readConnectedServiceMaterializationIdentityV1(input.existingIdentity);
  if (existing) return existing;
  return bindingsRequireMaterializationIdentity(input.normalizedBindings)
    ? createConnectedServiceMaterializationIdentity()
    : null;
}

function resolveNextEffectiveBindings(input: Readonly<{
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  requestedByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
}>): ReadonlyMap<ConnectedServiceId, EffectiveBinding> {
  const out = new Map(input.requestedByServiceId);
  for (const [serviceId, previous] of input.previousByServiceId.entries()) {
    if (out.has(serviceId)) continue;
    out.set(serviceId, {
      source: 'native',
      selection: 'native',
      serviceId,
      profileId: null,
      groupId: null,
    });
  }
  return out;
}

function emitManualSwitchEvents(input: Readonly<{
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  /**
   * Per-service live pre-switch member, threaded for automatic group switches where the persisted
   * group binding does not track it. When present it is the transcript "from"; otherwise we fall
   * back to the previous binding's profile (correct for a native->profile switch, where null
   * legitimately renders as the native / "CLI Auth" label).
   */
  fromProfileIdOverrideByServiceId?: ReadonlyMap<ConnectedServiceId, string | null>;
  reason: string;
  mode: ConnectedServiceAccountSwitchMode;
}>): void {
  for (const [serviceId, next] of input.nextByServiceId.entries()) {
    const previous = input.previousByServiceId.get(serviceId) ?? null;
    if (!effectiveBindingChanged(previous, next)) continue;
    const fromProfileId = input.fromProfileIdOverrideByServiceId?.get(serviceId) ?? previous?.profileId ?? null;
    if (fromProfileId && next.profileId && fromProfileId === next.profileId) continue;
    input.emitSessionEvent(input.sessionId, {
      type: 'connected_service_account_switch',
      serviceId,
      groupId: next.groupId ?? previous?.groupId ?? null,
      fromProfileId,
      toProfileId: next.profileId,
      reason: input.reason,
      mode: input.mode,
    });
  }
}

const SWITCH_ATTEMPT_FAILURE_ERROR_CODES = new Set<SessionConnectedServiceAuthSwitchErrorCode>([
  'unsupported_service',
  'continuity_unsupported',
  'profile_missing',
  'profile_disconnected',
  'group_missing',
  'group_generation_conflict',
  'provider_state_sharing_required',
  'provider_state_sharing_unavailable',
  'provider_state_sharing_settings_unavailable',
  'provider_session_state_unavailable_for_resume',
  'profile_action_required',
  'metadata_update_failed',
  'restart_failed',
  'hot_apply_failed',
  'bindings_rollback_failed',
  'post_switch_recovery_failed',
  'hot_apply_succeeded_but_recovery_failed',
  'provider_account_adoption_mismatch',
  'post_switch_verification_failed',
]);

function emitConnectedServiceSwitchAttemptEvent(input: Readonly<{
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  result: SessionConnectedServiceAuthSwitchResult;
  groupSwitchTriggerReason?: string;
}>): void {
  const reason = normalizeSwitchApplyReason(input.groupSwitchTriggerReason);
  if (input.result.ok) {
    if (input.result.action === 'unchanged') return;
    if (input.groupSwitchTriggerReason === 'soft_threshold') return;
    const projection = resolveSwitchAttemptEventOutcomeForSuccess({ action: input.result.action });
    input.emitSessionEvent(input.sessionId, {
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: projection.action,
      reason,
      attemptedContinuityMode: projection.attemptedContinuityMode,
      outcome: projection.outcome,
      outcomeAction: projection.outcomeAction,
      errorCode: null,
      partialState: null,
      ...(input.result.verificationByServiceId
        ? { verificationByServiceId: input.result.verificationByServiceId }
        : {}),
    });
    return;
  }

  if (!SWITCH_ATTEMPT_FAILURE_ERROR_CODES.has(input.result.errorCode)) return;
  // Mirror of the soft-threshold guard on the SUCCESS path above. A predictive soft-threshold
  // switch is a background optimization with a fail-safe design (RD-SW-9): it only ever hot-applies
  // (never restarts a working session) and declines BEFORE side effects when no safe apply window
  // exists (e.g. the session is mid-turn). The session keeps working on its current account, the
  // next poll/in-band tick retries, and hard-limit recovery remains the backstop — so a declined
  // hot-apply must not surface as a user-facing "Authentication could not be switched" error
  // (observed live 2026-07-10 19:10: 4 idle siblings applied instantly, the one mid-turn session
  // alarmed the user). Side-effectful failure codes stay loud even for soft-threshold switches.
  if (input.groupSwitchTriggerReason === 'soft_threshold' && input.result.errorCode === 'hot_apply_failed') {
    return;
  }
	  const projection = resolveSwitchAttemptEventOutcomeForFailure({
	    errorCode: input.result.errorCode,
	    attemptedAction: input.result.diagnostics?.attemptedAction,
	    continuityByServiceId: input.result.continuityByServiceId,
	  });
  input.emitSessionEvent(input.sessionId, {
    type: 'connected_service_account_switch_attempt',
    ok: false,
    action: projection.action,
    reason,
    attemptedContinuityMode: projection.attemptedContinuityMode,
    outcome: projection.outcome,
    outcomeAction: projection.outcomeAction,
    errorCode: input.result.errorCode,
    partialState: input.result.diagnostics?.partialState ?? null,
    diagnostic: input.result.diagnostics?.uxDiagnostic,
  });
}

function readMaterializationDiagnostics(raw: unknown): readonly ConnectedServicesMaterializationDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const code = readNonEmptyString(record.code);
    const providerId = readNonEmptyString(record.providerId);
    if (!code || !providerId) return [];
    const serviceIdParsed = record.serviceId === undefined
      ? null
      : ConnectedServiceIdSchema.safeParse(record.serviceId);
    const serviceId = serviceIdParsed?.success ? serviceIdParsed.data : undefined;
    const requestedStateMode = readNonEmptyString(record.requestedStateMode) || undefined;
    const effectiveStateMode = readNonEmptyString(record.effectiveStateMode) || undefined;
    const entryName = readNonEmptyString(record.entryName) || undefined;
    const reason = readNonEmptyString(record.reason) || undefined;
    const severity = record.severity === 'blocking' || record.severity === 'warning'
      ? record.severity
      : undefined;
    return [{
      code,
      providerId: providerId as CatalogAgentId,
      ...(severity ? { severity } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(requestedStateMode ? { requestedStateMode } : {}),
      ...(effectiveStateMode ? { effectiveStateMode } : {}),
      ...(entryName ? { entryName } : {}),
      ...(reason ? { reason } : {}),
    }];
  });
}

function readRuntimeAuthSelectionBlockingMaterializationDiagnostics(
  runtimeAuthSelection: unknown,
): readonly ConnectedServicesMaterializationDiagnostic[] {
  const selection = readRecord(runtimeAuthSelection);
  return collectBlockingConnectedServicesMaterializationDiagnostics(
    readMaterializationDiagnostics(selection?.materializationDiagnostics),
  );
}

function readRuntimeAuthCredentialWriteCommitted(runtimeAuthSelection: unknown): Promise<unknown> | null {
  const selection = readRecord(runtimeAuthSelection);
  const candidate = readRecord(selection)?.credentialWriteCommitted;
  if (!candidate || typeof candidate !== 'object') return null;
  const then = (candidate as Readonly<{ then?: unknown }>).then;
  return typeof then === 'function' ? candidate as Promise<unknown> : null;
}

async function awaitRuntimeAuthCredentialWriteCommitted(runtimeAuthSelection: unknown): Promise<void> {
  const committed = readRuntimeAuthCredentialWriteCommitted(runtimeAuthSelection);
  if (!committed) return;
  await committed;
}

function buildRuntimeAuthMaterializationFailureResult(input: Readonly<{
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  next: EffectiveBinding;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
}>): SessionConnectedServiceAuthSwitchFailure {
  const primary = input.diagnostics[0] ?? null;
  const parsedCode = ConnectedServiceUxDiagnosticCodeV1Schema.safeParse(primary?.code);
  const code = parsedCode.success
    ? parsedCode.data
    : CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed;
  const reason = primary?.reason
    ? sanitizeConnectedServiceDiagnosticString(primary.reason)
    : null;
  return failureResult('post_switch_verification_failed', {
    serviceId: input.serviceId,
    failurePhase: 'materialization',
    diagnosticSource: input.diagnosticSource,
    retryable: false,
    uxDiagnostic: buildConnectedServiceUxDiagnostic({
      code,
      failurePhase: 'materialization',
      source: input.diagnosticSource,
      agentId: input.agentId,
      providerId: primary?.providerId ?? input.agentId,
      serviceId: primary?.serviceId ?? input.serviceId,
      ...(input.next.profileId ? { profileId: input.next.profileId } : {}),
      ...(input.next.groupId ? { groupId: input.next.groupId } : {}),
      retryable: false,
      diagnostics: {
        reason,
        materializationCode: primary?.code ?? null,
        entryName: primary?.entryName ?? null,
      },
    }),
  });
}

function isAuthoritativeGroupTargetSupersededMaterializationFailure(
  result: SessionConnectedServiceAuthSwitchResult,
): boolean {
  if (result.ok || result.diagnostics?.failurePhase !== 'materialization') return false;
  return result.diagnostics.uxDiagnostic?.diagnostics?.reason
    === CONNECTED_SERVICE_MATERIALIZATION_REASONS.authoritativeGroupTargetSuperseded;
}

function emitProviderStateSharingDegradedEvents(input: Readonly<{
  tracked: TrackedSession | null;
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  result: SessionConnectedServiceAuthSwitchResult;
}>): void {
  if (!input.tracked || !input.result.ok || input.result.action === 'unchanged') return;
  const diagnostics = readMaterializationDiagnostics(
    input.tracked.spawnOptions?.materializationDiagnostics,
  );
  for (const diagnostic of diagnostics) {
    const requestedStateMode = readNonEmptyString(diagnostic.requestedStateMode);
    const effectiveStateMode = readNonEmptyString(diagnostic.effectiveStateMode);
    if (!requestedStateMode || !effectiveStateMode || requestedStateMode === effectiveStateMode) continue;
    if (!diagnostic.serviceId) continue;
    input.emitSessionEvent(input.sessionId, {
      type: 'provider_state_sharing_degraded',
      serviceId: diagnostic.serviceId,
      requestedStateMode,
      effectiveStateMode,
      code: diagnostic.code,
      ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
      ...(diagnostic.entryName ? { entryName: diagnostic.entryName } : {}),
    });
  }
}

async function runPostSwitchRecovery(input: Readonly<{
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  tracked: TrackedSession;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  if (!input.recoverAfterRuntimeAuthSwitch) return null;
  try {
	    const result = await input.recoverAfterRuntimeAuthSwitch({
	      tracked: input.tracked,
	      normalizedBindings: input.normalizedBindings,
	      serviceIds: input.serviceIds,
	      action: input.action,
	      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
	    });
    if (result.ok) return null;
  } catch {
    // Shape provider recovery errors through the same typed partial result.
  }
		  return failureResult(input.action === 'hot_applied'
		    ? 'hot_apply_succeeded_but_recovery_failed'
		    : 'post_switch_recovery_failed', {
		    failurePhase: 'post_switch_recovery',
		    attemptedAction: input.action,
		    partialState: 'runtime_auth_applied',
		    diagnosticSource: input.diagnosticSource,
		  });
}

async function runContinuationRecovery(input: SwitchContinuationRecoveryInput & Readonly<{
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  if (input.switchReason === 'pre_turn_group_policy') return null;
  if (!input.continueAfterRuntimeAuthSwitch) return null;
  try {
    await input.continueAfterRuntimeAuthSwitch({
      tracked: input.tracked,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
	    normalizedBindings: input.normalizedBindings,
	    serviceIds: input.serviceIds,
	    action: input.action,
      switchReason: input.switchReason,
	    ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
	  });
    return null;
		  } catch {
		    return failureResult('post_switch_recovery_failed', {
		      failurePhase: 'post_switch_recovery',
		      attemptedAction: input.action,
		      partialState: 'runtime_auth_applied',
		      diagnosticSource: input.diagnosticSource,
		    });
	  }
}

async function runPostSwitchVerificationThenContinuation(
  input: SwitchContinuationRecoveryInput & Readonly<{
    recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
	    continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  verifyProviderAccountAdoption: SwitchSessionConnectedServiceAuthInput['verifyProviderAccountAdoption'];
    postSwitchVerificationMode: SwitchSessionConnectedServiceAuthInput['postSwitchVerificationMode'];
    diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
    agentId: CatalogAgentId;
    nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
    acceptedVerificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
  }>,
): Promise<SessionConnectedServiceAuthSwitchPostSwitchOutcome> {
  if (input.action === 'hot_applied') {
    const verificationOutcome = await runPostSwitchVerification({
      verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
      postSwitchVerificationMode: input.postSwitchVerificationMode,
      diagnosticSource: input.diagnosticSource,
      tracked: input.tracked,
      sessionId: input.sessionId,
      agentId: input.agentId,
      normalizedBindings: input.normalizedBindings,
      nextByServiceId: input.nextByServiceId,
      serviceIds: input.serviceIds,
      action: input.action,
      buildVerificationFailure: verificationFailureResult,
      ...(input.acceptedVerificationByServiceId ? { acceptedVerificationByServiceId: input.acceptedVerificationByServiceId } : {}),
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    if (verificationOutcome.failure) return verificationOutcome;
    const recoveryFailure = await runPostSwitchRecovery({
      recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
      tracked: input.tracked,
	      normalizedBindings: input.normalizedBindings,
	      serviceIds: input.serviceIds,
	      action: input.action,
	      diagnosticSource: input.diagnosticSource,
	      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
	    });
    if (recoveryFailure) {
      return {
        failure: recoveryFailure,
        ...(verificationOutcome.verificationByServiceId
          ? { verificationByServiceId: verificationOutcome.verificationByServiceId }
          : {}),
      };
    }
    const continuationFailure = await runContinuationRecovery({
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
      tracked: input.tracked,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      normalizedBindings: input.normalizedBindings,
	      serviceIds: input.serviceIds,
	      action: input.action,
      switchReason: input.switchReason,
	      diagnosticSource: input.diagnosticSource,
	      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
	    });
    return {
      failure: continuationFailure,
      ...(verificationOutcome.verificationByServiceId
        ? { verificationByServiceId: verificationOutcome.verificationByServiceId }
        : {}),
    };
  }

  const continuationFailure = await runContinuationRecovery({
    continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    normalizedBindings: input.normalizedBindings,
    serviceIds: input.serviceIds,
    action: input.action,
    switchReason: input.switchReason,
    diagnosticSource: input.diagnosticSource,
    ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
  });
  return {
    failure: continuationFailure,
  };
}

function isRetryableHotApplyPostSwitchVerificationFailure(
  failure: SessionConnectedServiceAuthSwitchFailure,
): boolean {
  return (
    failure.errorCode === 'provider_account_adoption_mismatch'
    || failure.errorCode === 'post_switch_verification_failed'
  )
    && failure.diagnostics?.failurePhase === 'post_switch_verification'
    && failure.diagnostics.retryable === true;
}

async function restartAfterRetryableHotApplyVerificationFailure(input: SwitchContinuationRecoveryInput & Readonly<{
  restartSession: SwitchSessionConnectedServiceAuthInput['restartSession'];
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  verifyProviderAccountAdoption: SwitchSessionConnectedServiceAuthInput['verifyProviderAccountAdoption'];
  postSwitchVerificationMode: SwitchSessionConnectedServiceAuthInput['postSwitchVerificationMode'];
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  agentId: CatalogAgentId;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
}>): Promise<SessionConnectedServiceAuthSwitchPostSwitchOutcome> {
  try {
    await input.restartSession(input.tracked);
  } catch (error) {
	    return {
	      failure: failureResult('restart_failed', {
	        ...buildRestartFailureOptions(error, {
	          partialState: 'runtime_auth_applied',
	        }),
	        diagnosticSource: input.diagnosticSource,
	      }),
	    };
	  }
  return await runPostSwitchVerificationThenContinuation({
    recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
    continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
    verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
    postSwitchVerificationMode: input.postSwitchVerificationMode,
    diagnosticSource: input.diagnosticSource,
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    normalizedBindings: input.normalizedBindings,
    agentId: input.agentId,
    nextByServiceId: input.nextByServiceId,
    serviceIds: input.serviceIds,
    action: 'restart_requested',
    switchReason: input.switchReason,
    ...(input.runtimeAuthSelectionsByServiceId
      ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId }
      : {}),
  });
}

function verificationFailureResult(input: Readonly<{
  serviceId: ConnectedServiceId;
  result: Exclude<ConnectedServiceAccountTransitionVerificationResult, Readonly<{ status: 'verified' | 'weakly_verified' }>>;
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  attemptedAction: 'hot_applied' | 'restart_requested';
}>): SessionConnectedServiceAuthSwitchFailure {
  if (input.result.status === 'mismatch') {
    return failureResult('provider_account_adoption_mismatch', {
		      serviceId: input.serviceId,
		      failurePhase: 'post_switch_verification',
		      attemptedAction: input.attemptedAction,
		      retryable: input.result.retryable,
	      diagnosticSource: input.diagnosticSource,
	      verification: {
        expectedProviderAccountId: input.result.expectedProviderAccountId ?? null,
        actualProviderAccountId: input.result.actualProviderAccountId ?? null,
        ...(input.result.reason ? { reason: input.result.reason } : {}),
      },
    });
  }
	  return failureResult('post_switch_verification_failed', {
		    serviceId: input.serviceId,
		    failurePhase: 'post_switch_verification',
		    attemptedAction: input.attemptedAction,
		    retryable: input.result.retryable,
	    diagnosticSource: input.diagnosticSource,
	    verification: {
      reason: input.result.reason,
      ...(input.result.errorClassification === undefined
        ? {}
        : { errorClassification: input.result.errorClassification }),
    },
  });
}

async function maybeMaterializeRuntimeAuthSelection(input: Readonly<{
  materializeRuntimeAuthSelection: SwitchSessionConnectedServiceAuthInput['materializeRuntimeAuthSelection'];
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previous: EffectiveBinding | null;
  next: EffectiveBinding;
  previousBindings: ConnectedServiceBindingsV1;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadataByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
  mode: SessionConnectedServiceRuntimeAuthSelectionMaterializerMode;
  groupSwitchTriggerReason?: string;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
}>): Promise<unknown | null> {
  if (!input.materializeRuntimeAuthSelection || input.next.source !== 'connected') return null;
  const materialized = await input.materializeRuntimeAuthSelection({
    mode: input.mode,
    tracked: input.tracked,
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceId: input.serviceId,
    previous: input.previous,
    next: input.next,
    previousBindings: input.previousBindings,
    normalizedBindings: input.normalizedBindings,
    groupMetadata: input.groupMetadataByServiceId?.get(input.serviceId),
    applyReason: normalizeSwitchApplyReason(input.groupSwitchTriggerReason),
    requireDirectLiveHotApply: shouldRequireDirectLiveHotApply(
      input.groupSwitchTriggerReason,
      input.runtimeAuthApply,
    ),
    ...(input.expectedCredentialRevision === undefined
      ? {}
      : { expectedCredentialRevision: input.expectedCredentialRevision }),
  });
  if (input.expectedCredentialRevision === undefined) return materialized;
  const actualCredentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    readRecord(materialized)?.credentialRevision,
  );
  if (!actualCredentialRevision.success) {
    throw createConnectedServiceAuthGenerationApplyFailureError({
      errorCode: 'credential_revision_missing',
    });
  }
  if (actualCredentialRevision.data !== input.expectedCredentialRevision) {
    throw createConnectedServiceAuthGenerationApplyFailureError({
      errorCode: 'credential_revision_superseded',
    });
  }
  return materialized;
}

async function resolveRuntimeAuthApplyCapabilityForSwitch(input: Readonly<{
  resolver: SwitchSessionConnectedServiceAuthInput['runtimeAuthApplyCapabilityResolver'];
  tracked: TrackedSession | null;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
}>): Promise<ConnectedServiceRuntimeAuthApplyCapability | null> {
  if (!input.resolver) return null;
  return await input.resolver({
    tracked: input.tracked,
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceId: input.serviceId,
  }) ?? null;
}

function resolveUnchangedRematerializeServiceId(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
}>): ConnectedServiceId | undefined {
  if (input.request.rematerializeServiceId) return input.request.rematerializeServiceId;
  const expectedGenerations = input.request.expectedGroupGenerationByServiceId;
  if (!expectedGenerations) return undefined;
  return Object.keys(expectedGenerations)
    .sort()
    .find((serviceId): serviceId is ConnectedServiceId => {
      const expectedGeneration = expectedGenerations[serviceId];
      if (typeof expectedGeneration !== 'number' || !Number.isFinite(expectedGeneration)) return false;
      const next = input.nextByServiceId.get(serviceId as ConnectedServiceId);
      return next?.source === 'connected' && next.selection === 'group';
    });
}

function readExpectedGroupGenerationForService(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  serviceId: ConnectedServiceId;
}>): number | null {
  const value = input.request.expectedGroupGenerationByServiceId?.[input.serviceId];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * RD-SW-9: pre-side-effect gate for predictive soft-threshold switches. Evaluated where the
 * prospective apply mode is first known (after continuity resolution) so a disallowed switch
 * fails BEFORE bindings commit / restart, keeping the coordinator's post-apply backstop a true
 * never-fires backstop.
 */
function gatePredictiveSoftSwitchBeforeSideEffects(input: Readonly<{
  groupSwitchTriggerReason: string | undefined;
  sessionId: string;
  prospectiveMode: ConnectedServiceAccountSwitchMode;
  attemptedAction: 'restart_requested' | 'hot_applied' | 'metadata_updated';
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability | null;
}>): SessionConnectedServiceAuthSwitchResult | null {
  if (!input.groupSwitchTriggerReason) return null;
  const decision = evaluatePredictiveSoftSwitchSessionApplyPolicy({
    reason: input.groupSwitchTriggerReason as Parameters<typeof evaluatePredictiveSoftSwitchSessionApplyPolicy>[0]['reason'],
    sessionId: input.sessionId,
    applyMode: input.prospectiveMode,
    runtimeAuthApply: input.runtimeAuthApply,
  });
  if (decision.status === 'allow') return null;
  return failureResult('hot_apply_restart_required', {
    failurePhase: 'continuity',
    attemptedAction: input.attemptedAction,
    diagnosticSource: input.diagnosticSource,
  });
}

async function rematerializeUnchangedConnectedServiceBinding(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  groupSwitchTriggerReason?: string;
  tracked: TrackedSession;
  trackedAgentId: CatalogAgentId;
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadataByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
  resolveContinuity: SwitchSessionConnectedServiceAuthInput['resolveContinuity'];
  materializeRuntimeAuthSelection: SwitchSessionConnectedServiceAuthInput['materializeRuntimeAuthSelection'];
  runtimeAuthApplyCapabilityResolver: SwitchSessionConnectedServiceAuthInput['runtimeAuthApplyCapabilityResolver'];
  restartSession: SwitchSessionConnectedServiceAuthInput['restartSession'];
  hotApply: SwitchSessionConnectedServiceAuthInput['hotApply'];
  persistSessionBindings: SwitchSessionConnectedServiceAuthInput['persistSessionBindings'];
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  verifyProviderAccountAdoption: SwitchSessionConnectedServiceAuthInput['verifyProviderAccountAdoption'];
  postSwitchVerificationMode: SwitchSessionConnectedServiceAuthInput['postSwitchVerificationMode'];
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  registerHotApplyTargets: SwitchSessionConnectedServiceAuthInput['registerHotApplyTargets'];
  expectedCredentialRevisionByServiceId: SwitchSessionConnectedServiceAuthInput[
    'expectedCredentialRevisionByServiceId'
  ];
  dryRun?: boolean;
}>): Promise<SessionConnectedServiceAuthSwitchResult | null> {
  const serviceId = resolveUnchangedRematerializeServiceId({
    request: input.request,
    nextByServiceId: input.nextByServiceId,
  });
  if (!serviceId) return null;

  const next = input.nextByServiceId.get(serviceId);
  if (!next || next.source !== 'connected') {
    return {
      ok: true,
      action: 'unchanged',
      normalizedBindings: input.normalizedBindings,
      continuityByServiceId: {},
      warnings: [],
    };
  }
  const runtimeAuthApply = await resolveRuntimeAuthApplyCapabilityForSwitch({
    resolver: input.runtimeAuthApplyCapabilityResolver,
    tracked: input.tracked,
    sessionId: input.request.sessionId,
    agentId: input.trackedAgentId,
    serviceId,
  });
  const previous = input.previousByServiceId.get(serviceId) ?? null;
  const previousBindings = readConnectedServiceBindingsOrEmpty(
    resolveTrackedConnectedServiceBindingsRaw(input.tracked),
  );
  const runtimeAuthSelection = await maybeMaterializeRuntimeAuthSelection({
    materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
    tracked: input.tracked,
    sessionId: input.request.sessionId,
    agentId: input.trackedAgentId,
    serviceId,
    previous,
    next,
    previousBindings,
    normalizedBindings: input.normalizedBindings,
    groupMetadataByServiceId: input.groupMetadataByServiceId,
    mode: input.dryRun ? 'preflight' : 'apply',
    groupSwitchTriggerReason: input.groupSwitchTriggerReason,
    runtimeAuthApply,
    ...(input.expectedCredentialRevisionByServiceId?.[serviceId] === undefined
      ? {}
      : { expectedCredentialRevision: input.expectedCredentialRevisionByServiceId[serviceId] }),
  });
  await awaitRuntimeAuthCredentialWriteCommitted(runtimeAuthSelection);
  const blockingMaterializationDiagnostics = readRuntimeAuthSelectionBlockingMaterializationDiagnostics(
    runtimeAuthSelection,
  );
  if (blockingMaterializationDiagnostics.length > 0) {
    return buildRuntimeAuthMaterializationFailureResult({
      agentId: input.trackedAgentId,
      serviceId,
      next,
      diagnostics: blockingMaterializationDiagnostics,
      diagnosticSource: input.diagnosticSource,
    });
  }
  const previousSpawnOptions = input.tracked.spawnOptions;
  const connectedServiceMaterializationIdentityV1 = resolveMaterializationIdentityForAcceptedBindings({
    existingIdentity: previousSpawnOptions?.connectedServiceMaterializationIdentityV1,
    normalizedBindings: input.normalizedBindings,
  });
  const trackedVendorResumeId = resolveTrackedVendorResumeId({
    agentId: input.trackedAgentId,
    tracked: input.tracked,
  });
  const continuity = await input.resolveContinuity({
    tracked: input.tracked,
    sessionId: input.request.sessionId,
    agentId: input.trackedAgentId,
    serviceId,
    previous,
    next,
    previousBindings,
    normalizedBindings: input.normalizedBindings,
    ...(runtimeAuthSelection === null || runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
    ...(connectedServiceMaterializationIdentityV1 ? { connectedServiceMaterializationIdentityV1 } : {}),
    ...(trackedVendorResumeId ? { vendorResumeId: trackedVendorResumeId } : {}),
  });
  if (continuity.mode === 'unsupported') {
    return failureResult(continuity.errorCode, {
      serviceId,
      failurePhase: 'continuity',
      diagnosticSource: input.diagnosticSource,
      ...(continuity.diagnostics ? { continuity: continuity.diagnostics } : {}),
    });
  }
  const predictiveGate = gatePredictiveSoftSwitchBeforeSideEffects({
    groupSwitchTriggerReason: input.groupSwitchTriggerReason,
    sessionId: input.request.sessionId,
    prospectiveMode: continuity.mode === 'hot_apply' ? 'hot_apply' : 'restart_resume',
    attemptedAction: continuity.mode === 'hot_apply' ? 'hot_applied' : 'restart_requested',
    diagnosticSource: input.diagnosticSource,
    runtimeAuthApply,
  });
  if (predictiveGate) return predictiveGate;

  if (input.dryRun) {
    return {
      ok: true,
      action: continuity.mode === 'hot_apply' ? 'hot_applied' : 'restart_requested',
      normalizedBindings: input.normalizedBindings,
      continuityByServiceId: { [serviceId]: continuity.mode },
      warnings: continuity.warnings ?? [],
      ...spreadContinuityProofDiagnostics(continuity.diagnostics),
    };
  }

  const runtimeAuthSelectionsByServiceId = runtimeAuthSelection === null || runtimeAuthSelection === undefined
    ? undefined
    : new Map([[serviceId, runtimeAuthSelection]]);
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);
  const continuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
    action: continuity.mode === 'hot_apply' ? 'hot_applied' : 'restart_requested',
    serviceIds,
    normalizedBindings: input.normalizedBindings,
    expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
  });
  const nextEnvironmentVariables = buildTrackedSessionEnvironmentVariables({
    existingEnvironmentVariables: previousSpawnOptions?.environmentVariables,
    normalizedBindings: input.normalizedBindings,
    runtimeAuthSelectionsByServiceId,
    groupMetadataByServiceId: input.groupMetadataByServiceId,
  });
  input.tracked.spawnOptions = {
    ...(input.tracked.spawnOptions ?? { directory: '' }),
    connectedServices: input.normalizedBindings,
    connectedServicesUpdatedAt: Date.now(),
    ...(connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1 }
      : {}),
    environmentVariables: nextEnvironmentVariables,
  };

  try {
    if (
      connectedServiceMaterializationIdentityV1
      && !readConnectedServiceMaterializationIdentityV1(previousSpawnOptions?.connectedServiceMaterializationIdentityV1)
    ) {
      try {
        await input.persistSessionBindings?.({
          sessionId: input.request.sessionId,
          normalizedBindings: input.normalizedBindings,
          connectedServiceMaterializationIdentityV1,
        });
	      } catch {
	        input.tracked.spawnOptions = previousSpawnOptions;
	        return failureResult('metadata_update_failed', {
	          failurePhase: 'metadata',
	          diagnosticSource: input.diagnosticSource,
	        });
	      }
    }
    if (continuity.mode === 'hot_apply') {
      let hotApplyResult: Awaited<ReturnType<SwitchSessionConnectedServiceAuthInput['hotApply']>>;
      try {
        hotApplyResult = await input.hotApply({
          tracked: input.tracked,
          normalizedBindings: input.normalizedBindings,
          serviceIds: new Set([serviceId]),
          ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
        });
      } catch (error) {
        hotApplyResult = {
          ok: false,
          errorCode: 'hot_apply_failed',
          underlyingError: summarizeConnectedServiceSwitchApplyError(error),
        };
      }
      if (!hotApplyResult.ok) {
        if (
          hotApplyFailureRequiresRestart(hotApplyResult)
          && switchPolicyAllowsRestartResumeFallback(input.groupSwitchTriggerReason, runtimeAuthApply)
        ) {
          try {
            await input.restartSession(input.tracked);
	          } catch (error) {
	            input.tracked.spawnOptions = previousSpawnOptions;
	            return failureResult('restart_failed', {
	              ...buildRestartFailureOptions(error),
	              diagnosticSource: input.diagnosticSource,
	            });
	          }
          const restartServiceIds = new Set([serviceId]);
          const restartContinuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
            action: 'restart_requested',
            serviceIds: restartServiceIds,
            normalizedBindings: input.normalizedBindings,
            expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
          });
          const continuationOutcome = await runPostSwitchVerificationThenContinuation({
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
	            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
	            verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	            postSwitchVerificationMode: input.postSwitchVerificationMode,
	            diagnosticSource: input.diagnosticSource,
	            tracked: input.tracked,
            sessionId: input.request.sessionId,
            attemptId: restartContinuationAttemptId,
            normalizedBindings: input.normalizedBindings,
            agentId: input.trackedAgentId,
            nextByServiceId: input.nextByServiceId,
            serviceIds: restartServiceIds,
            action: 'restart_requested',
            switchReason: input.switchReason,
            ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
          });
	    if (continuationOutcome.failure) return continuationOutcome.failure;
          return {
            ok: true,
            action: 'restart_requested',
            normalizedBindings: input.normalizedBindings,
            continuityByServiceId: { [serviceId]: 'restart_rematerialize' },
            warnings: continuity.warnings ?? [],
            ...spreadPostSwitchVerification(continuationOutcome),
            ...spreadContinuityProofDiagnostics(continuity.diagnostics),
          };
        }
        input.tracked.spawnOptions = previousSpawnOptions;
	        return failureResult('hot_apply_failed', {
	          serviceId: hotApplyResult.serviceId ?? serviceId,
	          continuityByServiceId: { [serviceId]: continuity.mode },
	          failurePhase: 'hot_apply',
	          diagnosticSource: input.diagnosticSource,
	          partialState: readHotApplyFailurePartialState(hotApplyResult.serviceResultsByServiceId),
          serviceResultsByServiceId: hotApplyResult.serviceResultsByServiceId,
          ...(hotApplyResult.underlyingError
            ? { underlyingError: sanitizeConnectedServiceSwitchUnderlyingError(hotApplyResult.underlyingError) }
            : {}),
        });
      }
      input.registerHotApplyTargets(
        input.tracked,
        runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : undefined,
      );
      const continuationOutcome = await runPostSwitchVerificationThenContinuation({
        recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
	        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
	        verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	        postSwitchVerificationMode: input.postSwitchVerificationMode,
	        diagnosticSource: input.diagnosticSource,
	        tracked: input.tracked,
        sessionId: input.request.sessionId,
        attemptId: continuationAttemptId,
        normalizedBindings: input.normalizedBindings,
        agentId: input.trackedAgentId,
        nextByServiceId: input.nextByServiceId,
        serviceIds,
        action: 'hot_applied',
        switchReason: input.switchReason,
        ...(hotApplyResult.verificationByServiceId
          ? { acceptedVerificationByServiceId: hotApplyResult.verificationByServiceId }
          : {}),
        ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
      });
      if (continuationOutcome.failure) {
        if (
          isRetryableHotApplyPostSwitchVerificationFailure(continuationOutcome.failure)
          && switchPolicyAllowsRestartResumeFallback(input.groupSwitchTriggerReason, runtimeAuthApply)
        ) {
          const restartServiceIds = new Set([serviceId]);
          const restartContinuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
            action: 'restart_requested',
            serviceIds: restartServiceIds,
            normalizedBindings: input.normalizedBindings,
            expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
          });
          const restartContinuationFailure = await restartAfterRetryableHotApplyVerificationFailure({
            restartSession: input.restartSession,
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
	            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
	            verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	            postSwitchVerificationMode: input.postSwitchVerificationMode,
	            diagnosticSource: input.diagnosticSource,
	            tracked: input.tracked,
            sessionId: input.request.sessionId,
            attemptId: restartContinuationAttemptId,
            normalizedBindings: input.normalizedBindings,
            agentId: input.trackedAgentId,
            nextByServiceId: input.nextByServiceId,
            serviceIds: restartServiceIds,
            action: 'restart_requested',
            switchReason: input.switchReason,
            ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
          });
	          if (restartContinuationFailure.failure) {
	            return withSwitchAttemptedAction(restartContinuationFailure.failure, 'hot_applied');
	          }
          return {
            ok: true,
            action: 'restart_requested',
            normalizedBindings: input.normalizedBindings,
            continuityByServiceId: { [serviceId]: 'restart_rematerialize' },
            warnings: continuity.warnings ?? [],
            ...spreadPostSwitchVerification(restartContinuationFailure),
            ...spreadContinuityProofDiagnostics(continuity.diagnostics),
          };
        }
        return continuationOutcome.failure;
      }
      return {
        ok: true,
        action: 'hot_applied',
        normalizedBindings: input.normalizedBindings,
        continuityByServiceId: { [serviceId]: continuity.mode },
        warnings: continuity.warnings ?? [],
        ...spreadPostSwitchVerification(continuationOutcome),
        ...spreadContinuityProofDiagnostics(continuity.diagnostics),
      };
    }

    if (input.diagnosticSource === 'runtime_auth_recovery') {
      return {
        ok: true,
        action: 'metadata_updated',
        normalizedBindings: input.normalizedBindings,
        continuityByServiceId: { [serviceId]: continuity.mode },
        warnings: continuity.warnings ?? [],
        ...spreadContinuityProofDiagnostics(continuity.diagnostics),
      };
    }

    await input.restartSession(input.tracked);
    const continuationOutcome = await runPostSwitchVerificationThenContinuation({
      recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
	    continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
	    verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	    postSwitchVerificationMode: input.postSwitchVerificationMode,
	    diagnosticSource: input.diagnosticSource,
	    tracked: input.tracked,
      sessionId: input.request.sessionId,
      attemptId: continuationAttemptId,
      normalizedBindings: input.normalizedBindings,
      agentId: input.trackedAgentId,
      nextByServiceId: input.nextByServiceId,
      serviceIds,
      action: 'restart_requested',
      switchReason: input.switchReason,
      ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
    });
	    if (continuationOutcome.failure) return continuationOutcome.failure;
    return {
      ok: true,
      action: 'restart_requested',
      normalizedBindings: input.normalizedBindings,
      continuityByServiceId: { [serviceId]: continuity.mode },
      warnings: continuity.warnings ?? [],
      ...spreadPostSwitchVerification(continuationOutcome),
      ...spreadContinuityProofDiagnostics(continuity.diagnostics),
    };
  } catch (error) {
    input.tracked.spawnOptions = previousSpawnOptions;
	    return failureResult(
	      continuity.mode === 'hot_apply' ? 'hot_apply_failed' : 'restart_failed',
	      continuity.mode === 'hot_apply'
	        ? {
	            failurePhase: 'hot_apply',
	            diagnosticSource: input.diagnosticSource,
	            underlyingError: summarizeConnectedServiceSwitchApplyError(error),
	          }
	        : {
	            ...buildRestartFailureOptions(error),
	            diagnosticSource: input.diagnosticSource,
	          },
	    );
  }
}

export async function switchSessionConnectedServiceAuth(
  input: SwitchSessionConnectedServiceAuthInput,
): Promise<SessionConnectedServiceAuthSwitchResult> {
  const diagnosticSource = resolveSwitchUxDiagnosticSource(input.switchReason);
  const continueAfterRuntimeAuthSwitch = input.executionPolicy?.allowContinuation === false
    ? undefined
    : input.continueAfterRuntimeAuthSwitch;
  const execute = async (
    authoritativeGroupTargetRetriesRemaining = 1,
  ): Promise<SessionConnectedServiceAuthSwitchResult> => {
      const tracked = findTrackedSession(input.getChildren(), input.request.sessionId);
      if (!tracked) {
        const inactive = await input.resolveInactiveSession?.({ sessionId: input.request.sessionId }) ?? null;
        if (!inactive) return { ok: false, errorCode: 'session_not_found' };
        if (input.request.agentId.trim() !== inactive.agentId) {
          return { ok: false, errorCode: 'agent_mismatch' };
        }

	        const normalized = await normalizeRequestedBindings({
	          api: input.api,
	          agentId: inactive.agentId,
	          request: input.request,
	          diagnosticSource,
	          dryRun: input.dryRun === true,
	        });
        if (!normalized.ok) return normalized;

        const previousByServiceId = previousEffectiveBindings(inactive.connectedServices);
        const previousBindings = readConnectedServiceBindingsOrEmpty(inactive.connectedServices);
        const nextByServiceId = resolveNextEffectiveBindings({
          previousByServiceId,
          requestedByServiceId: normalized.effectiveByServiceId,
        });
        const changedServiceIds = Array.from(nextByServiceId.entries())
          .filter(([serviceId, next]) => effectiveBindingChanged(previousByServiceId.get(serviceId) ?? null, next))
          .map(([serviceId]) => serviceId);

        if (changedServiceIds.length === 0) {
          return {
            ok: true,
            action: 'unchanged',
            normalizedBindings: normalized.normalized,
            continuityByServiceId: {},
            warnings: [],
          };
        }

        const continuityByServiceId: Record<string, SessionConnectedServiceSwitchContinuity['mode']> = {};
        const warnings: string[] = [];
        let continuityProofDiagnostics: ConnectedServiceResumeContinuityProofDiagnostics | null = null;
        const connectedServiceMaterializationIdentityV1 = resolveMaterializationIdentityForAcceptedBindings({
          existingIdentity: inactive.connectedServiceMaterializationIdentityV1,
          normalizedBindings: normalized.normalized,
        });
        for (const serviceId of changedServiceIds) {
          const next = nextByServiceId.get(serviceId);
          if (!next) continue;
          const continuity = await input.resolveContinuity({
            tracked: null,
            sessionId: input.request.sessionId,
            agentId: inactive.agentId,
            serviceId,
            previous: previousByServiceId.get(serviceId) ?? null,
            next,
            previousBindings,
            normalizedBindings: normalized.normalized,
            ...(connectedServiceMaterializationIdentityV1
              ? { connectedServiceMaterializationIdentityV1 }
              : {}),
            ...(typeof inactive.vendorResumeId === 'string' && inactive.vendorResumeId.trim()
              ? { vendorResumeId: inactive.vendorResumeId.trim() }
              : {}),
            // Inactive switch (tracked=null): forward the session cwd + persisted hint so the daemon
            // adapter can reconstruct the target materialized root and prove resume reachability.
            ...(typeof inactive.cwd === 'string' && inactive.cwd.trim()
              ? { cwd: inactive.cwd.trim() }
              : {}),
            ...(typeof inactive.candidatePersistedSessionFile === 'string' && inactive.candidatePersistedSessionFile.trim()
              ? { candidatePersistedSessionFile: inactive.candidatePersistedSessionFile.trim() }
              : {}),
          });
          continuityByServiceId[serviceId] = continuity.mode;
          warnings.push(...(continuity.warnings ?? []));
          if (continuity.mode === 'unsupported') {
	            return failureResult(continuity.errorCode, {
	              serviceId,
	              failurePhase: 'continuity',
	              diagnosticSource,
	              ...(continuity.diagnostics ? { continuity: continuity.diagnostics } : {}),
	            });
          }
          // INC-6: keep the proven continuity context for success-result telemetry.
          continuityProofDiagnostics ??= continuity.diagnostics ?? null;
        }

        try {
          await input.persistSessionBindings?.({
            sessionId: input.request.sessionId,
            normalizedBindings: normalized.normalized,
            ...(connectedServiceMaterializationIdentityV1
              ? { connectedServiceMaterializationIdentityV1 }
              : {}),
          });
        } catch {
	          return failureResult('metadata_update_failed', { failurePhase: 'metadata', diagnosticSource });
        }

        emitManualSwitchEvents({
          emitSessionEvent: input.emitSessionEvent,
          sessionId: input.request.sessionId,
          previousByServiceId,
          nextByServiceId,
          fromProfileIdOverrideByServiceId: input.emitFromProfileIdByServiceId,
          reason: input.sessionEventReason ?? 'manual',
          mode: 'spawn_next_turn',
        });

        return {
          ok: true,
          action: 'metadata_updated',
          normalizedBindings: normalized.normalized,
          continuityByServiceId,
          warnings,
          ...spreadContinuityProofDiagnostics(continuityProofDiagnostics),
        };
      }

      const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
      if (input.request.agentId.trim() !== trackedAgentId) {
        return { ok: false, errorCode: 'agent_mismatch' };
      }

	      const normalized = await normalizeRequestedBindings({
	        api: input.api,
	        agentId: trackedAgentId,
	        request: input.request,
	        diagnosticSource,
	        dryRun: input.dryRun === true,
	      });
      if (!normalized.ok) return normalized;

      const previousBindings = readConnectedServiceBindingsOrEmpty(
        resolveTrackedConnectedServiceBindingsRaw(tracked),
      );
      const previousByServiceId = previousEffectiveBindings(previousBindings);
      const nextByServiceId = resolveNextEffectiveBindings({
        previousByServiceId,
        requestedByServiceId: normalized.effectiveByServiceId,
      });
      const changedServiceIds = Array.from(nextByServiceId.entries())
        .filter(([serviceId, next]) => effectiveBindingChanged(previousByServiceId.get(serviceId) ?? null, next))
        .map(([serviceId]) => serviceId);

      if (changedServiceIds.length === 0) {
        const rematerialized = await rematerializeUnchangedConnectedServiceBinding({
          request: input.request,
          // The unchanged-binding rematerialize path is the exact shape a pre-turn group member
          // switch takes (binding stays `group`, only the generation moves). The switch reason MUST
          // reach its continuation calls so `pre_turn_group_policy` replay suppression engages (F5).
          switchReason: input.switchReason,
          groupSwitchTriggerReason: input.groupSwitchTriggerReason,
          tracked,
          trackedAgentId,
          previousByServiceId,
          nextByServiceId,
          normalizedBindings: normalized.normalized,
          groupMetadataByServiceId: normalized.groupMetadataByServiceId,
          resolveContinuity: input.resolveContinuity,
          materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
          runtimeAuthApplyCapabilityResolver: input.runtimeAuthApplyCapabilityResolver,
          restartSession: input.restartSession,
          hotApply: input.hotApply,
          persistSessionBindings: input.persistSessionBindings,
          recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
          continueAfterRuntimeAuthSwitch,
          verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
          postSwitchVerificationMode: input.postSwitchVerificationMode,
          diagnosticSource,
          registerHotApplyTargets: input.registerHotApplyTargets,
          expectedCredentialRevisionByServiceId: input.expectedCredentialRevisionByServiceId,
          dryRun: input.dryRun,
        });
        if (rematerialized) {
          if (
            input.dryRun !== true
            && authoritativeGroupTargetRetriesRemaining > 0
            && isAuthoritativeGroupTargetSupersededMaterializationFailure(rematerialized)
          ) {
            return await execute(authoritativeGroupTargetRetriesRemaining - 1);
          }
          return rematerialized;
        }
        return {
          ok: true,
          action: 'unchanged',
          normalizedBindings: normalized.normalized,
          continuityByServiceId: {},
          warnings: [],
        };
      }

      const continuityByServiceId: Record<string, SessionConnectedServiceSwitchContinuity['mode']> = {};
      const warnings: string[] = [];
      let allChangedServicesHotApply = true;
      let continuityProofDiagnostics: ConnectedServiceResumeContinuityProofDiagnostics | null = null;
      const runtimeAuthSelectionsByServiceId = new Map<ConnectedServiceId, unknown>();
      const runtimeAuthApplyByServiceId = new Map<ConnectedServiceId, ConnectedServiceRuntimeAuthApplyCapability | null>();
      const previousSpawnOptions = tracked.spawnOptions;
      const connectedServiceMaterializationIdentityV1 = resolveMaterializationIdentityForAcceptedBindings({
        existingIdentity: previousSpawnOptions?.connectedServiceMaterializationIdentityV1,
        normalizedBindings: normalized.normalized,
      });
      const trackedVendorResumeId = resolveTrackedVendorResumeId({
        agentId: trackedAgentId,
        tracked,
      });
      for (const serviceId of changedServiceIds) {
        const next = nextByServiceId.get(serviceId);
        if (!next) continue;
        const previous = previousByServiceId.get(serviceId) ?? null;
        const runtimeAuthApply = await resolveRuntimeAuthApplyCapabilityForSwitch({
          resolver: input.runtimeAuthApplyCapabilityResolver,
          tracked,
          sessionId: input.request.sessionId,
          agentId: trackedAgentId,
          serviceId,
        });
        runtimeAuthApplyByServiceId.set(serviceId, runtimeAuthApply);
        const runtimeAuthSelection = await maybeMaterializeRuntimeAuthSelection({
          materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
          tracked,
          sessionId: input.request.sessionId,
          agentId: trackedAgentId,
          serviceId,
          previous,
          next,
            previousBindings,
            normalizedBindings: normalized.normalized,
            groupMetadataByServiceId: normalized.groupMetadataByServiceId,
            mode: input.dryRun ? 'preflight' : 'apply',
            groupSwitchTriggerReason: input.groupSwitchTriggerReason,
            runtimeAuthApply,
            ...(input.expectedCredentialRevisionByServiceId?.[serviceId] === undefined
              ? {}
              : {
                  expectedCredentialRevision: input.expectedCredentialRevisionByServiceId[serviceId],
                }),
          });
        await awaitRuntimeAuthCredentialWriteCommitted(runtimeAuthSelection);
        const blockingMaterializationDiagnostics = readRuntimeAuthSelectionBlockingMaterializationDiagnostics(
          runtimeAuthSelection,
        );
        if (blockingMaterializationDiagnostics.length > 0) {
          if (
            input.dryRun !== true
            && authoritativeGroupTargetRetriesRemaining > 0
            && changedServiceIds.length === 1
            && next.selection === 'group'
            && blockingMaterializationDiagnostics.some(
              isAuthoritativeGroupTargetSupersededMaterializationDiagnostic,
            )
          ) {
            // The provider rejected this candidate before mutating its shared auth surface because
            // another writer advanced the group. Re-enter normalization once so every downstream
            // fact (binding, generation, profile, credential revision, and materialized home) comes
            // from the same newer server truth. The one-service bound prevents re-running a request
            // after any sibling service could already have produced an effect.
            return await execute(authoritativeGroupTargetRetriesRemaining - 1);
          }
          return buildRuntimeAuthMaterializationFailureResult({
            agentId: trackedAgentId,
            serviceId,
            next,
            diagnostics: blockingMaterializationDiagnostics,
            diagnosticSource,
          });
        }
        if (runtimeAuthSelection !== null && runtimeAuthSelection !== undefined) {
          runtimeAuthSelectionsByServiceId.set(serviceId, runtimeAuthSelection);
        }
        const continuity = await input.resolveContinuity({
          tracked,
          sessionId: input.request.sessionId,
          agentId: trackedAgentId,
          serviceId,
          previous,
          next,
          previousBindings,
          normalizedBindings: normalized.normalized,
          ...(runtimeAuthSelection === null || runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
          ...(connectedServiceMaterializationIdentityV1 ? { connectedServiceMaterializationIdentityV1 } : {}),
          ...(trackedVendorResumeId ? { vendorResumeId: trackedVendorResumeId } : {}),
        });
        continuityByServiceId[serviceId] = continuity.mode;
        warnings.push(...(continuity.warnings ?? []));
        if (continuity.mode === 'unsupported') {
          return failureResult(continuity.errorCode, {
            serviceId,
            failurePhase: 'continuity',
            diagnosticSource,
            ...(continuity.diagnostics ? { continuity: continuity.diagnostics } : {}),
          });
        }
        // INC-6: keep the proven continuity context (single changed service in practice; the first
        // proof wins for multi-service switches) for success-result telemetry.
        continuityProofDiagnostics ??= continuity.diagnostics ?? null;
        if (continuity.mode !== 'hot_apply') {
          allChangedServicesHotApply = false;
        }
      }

      let action: 'restart_requested' | 'hot_applied' | 'metadata_updated' = allChangedServicesHotApply
        ? 'hot_applied'
        : diagnosticSource === 'runtime_auth_recovery'
          ? 'metadata_updated'
          : 'restart_requested';
      if (action === 'restart_requested' && input.executionPolicy?.allowRestartResume === false) {
        return failureResult('restart_disallowed_by_execution_policy', {
          failurePhase: 'continuity',
          attemptedAction: 'restart_requested',
          retryable: true,
          diagnosticSource,
        });
      }
      const predictiveGate = gatePredictiveSoftSwitchBeforeSideEffects({
        groupSwitchTriggerReason: input.groupSwitchTriggerReason,
        sessionId: input.request.sessionId,
        prospectiveMode: action === 'hot_applied'
          ? 'hot_apply'
          : action === 'metadata_updated'
            ? 'spawn_next_turn'
            : 'restart_resume',
        attemptedAction: action,
        diagnosticSource,
        runtimeAuthApply: Array.from(runtimeAuthApplyByServiceId.values()).find((capability) => capability !== null) ?? null,
      });
      if (predictiveGate) return predictiveGate;
      if (input.dryRun) {
        return {
          ok: true,
          action,
          normalizedBindings: normalized.normalized,
          continuityByServiceId,
          warnings,
          ...spreadContinuityProofDiagnostics(continuityProofDiagnostics),
        };
      }
      const changedServiceIdSet = new Set<ConnectedServiceId>(changedServiceIds);
      const continuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
        action: action === 'metadata_updated' ? 'restart_requested' : action,
        serviceIds: changedServiceIdSet,
        normalizedBindings: normalized.normalized,
        expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
      });
      const postSwitchVerificationByServiceId: Record<string, AcceptedConnectedServiceAccountVerification> = {};

      const nextEnvironmentVariables = buildTrackedSessionEnvironmentVariables({
        existingEnvironmentVariables: previousSpawnOptions?.environmentVariables,
        normalizedBindings: normalized.normalized,
        ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
        groupMetadataByServiceId: normalized.groupMetadataByServiceId,
      });
      tracked.spawnOptions = {
        ...(tracked.spawnOptions ?? { directory: '' }),
        connectedServices: normalized.normalized,
        connectedServicesUpdatedAt: Date.now(),
        ...(connectedServiceMaterializationIdentityV1
          ? { connectedServiceMaterializationIdentityV1 }
          : {}),
        environmentVariables: nextEnvironmentVariables,
      };

      try {
        if (action === 'hot_applied') {
          try {
            await input.persistSessionBindings?.({
              sessionId: input.request.sessionId,
              normalizedBindings: normalized.normalized,
              ...(connectedServiceMaterializationIdentityV1
                ? { connectedServiceMaterializationIdentityV1 }
                : {}),
            });
          } catch {
            tracked.spawnOptions = previousSpawnOptions;
	            return failureResult('metadata_update_failed', { failurePhase: 'metadata', diagnosticSource });
          }
          let hotApplyResult: Awaited<ReturnType<SwitchSessionConnectedServiceAuthInput['hotApply']>>;
          try {
            hotApplyResult = await input.hotApply({
              tracked,
              normalizedBindings: normalized.normalized,
              serviceIds: new Set(changedServiceIds),
              ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
            });
          } catch (error) {
            hotApplyResult = {
              ok: false,
              errorCode: 'hot_apply_failed',
              underlyingError: summarizeConnectedServiceSwitchApplyError(error),
            };
          }
          if (!hotApplyResult.ok) {
            if (
              hotApplyFailureRequiresRestart(hotApplyResult)
              && input.executionPolicy?.allowRestartResume !== false
              && switchPolicyAllowsRestartResumeFallbackForServices({
                groupSwitchTriggerReason: input.groupSwitchTriggerReason,
                runtimeAuthApplyByServiceId,
                serviceIds: changedServiceIdSet,
                failedServiceId: hotApplyResult.serviceId,
              })
            ) {
              try {
                await input.restartSession(tracked);
              } catch (error) {
                const rolledBack = await rollbackPersistedSessionBindings({
                  persistSessionBindings: input.persistSessionBindings,
                  sessionId: input.request.sessionId,
                  previousBindings,
                  connectedServiceMaterializationIdentityV1,
                });
                tracked.spawnOptions = previousSpawnOptions;
                if (!rolledBack) {
	                  return failureResult('bindings_rollback_failed', {
	                    failurePhase: 'rollback',
	                    partialState: 'metadata_may_reference_new_binding',
	                    diagnosticSource,
	                  });
	                }
	                return failureResult('restart_failed', {
	                  ...buildRestartFailureOptions(error),
	                  diagnosticSource,
	                });
              }
              action = 'restart_requested';
              Object.assign(continuityByServiceId, markHotApplyContinuityAsRestart(continuityByServiceId));
              const restartContinuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
                action,
                serviceIds: changedServiceIdSet,
                normalizedBindings: normalized.normalized,
                expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
              });
              const continuationOutcome = await runPostSwitchVerificationThenContinuation({
                recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
                continueAfterRuntimeAuthSwitch,
	                verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	                postSwitchVerificationMode: input.postSwitchVerificationMode,
	                diagnosticSource,
	                tracked,
                sessionId: input.request.sessionId,
                attemptId: restartContinuationAttemptId,
                normalizedBindings: normalized.normalized,
                agentId: trackedAgentId,
                nextByServiceId,
                serviceIds: changedServiceIdSet,
                action,
                switchReason: input.switchReason,
                ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
              });
	              if (continuationOutcome.failure) {
	                return withSwitchAttemptedAction(continuationOutcome.failure, 'hot_applied');
	              }
              Object.assign(postSwitchVerificationByServiceId, continuationOutcome.verificationByServiceId ?? {});
            } else {
              const rolledBack = await rollbackPersistedSessionBindings({
                persistSessionBindings: input.persistSessionBindings,
                sessionId: input.request.sessionId,
                previousBindings,
                connectedServiceMaterializationIdentityV1,
              });
              tracked.spawnOptions = previousSpawnOptions;
              if (!rolledBack) {
	                return failureResult('bindings_rollback_failed', {
	                  failurePhase: 'rollback',
	                  partialState: 'metadata_may_reference_new_binding',
	                  diagnosticSource,
	                });
	              }
	              return failureResult('hot_apply_failed', {
	                serviceId: hotApplyResult.serviceId,
	                continuityByServiceId,
	                failurePhase: 'hot_apply',
	                diagnosticSource,
	                partialState: readHotApplyFailurePartialState(hotApplyResult.serviceResultsByServiceId),
                serviceResultsByServiceId: hotApplyResult.serviceResultsByServiceId,
                ...(hotApplyResult.underlyingError
                  ? { underlyingError: sanitizeConnectedServiceSwitchUnderlyingError(hotApplyResult.underlyingError) }
                  : {}),
              });
            }
          } else {
            input.registerHotApplyTargets(
              tracked,
              runtimeAuthSelectionsByServiceId.size === 0 ? undefined : { runtimeAuthSelectionsByServiceId },
            );
            const continuationOutcome = await runPostSwitchVerificationThenContinuation({
              recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
              continueAfterRuntimeAuthSwitch,
	              verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	              postSwitchVerificationMode: input.postSwitchVerificationMode,
	              diagnosticSource,
	              tracked,
              sessionId: input.request.sessionId,
              attemptId: continuationAttemptId,
              normalizedBindings: normalized.normalized,
              agentId: trackedAgentId,
              nextByServiceId,
              serviceIds: changedServiceIdSet,
              action: 'hot_applied',
              switchReason: input.switchReason,
              ...(hotApplyResult.verificationByServiceId
                ? { acceptedVerificationByServiceId: hotApplyResult.verificationByServiceId }
                : {}),
              ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
            });
            if (continuationOutcome.failure) {
              if (
                isRetryableHotApplyPostSwitchVerificationFailure(continuationOutcome.failure)
                && input.executionPolicy?.allowRestartResume !== false
                && switchPolicyAllowsRestartResumeFallbackForServices({
                groupSwitchTriggerReason: input.groupSwitchTriggerReason,
                runtimeAuthApplyByServiceId,
                serviceIds: changedServiceIdSet,
              })
              ) {
                action = 'restart_requested';
                Object.assign(continuityByServiceId, markHotApplyContinuityAsRestart(continuityByServiceId));
                const restartContinuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
                  action,
                  serviceIds: changedServiceIdSet,
                  normalizedBindings: normalized.normalized,
                  expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
                });
                const restartContinuationFailure = await restartAfterRetryableHotApplyVerificationFailure({
                  restartSession: input.restartSession,
                  recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
                  continueAfterRuntimeAuthSwitch,
	                  verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	                  postSwitchVerificationMode: input.postSwitchVerificationMode,
	                  diagnosticSource,
	                  tracked,
                  sessionId: input.request.sessionId,
                  attemptId: restartContinuationAttemptId,
                  normalizedBindings: normalized.normalized,
                  agentId: trackedAgentId,
                  nextByServiceId,
                  serviceIds: changedServiceIdSet,
                  action,
                  switchReason: input.switchReason,
                  ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
                });
	                if (restartContinuationFailure.failure) {
	                  return withSwitchAttemptedAction(restartContinuationFailure.failure, 'hot_applied');
	                }
                Object.assign(postSwitchVerificationByServiceId, restartContinuationFailure.verificationByServiceId ?? {});
              } else {
                return continuationOutcome.failure;
              }
            } else {
              Object.assign(postSwitchVerificationByServiceId, continuationOutcome.verificationByServiceId ?? {});
            }
          }
        } else {
          try {
            await input.persistSessionBindings?.({
              sessionId: input.request.sessionId,
              normalizedBindings: normalized.normalized,
              ...(connectedServiceMaterializationIdentityV1
                ? { connectedServiceMaterializationIdentityV1 }
                : {}),
            });
          } catch {
            tracked.spawnOptions = previousSpawnOptions;
	            return failureResult('metadata_update_failed', { failurePhase: 'metadata', diagnosticSource });
          }
          if (action === 'metadata_updated') {
            // Reactive runtime-auth recovery owns the actual deferred restart + continuation. The
            // switch primitive commits the new materialized selection and returns immediately so the
            // daemon route is not held open until the current turn reaches a restart boundary.
          } else {
          try {
            await input.restartSession(tracked);
          } catch (error) {
            const rolledBack = await rollbackPersistedSessionBindings({
              persistSessionBindings: input.persistSessionBindings,
              sessionId: input.request.sessionId,
              previousBindings,
              connectedServiceMaterializationIdentityV1,
            });
            tracked.spawnOptions = previousSpawnOptions;
            if (!rolledBack) {
	              return failureResult('bindings_rollback_failed', {
	                failurePhase: 'rollback',
	                partialState: 'metadata_may_reference_new_binding',
	                diagnosticSource,
	              });
	            }
	            return failureResult('restart_failed', {
	              ...buildRestartFailureOptions(error),
	              diagnosticSource,
	            });
	          }
	          const continuationOutcome = await runPostSwitchVerificationThenContinuation({
	            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
	            continueAfterRuntimeAuthSwitch,
	            verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
	            postSwitchVerificationMode: input.postSwitchVerificationMode,
	            diagnosticSource,
	            tracked,
            sessionId: input.request.sessionId,
            attemptId: continuationAttemptId,
            normalizedBindings: normalized.normalized,
            agentId: trackedAgentId,
            nextByServiceId,
            serviceIds: changedServiceIdSet,
            action: 'restart_requested',
            switchReason: input.switchReason,
            ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
          });
          if (continuationOutcome.failure) return continuationOutcome.failure;
          Object.assign(postSwitchVerificationByServiceId, continuationOutcome.verificationByServiceId ?? {});
          }
        }
      } catch (error) {
        tracked.spawnOptions = previousSpawnOptions;
        return failureResult(
          action === 'hot_applied' ? 'hot_apply_failed' : 'restart_failed',
	          action === 'hot_applied'
	            ? {
	                failurePhase: 'hot_apply',
	                diagnosticSource,
	                // Surface the provider's error (e.g. the Codex app-server account/login/start RPC code +
                // message) so a swallowed hot_apply_failed is diagnosable in the switch-result log.
                underlyingError: summarizeConnectedServiceSwitchApplyError(error),
              }
	            : {
	                ...buildRestartFailureOptions(error),
	                diagnosticSource,
	              },
	        );
      }

      emitManualSwitchEvents({
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.request.sessionId,
      previousByServiceId,
      nextByServiceId,
      fromProfileIdOverrideByServiceId: input.emitFromProfileIdByServiceId,
        reason: input.sessionEventReason ?? input.groupSwitchTriggerReason ?? 'manual',
        mode: action === 'hot_applied'
          ? 'hot_apply'
          : action === 'metadata_updated'
            ? 'spawn_next_turn'
            : 'restart_resume',
      });

      return {
        ok: true,
        action,
        normalizedBindings: normalized.normalized,
        continuityByServiceId,
        warnings,
        ...spreadPostSwitchVerification({ verificationByServiceId: postSwitchVerificationByServiceId }),
        ...spreadContinuityProofDiagnostics(continuityProofDiagnostics),
      };
  };
	  const result = await runSerializedConnectedServiceTransition({
	    core: input.core,
	    transitionLockMode: input.transitionLockMode,
    sessionId: input.request.sessionId,
    reason: input.switchReason ?? 'manual',
    execute,
  });
  if (!input.dryRun) {
    emitConnectedServiceSwitchAttemptEvent({
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.request.sessionId,
      result,
      groupSwitchTriggerReason: input.groupSwitchTriggerReason,
    });
    emitProviderStateSharingDegradedEvents({
      tracked: findTrackedSession(input.getChildren(), input.request.sessionId),
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.request.sessionId,
      result,
    });
  }
  return result;
}
