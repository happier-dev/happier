import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceUxDiagnosticCodeV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceMaterializationIdentityV1Schema,
  type ConnectedServiceUxDiagnosticV1,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import { AGENTS_CORE } from '@happier-dev/agents';

import type { CatalogAgentId, ConnectedServiceResumeContinuityDiagnostics } from '@/backends/types';
import { resolveDaemonCatalogAgentIdFromBackendTarget } from '@/daemon/backendTargetRouting';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceAccountTransitionVerificationResult } from '../runtimeAuth/types';
import { buildConnectedServiceUxDiagnostic } from '@/daemon/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  generateConnectedServiceMaterializationIdentityV1,
  readConnectedServiceMaterializationIdentityFromSpawnOptions,
} from '@/daemon/connectedServices/materialization/identity';
import {
  collectBlockingConnectedServicesMaterializationDiagnostics,
  type ConnectedServicesMaterializationDiagnostic,
} from '@/daemon/connectedServices/materialization/materializer';

import {
  resolveConnectedServiceSessionAuthSwitchActor,
  type ConnectedServiceSessionAuthSwitchActor,
  type ConnectedServiceSessionAuthSwitchCore,
  type ConnectedServiceSessionAuthSwitchReason,
} from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { sanitizeConnectedServiceDiagnosticString } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import type { SessionConnectedServiceAuthSwitchServiceResult } from './sessionConnectedServiceAuthHotApply';
import type { ConnectedServiceTransitionLockMode } from './locking/connectedServiceTransitionLockMode';
import { runSerializedConnectedServiceTransition } from './locking/runSerializedConnectedServiceTransition';
import { buildConnectedServiceSwitchContinuationAttemptId } from './buildConnectedServiceSwitchContinuationAttemptId';
import { resolveTrackedConnectedServiceVendorResumeId } from './resolveTrackedConnectedServiceSwitchContinuityContext';
import { isConnectedServiceRestartSignalStaleProcessError } from './requestConnectedServiceSessionRestartSignal';
import { resolveSwitchUxDiagnosticSource } from './resolveSwitchUxDiagnosticSource';
import {
  type AcceptedConnectedServiceAccountVerification,
  type AcceptedConnectedServiceAccountVerificationByServiceId,
} from '../accountTransitions/acceptedConnectedServiceAccountVerification';
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

function mergePostSwitchVerification(
  target: AcceptedConnectedServiceAccountVerificationByServiceId,
  outcome: Pick<SessionConnectedServiceAuthSwitchPostSwitchOutcome, 'verificationByServiceId'>,
): void {
  if (!outcome.verificationByServiceId) return;
  Object.assign(target, outcome.verificationByServiceId);
}
type PublicConnectedServiceResumeContinuityDiagnostics = Pick<
  ConnectedServiceResumeContinuityDiagnostics,
  'requestedStateMode' | 'effectiveStateMode' | 'reachabilityMissReason'
>;
type PreviousConnectedServiceChildSelection =
  NonNullable<ReturnType<typeof readConnectedServiceChildSelectionsFromEnv>> extends ReadonlyMap<string, infer V>
    ? V
    : never;
type NextConnectedServiceChildSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
	    }>;

type ConnectedServiceAccountSwitchMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';
type ConnectedServiceSwitchAttemptAction = 'restart_requested' | 'hot_applied' | 'metadata_updated';

export type SessionConnectedServiceAuthSwitchErrorCode =
  | 'session_not_found'
  | 'agent_mismatch'
  | 'unsupported_service'
  | 'profile_missing'
  | 'profile_disconnected'
  | 'profile_action_required'
  | 'group_missing'
  | 'group_generation_conflict'
  | 'provider_state_sharing_required'
  | 'provider_state_sharing_unavailable'
  | 'provider_state_sharing_settings_unavailable'
  | 'provider_session_state_unavailable_for_resume'
  | 'metadata_update_failed'
  | 'restart_failed'
  | 'hot_apply_failed'
  | 'hot_apply_succeeded_but_recovery_failed'
  | 'provider_account_adoption_mismatch'
  | 'post_switch_verification_failed'
  | 'partial_applied_pending_reconciliation';

export type SessionConnectedServiceAuthSwitchDiagnostics = Readonly<{
  failurePhase?:
    | 'session_lookup'
    | 'agent_validation'
    | 'normalization'
    | 'continuity'
    | 'materialization'
    | 'metadata'
    | 'restart'
    | 'hot_apply'
    | 'post_switch_verification'
    | 'recover'
    | 'reconciliation';
  retryable?: boolean;
  verification?: Readonly<{
    expectedProviderAccountId?: string | null;
    actualProviderAccountId?: string | null;
    reason?: string;
    errorClassification?: unknown;
  }>;
  continuity?: PublicConnectedServiceResumeContinuityDiagnostics;
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
  attemptedAction?: ConnectedServiceSwitchAttemptAction;
  application?: SessionConnectedServiceAuthSwitchApplicationState;
  rollback?: SessionConnectedServiceAuthSwitchRollbackDiagnostic;
  accountSettingsFreshness?: Readonly<{
    requestedVersion: number | null;
    status: 'succeeded' | 'failed';
    error?: string;
  }>;
  underlyingError?: string;
  serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
  actionRequired?: Readonly<{
    kind: 'reconnect_profile';
    profileId: string;
    healthStatus: 'needs_reauth';
  }>;
}>;

export type SessionConnectedServiceAuthSwitchApplicationState = Readonly<{
  status:
    | 'hot_apply_failed'
    | 'restart_failed'
    | 'recover_failed'
    | 'hot_apply_succeeded_but_recovery_failed'
    | 'partial_applied_pending_reconciliation';
  phase: 'hot_apply' | 'restart' | 'recover';
  actor: ConnectedServiceSessionAuthSwitchActor;
  reason: ConnectedServiceSessionAuthSwitchReason;
}>;

export type SessionConnectedServiceAuthSwitchRollbackDiagnostic = Readonly<{
  status: 'bindings_rollback_failed';
  pendingReconciliation: true;
}>;

export type SessionConnectedServiceSwitchContinuity =
  | Readonly<{ mode: 'restart_rematerialize'; warnings?: readonly string[] }>
  | Readonly<{ mode: 'hot_apply'; warnings?: readonly string[] }>
  | Readonly<{
      mode: 'unsupported';
      errorCode: Extract<
        SessionConnectedServiceAuthSwitchErrorCode,
        | 'provider_state_sharing_required'
        | 'provider_state_sharing_unavailable'
        | 'provider_state_sharing_settings_unavailable'
        | 'provider_session_state_unavailable_for_resume'
        | 'unsupported_service'
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
    }>
  | Readonly<{
      ok: false;
      errorCode: SessionConnectedServiceAuthSwitchErrorCode;
      serviceId?: string;
      diagnostics?: SessionConnectedServiceAuthSwitchDiagnostics;
    }>;

function failureResult(
  errorCode: SessionConnectedServiceAuthSwitchErrorCode,
  options: Readonly<{
	    serviceId?: string;
	    failurePhase?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['failurePhase']>;
	    application?: SessionConnectedServiceAuthSwitchApplicationState;
	    rollback?: SessionConnectedServiceAuthSwitchRollbackDiagnostic;
	    serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
	    actionRequired?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['actionRequired']>;
	    underlyingError?: string;
	    retryable?: boolean;
	    verification?: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['verification']>;
	    continuity?: ConnectedServiceResumeContinuityDiagnostics;
	    diagnosticSource?: ConnectedServiceUxDiagnosticV1['source'];
	    attemptedAction?: ConnectedServiceSwitchAttemptAction;
	  }> = {},
		): SessionConnectedServiceAuthSwitchFailure {
  const uxDiagnosticCode = resolveSwitchUxDiagnosticCode(errorCode);
  const sanitizedUnderlyingError = options.underlyingError
    ? sanitizeConnectedServiceSwitchUnderlyingError(options.underlyingError)
    : undefined;
  const sanitizedVerification = options.verification
    ? {
        ...options.verification,
        ...(options.verification.reason
          ? { reason: sanitizeConnectedServiceDiagnosticString(options.verification.reason) }
          : {}),
      }
    : undefined;
  const safeContinuity = options.continuity
    ? {
        requestedStateMode: options.continuity.requestedStateMode,
        effectiveStateMode: options.continuity.effectiveStateMode,
        reachabilityMissReason: sanitizeConnectedServiceDiagnosticString(options.continuity.reachabilityMissReason),
      }
    : undefined;
  const uxDiagnosticSafeDetails = {
    ...(sanitizedVerification?.reason ? { reason: sanitizedVerification.reason } : {}),
    ...(options.actionRequired?.kind ? { actionRequired: options.actionRequired.kind } : {}),
    ...(safeContinuity?.reachabilityMissReason ? { reason: safeContinuity.reachabilityMissReason } : {}),
  };
  const uxDiagnosticFailurePhase = options.failurePhase
    ? resolveConnectedServiceUxDiagnosticFailurePhase(options.failurePhase)
    : null;
		  const diagnostics = options.failurePhase || options.application || options.rollback || options.serviceResultsByServiceId || options.actionRequired || sanitizedUnderlyingError || options.retryable !== undefined || sanitizedVerification || options.continuity || uxDiagnosticCode || options.attemptedAction
	    ? {
	      ...(options.failurePhase ? { failurePhase: options.failurePhase } : {}),
	      ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
	      ...(sanitizedVerification ? { verification: sanitizedVerification } : {}),
		      ...(safeContinuity ? { continuity: safeContinuity } : {}),
	      ...(options.attemptedAction ? { attemptedAction: options.attemptedAction } : {}),
	      ...(options.application ? { application: options.application } : {}),
	      ...(options.rollback ? { rollback: options.rollback } : {}),
	      ...(options.serviceResultsByServiceId ? { serviceResultsByServiceId: options.serviceResultsByServiceId } : {}),
	      ...(options.actionRequired ? { actionRequired: options.actionRequired } : {}),
	      ...(sanitizedUnderlyingError ? { underlyingError: sanitizedUnderlyingError } : {}),
        ...(uxDiagnosticCode && uxDiagnosticFailurePhase
          ? {
              uxDiagnostic: buildConnectedServiceUxDiagnostic({
                code: uxDiagnosticCode,
                failurePhase: uxDiagnosticFailurePhase,
                source: options.diagnosticSource ?? resolveSwitchUxDiagnosticSource(undefined),
                ...(options.serviceId ? { serviceId: options.serviceId } : {}),
                retryable: options.retryable === true,
                ...(Object.keys(uxDiagnosticSafeDetails).length > 0
                  ? { diagnostics: uxDiagnosticSafeDetails }
                  : {}),
              }),
            }
          : {}),
	    }
	    : undefined;
  return {
    ok: false,
    errorCode,
    ...(options.serviceId ? { serviceId: options.serviceId } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function withSwitchAttemptedAction(
  failure: SessionConnectedServiceAuthSwitchFailure,
  attemptedAction: ConnectedServiceSwitchAttemptAction,
): SessionConnectedServiceAuthSwitchFailure {
  return {
    ...failure,
    diagnostics: {
      ...(failure.diagnostics ?? {}),
      attemptedAction,
    },
  };
}

function resolveConnectedServiceUxDiagnosticFailurePhase(
  failurePhase: NonNullable<SessionConnectedServiceAuthSwitchDiagnostics['failurePhase']>,
): ConnectedServiceUxDiagnosticV1['failurePhase'] | null {
  switch (failurePhase) {
    case 'session_lookup':
    case 'agent_validation':
    case 'normalization':
    case 'continuity':
    case 'materialization':
    case 'metadata':
    case 'restart':
    case 'hot_apply':
    case 'post_switch_verification':
      return failurePhase;
    case 'recover':
    case 'reconciliation':
      return null;
  }
}

function resolveSwitchUxDiagnosticCode(
  errorCode: SessionConnectedServiceAuthSwitchErrorCode,
): ConnectedServiceUxDiagnosticV1['code'] | null {
  switch (errorCode) {
    case 'provider_session_state_unavailable_for_resume':
      return CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume;
    case 'metadata_update_failed':
      return CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed;
    case 'provider_account_adoption_mismatch':
      return CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch;
    case 'post_switch_verification_failed':
      return CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed;
    default:
      return null;
  }
}

function applicationFailure(
  reason: ConnectedServiceSessionAuthSwitchReason,
  phase: SessionConnectedServiceAuthSwitchApplicationState['phase'],
  status?: SessionConnectedServiceAuthSwitchApplicationState['status'],
): SessionConnectedServiceAuthSwitchApplicationState {
  return {
    status: status ?? (phase === 'hot_apply'
      ? 'hot_apply_failed'
      : phase === 'restart'
      ? 'restart_failed'
      : 'recover_failed'),
    phase,
    actor: resolveConnectedServiceSessionAuthSwitchActor(reason),
    reason,
  };
}

function restartFailure(
  reason: ConnectedServiceSessionAuthSwitchReason,
  error: unknown,
): Parameters<typeof failureResult>[1] {
  return {
    failurePhase: 'restart',
    application: applicationFailure(reason, 'restart'),
    underlyingError: summarizeConnectedServiceSwitchApplyError(error),
    ...(isConnectedServiceRestartSignalStaleProcessError(error) ? { retryable: true } : {}),
  };
}

function hotApplySucceededButRecoveryFailed(
  reason: ConnectedServiceSessionAuthSwitchReason,
): SessionConnectedServiceAuthSwitchFailure {
  return failureResult('hot_apply_succeeded_but_recovery_failed', {
    failurePhase: 'recover',
    application: applicationFailure(reason, 'recover', 'hot_apply_succeeded_but_recovery_failed'),
  });
}

function partialAppliedPendingReconciliation(input: Readonly<{
  reason: ConnectedServiceSessionAuthSwitchReason;
  phase: Extract<SessionConnectedServiceAuthSwitchApplicationState['phase'], 'hot_apply' | 'restart'>;
  rollback: SessionConnectedServiceAuthSwitchRollbackDiagnostic;
}>): SessionConnectedServiceAuthSwitchFailure {
  return failureResult('partial_applied_pending_reconciliation', {
    failurePhase: 'reconciliation',
    application: applicationFailure(input.reason, input.phase, 'partial_applied_pending_reconciliation'),
    rollback: input.rollback,
  });
}

function isPostSwitchRecoveryFailure(result: Readonly<{ ok: false; errorCode?: string }>): boolean {
  return result.errorCode === 'post_switch_recovery_failed';
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
      status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable';
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

export type SessionConnectedServiceRuntimeAuthSelectionMaterializerInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previous: EffectiveBinding | null;
  next: EffectiveBinding;
  previousBindings: ConnectedServiceBindingsV1;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadata?: ConnectedServiceGroupRuntimeMetadata;
}>;

export type SwitchContinuationRecoveryInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
}>;
export type SwitchPostAuthRecoveryInput = Readonly<Omit<SwitchContinuationRecoveryInput, 'attemptId'>>;
type SwitchPostAuthRecoveryResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode?: string }>;

export type SwitchSessionConnectedServiceAuthInput = Readonly<{
  core: ConnectedServiceSessionAuthSwitchCore;
  transitionLockMode?: ConnectedServiceTransitionLockMode;
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
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    runtimeAuthSelection?: unknown;
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
  restartSession(tracked: TrackedSession): Promise<void>;
	  hotApply(input: Readonly<{
	    tracked: TrackedSession;
	    normalizedBindings: ConnectedServiceBindingsV1;
	    serviceIds?: ReadonlySet<ConnectedServiceId>;
	    runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
	  }>): Promise<
	    | Readonly<{ ok: true }>
	    | Readonly<{
	        ok: false;
	        errorCode?: string;
	        serviceId?: ConnectedServiceId;
	        serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
	        underlyingError?: string;
	      }>
	  >;
  persistSessionBindings?(input: Readonly<{
    sessionId: string;
    normalizedBindings: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  }>): Promise<void>;
  recoverAfterRuntimeAuthSwitch?(input: SwitchPostAuthRecoveryInput): Promise<SwitchPostAuthRecoveryResult>;
  continueAfterRuntimeAuthSwitch?(input: SwitchContinuationRecoveryInput): Promise<void>;
  verifyProviderAccountAdoption?(input: Readonly<{
    tracked: TrackedSession;
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    target: Readonly<{
      serviceId: ConnectedServiceId;
      profileId: string | null;
      groupId?: string | null;
    }>;
    normalizedBindings: ConnectedServiceBindingsV1;
    action: 'hot_applied' | 'restart_requested';
    runtimeAuthSelection?: unknown;
  }>): Promise<ConnectedServiceAccountTransitionVerificationResult>;
  postSwitchVerificationMode?: Readonly<{
    kind: 'disabled_for_test_only';
    reason: string;
  }>;
  registerHotApplyTargets(tracked: TrackedSession): void;
  emitSessionEvent(sessionId: string, event: unknown): void;
  reason?: ConnectedServiceSessionAuthSwitchReason;
  request: SessionConnectedServiceAuthSwitchRequest;
}>;

type RollbackPersistedSessionBindingsResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      diagnostic: SessionConnectedServiceAuthSwitchRollbackDiagnostic;
    }>;

async function rollbackPersistedSessionBindings(input: Readonly<{
  persistSessionBindings: SwitchSessionConnectedServiceAuthInput['persistSessionBindings'];
  sessionId: string;
  previousBindings: ConnectedServiceBindingsV1;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<RollbackPersistedSessionBindingsResult> {
  if (!input.persistSessionBindings) return { ok: true };
  try {
    await input.persistSessionBindings({
      sessionId: input.sessionId,
      normalizedBindings: input.previousBindings,
      ...(input.connectedServiceMaterializationIdentityV1 !== undefined
        ? { connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1 }
        : {}),
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      diagnostic: {
        status: 'bindings_rollback_failed',
        pendingReconciliation: true,
      },
    };
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

function readMaterializationDiagnostics(value: unknown): readonly ConnectedServicesMaterializationDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): readonly ConnectedServicesMaterializationDiagnostic[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const code = readNonEmptyString(record.code);
    if (!code) return [];
    const providerId = readNonEmptyString(record.providerId) || undefined;
    const serviceIdParsed = record.serviceId === undefined
      ? null
      : ConnectedServiceIdSchema.safeParse(record.serviceId);
    const serviceId = serviceIdParsed?.success ? serviceIdParsed.data : undefined;
    const entryName = readNonEmptyString(record.entryName) || undefined;
    const reason = readNonEmptyString(record.reason) || undefined;
    const severity = record.severity === 'info' || record.severity === 'warning' || record.severity === 'blocking'
      ? record.severity
      : undefined;
    return [{
      code,
      ...(providerId ? { providerId } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(severity ? { severity } : {}),
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
  return {
    ok: false,
    errorCode: 'post_switch_verification_failed',
    serviceId: input.serviceId,
    diagnostics: {
      failurePhase: 'materialization',
      retryable: false,
      attemptedAction: 'restart_requested',
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
          ...(reason ? { reason } : {}),
          materializationCode: primary?.code ?? null,
          entryName: primary?.entryName ?? null,
        },
      }),
    },
  };
}

function summarizeConnectedServiceSwitchApplyError(error: unknown): string {
  if (!(error instanceof Error)) {
    return sanitizeConnectedServiceDiagnosticString(String(error)).slice(0, 300);
  }
  const code = (error as { code?: unknown }).code;
  const codePart = typeof code === 'number' || typeof code === 'string'
    ? ` (code=${String(code)})`
    : '';
  return sanitizeConnectedServiceDiagnosticString(`${error.name}${codePart}: ${error.message}`).slice(0, 400);
}

function sanitizeConnectedServiceSwitchUnderlyingError(value: string): string {
  return sanitizeConnectedServiceDiagnosticString(value).slice(0, 400);
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

function findTrackedSession(children: ReadonlyArray<TrackedSession>, sessionId: string): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function resolveTrackedAgentId(tracked: TrackedSession): CatalogAgentId | null {
  return resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
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
  return previous.source !== next.source
    || previous.selection !== next.selection
    || previous.profileId !== next.profileId
    || previous.groupId !== next.groupId;
}

function buildConnectedServiceChildSelection(input: Readonly<{
  serviceId: ConnectedServiceId;
  binding: Extract<ConnectedServiceBinding, Readonly<{ source: 'connected' }>>;
  runtimeAuthSelection?: unknown;
  previousSelection?: PreviousConnectedServiceChildSelection;
  groupMetadata?: ConnectedServiceGroupRuntimeMetadata;
}>): NextConnectedServiceChildSelection | null {
  if (input.binding.selection === 'profile') {
    return {
      kind: 'profile',
      serviceId: input.serviceId,
      profileId: input.binding.profileId,
    };
  }

  const runtimeAuthSelection = readRecord(input.runtimeAuthSelection);
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
  const previousSelectionsByServiceId = new Map<ConnectedServiceId, PreviousConnectedServiceChildSelection>(
    [...(readConnectedServiceChildSelectionsFromEnv(environmentVariables)?.values() ?? [])].map((selection) => [
      selection.serviceId,
      selection,
    ]),
  );
  const nextSelections: NextConnectedServiceChildSelection[] = [];

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

function continuationRecoveryFailed(input: Readonly<{
  action: 'hot_applied' | 'restart_requested';
  reason: ConnectedServiceSessionAuthSwitchReason;
}>): SessionConnectedServiceAuthSwitchFailure {
  return failureResult(input.action === 'hot_applied'
    ? 'hot_apply_succeeded_but_recovery_failed'
    : 'restart_failed', {
    failurePhase: 'recover',
    application: applicationFailure(input.reason, 'recover', input.action === 'hot_applied'
      ? 'hot_apply_succeeded_but_recovery_failed'
      : 'recover_failed'),
  });
}

async function runContinuationRecovery(input: SwitchContinuationRecoveryInput & Readonly<{
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  reason: ConnectedServiceSessionAuthSwitchReason;
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  if (input.reason === 'pre_turn_group_policy') return null;
  if (!input.continueAfterRuntimeAuthSwitch) return null;
  try {
    await input.continueAfterRuntimeAuthSwitch({
      tracked: input.tracked,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      normalizedBindings: input.normalizedBindings,
      serviceIds: input.serviceIds,
      action: input.action,
      switchReason: input.reason,
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    return null;
  } catch {
    return continuationRecoveryFailed({ action: input.action, reason: input.reason });
  }
}

async function runPostSwitchRecovery(input: SwitchPostAuthRecoveryInput & Readonly<{
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  reason: ConnectedServiceSessionAuthSwitchReason;
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  if (!input.recoverAfterRuntimeAuthSwitch) return null;
  try {
    const result = await input.recoverAfterRuntimeAuthSwitch({
      tracked: input.tracked,
      sessionId: input.sessionId,
      normalizedBindings: input.normalizedBindings,
      serviceIds: input.serviceIds,
      action: input.action,
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    return result.ok ? null : continuationRecoveryFailed({ action: input.action, reason: input.reason });
  } catch {
    return continuationRecoveryFailed({ action: input.action, reason: input.reason });
  }
}

function verificationFailureResult(input: Readonly<{
  serviceId: ConnectedServiceId;
  result: Exclude<ConnectedServiceAccountTransitionVerificationResult, Readonly<{ status: 'verified' | 'weakly_verified' }>>;
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  attemptedAction: ConnectedServiceSwitchAttemptAction;
}>): SessionConnectedServiceAuthSwitchFailure {
  if (input.result.status === 'mismatch') {
    return failureResult('provider_account_adoption_mismatch', {
      serviceId: input.serviceId,
      failurePhase: 'post_switch_verification',
      retryable: input.result.retryable,
      diagnosticSource: input.diagnosticSource,
      attemptedAction: input.attemptedAction,
      verification: {
        expectedProviderAccountId: input.result.expectedProviderAccountId ?? null,
        actualProviderAccountId: input.result.actualProviderAccountId ?? null,
        ...(input.result.reason ? { reason: sanitizeConnectedServiceDiagnosticString(input.result.reason) } : {}),
      },
    });
  }
  return failureResult('post_switch_verification_failed', {
    serviceId: input.serviceId,
    failurePhase: 'post_switch_verification',
    retryable: input.result.retryable,
    diagnosticSource: input.diagnosticSource,
    attemptedAction: input.attemptedAction,
    verification: {
      reason: sanitizeConnectedServiceDiagnosticString(input.result.reason),
      ...(input.result.errorClassification === undefined
        ? {}
        : { errorClassification: input.result.errorClassification }),
    },
  });
}

async function runPostSwitchVerificationRecoveryAndContinuation(
  input: SwitchContinuationRecoveryInput & Readonly<{
    recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
    continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
    verifyProviderAccountAdoption: SwitchSessionConnectedServiceAuthInput['verifyProviderAccountAdoption'];
    postSwitchVerificationMode: SwitchSessionConnectedServiceAuthInput['postSwitchVerificationMode'];
    diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
    reason: ConnectedServiceSessionAuthSwitchReason;
    agentId: CatalogAgentId;
    nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
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
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    if (verificationOutcome.failure) return verificationOutcome;
    const recoveryFailure = await runPostSwitchRecovery({
      recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
      reason: input.reason,
      tracked: input.tracked,
      sessionId: input.sessionId,
      normalizedBindings: input.normalizedBindings,
      serviceIds: input.serviceIds,
      action: input.action,
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    if (recoveryFailure) {
      return {
        failure: recoveryFailure,
        ...spreadPostSwitchVerification(verificationOutcome),
      };
    }
    const continuationFailure = await runContinuationRecovery({
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
      reason: input.reason,
      tracked: input.tracked,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      normalizedBindings: input.normalizedBindings,
      serviceIds: input.serviceIds,
      action: input.action,
      ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
    });
    return {
      failure: continuationFailure,
      ...spreadPostSwitchVerification(verificationOutcome),
    };
  }

  const continuationFailure = await runContinuationRecovery({
    continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
    reason: input.reason,
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    normalizedBindings: input.normalizedBindings,
    serviceIds: input.serviceIds,
    action: input.action,
    ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
  });
  return {
    failure: continuationFailure,
  };
}

function isRetryableProviderAccountAdoptionMismatch(
  failure: SessionConnectedServiceAuthSwitchFailure,
): boolean {
  return failure.errorCode === 'provider_account_adoption_mismatch'
    && failure.diagnostics?.failurePhase === 'post_switch_verification'
    && failure.diagnostics.retryable === true;
}

async function restartAfterRetryableHotApplyAdoptionMismatch(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  restartSession: SwitchSessionConnectedServiceAuthInput['restartSession'];
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  verifyProviderAccountAdoption: SwitchSessionConnectedServiceAuthInput['verifyProviderAccountAdoption'];
  postSwitchVerificationMode: SwitchSessionConnectedServiceAuthInput['postSwitchVerificationMode'];
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  reason: ConnectedServiceSessionAuthSwitchReason;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  agentId: CatalogAgentId;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
}>): Promise<SessionConnectedServiceAuthSwitchPostSwitchOutcome> {
  try {
    await input.restartSession(input.tracked);
  } catch (error) {
    return {
      failure: failureResult('restart_failed', {
        ...restartFailure(input.reason, error),
        diagnosticSource: input.diagnosticSource,
      }),
    };
  }
  return await runPostSwitchVerificationRecoveryAndContinuation({
    recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
    continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
    verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
    postSwitchVerificationMode: input.postSwitchVerificationMode,
    diagnosticSource: input.diagnosticSource,
    reason: input.reason,
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    normalizedBindings: input.normalizedBindings,
    agentId: input.agentId,
    nextByServiceId: input.nextByServiceId,
    serviceIds: input.serviceIds,
    action: 'restart_requested',
    ...(input.runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId } : {}),
  });
}

async function validateConnectedProfile(input: Readonly<{
  api: ConnectedServiceProfilesApi;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<SessionConnectedServiceAuthSwitchFailure | null> {
  const profiles = await input.api.listConnectedServiceProfiles({ serviceId: input.serviceId });
  const profile = profiles.profiles.find((candidate) => candidate.profileId === input.profileId) ?? null;
  if (!profile) {
    return { ok: false, errorCode: 'profile_missing', serviceId: input.serviceId };
  }
  if (profile.status === 'needs_reauth') {
    return failureResult('profile_action_required', {
      serviceId: input.serviceId,
      failurePhase: 'normalization',
      actionRequired: {
        kind: 'reconnect_profile',
        profileId: input.profileId,
        healthStatus: profile.status,
      },
    });
  }
  if (profile.status !== 'connected') {
    return { ok: false, errorCode: 'profile_disconnected', serviceId: input.serviceId };
  }
  return null;
}

async function normalizeRequestedBindings(input: Readonly<{
  api: ConnectedServiceProfilesApi;
  agentId: CatalogAgentId;
  request: SessionConnectedServiceAuthSwitchRequest;
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
      if (expectedGeneration !== null && expectedGeneration !== group.generation) {
        return { ok: false, errorCode: 'group_generation_conflict', serviceId };
      }
      const activeProfileId = typeof group.activeProfileId === 'string' ? group.activeProfileId.trim() : '';
      if (!activeProfileId) {
        return { ok: false, errorCode: 'profile_missing', serviceId };
      }
      const profileError = await validateConnectedProfile({
        api: input.api,
        serviceId,
        profileId: activeProfileId,
      });
      if (profileError) return profileError;
      const fallbackProfileId = resolveGroupFallbackProfileId({
        group,
        requestedFallbackProfileId: binding.profileId,
        activeProfileId,
      });

      normalizedBindingsByServiceId[serviceId] = {
        source: 'connected',
        selection: 'group',
        groupId: binding.groupId,
        profileId: activeProfileId,
      };
      effectiveByServiceId.set(serviceId, {
        source: 'connected',
        selection: 'group',
        serviceId,
        profileId: activeProfileId,
        groupId: binding.groupId,
      });
      groupMetadataByServiceId.set(serviceId, {
        groupId: binding.groupId,
        activeProfileId,
        fallbackProfileId,
        generation: readGroupGeneration(group.generation),
      });
      continue;
    }

    const profileError = await validateConnectedProfile({
      api: input.api,
      serviceId,
      profileId: binding.profileId,
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

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 1, bindingsByServiceId: {} };
}

function readConnectedServiceMaterializationIdentity(value: unknown): ConnectedServiceMaterializationIdentityV1 | null {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function bindingsRequireMaterializationIdentity(bindings: ConnectedServiceBindingsV1): boolean {
  return Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

function resolveMaterializationIdentityForAcceptedBindings(input: Readonly<{
  existingIdentity: unknown;
  normalizedBindings: ConnectedServiceBindingsV1;
}>): ConnectedServiceMaterializationIdentityV1 | null {
  const existing = readConnectedServiceMaterializationIdentity(input.existingIdentity);
  if (existing) return existing;
  return bindingsRequireMaterializationIdentity(input.normalizedBindings)
    ? generateConnectedServiceMaterializationIdentityV1()
    : null;
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

function resolveNextEffectiveBindings(input: Readonly<{
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  requestedByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
}>): ReadonlyMap<ConnectedServiceId, EffectiveBinding> {
  const out = new Map(input.requestedByServiceId);
  for (const [serviceId] of input.previousByServiceId.entries()) {
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

function emitSwitchEvents(input: Readonly<{
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  reason: ConnectedServiceSessionAuthSwitchReason;
  mode: ConnectedServiceAccountSwitchMode;
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
}>): void {
  for (const [serviceId, next] of input.nextByServiceId.entries()) {
    const previous = input.previousByServiceId.get(serviceId) ?? null;
    if (!effectiveBindingChanged(previous, next)) continue;
    input.emitSessionEvent(input.sessionId, {
      type: 'connected_service_account_switch',
      serviceId,
      groupId: next.groupId ?? previous?.groupId ?? null,
      fromProfileId: previous?.profileId ?? null,
      toProfileId: next.profileId,
      reason: input.reason,
      mode: input.mode,
    });
  }
}

type ConnectedServiceSwitchAttemptEventProjection = Readonly<{
  action: ConnectedServiceSwitchAttemptAction;
  attemptedContinuityMode: 'hot_apply' | 'restart' | 'metadata_only';
  outcome: 'failed';
  outcomeAction: 'none';
}>;

function switchAttemptEventProjectionForAction(
  action: ConnectedServiceSwitchAttemptAction,
): ConnectedServiceSwitchAttemptEventProjection | null {
  switch (action) {
    case 'hot_applied':
      return {
        action,
        attemptedContinuityMode: 'hot_apply',
        outcome: 'failed',
        outcomeAction: 'none',
      };
    case 'restart_requested':
      return {
        action,
        attemptedContinuityMode: 'restart',
        outcome: 'failed',
        outcomeAction: 'none',
      };
    case 'metadata_updated':
      return null;
  }
}

function resolveFailedSwitchAttemptEventProjection(
  result: Extract<SessionConnectedServiceAuthSwitchResult, { ok: false }>,
): ConnectedServiceSwitchAttemptEventProjection | null {
  const attemptedAction = result.diagnostics?.attemptedAction;
  if (attemptedAction) return switchAttemptEventProjectionForAction(attemptedAction);

  const applicationPhase = result.diagnostics?.application?.phase;
  if (
    result.errorCode === 'hot_apply_failed'
    || result.errorCode === 'hot_apply_succeeded_but_recovery_failed'
    || applicationPhase === 'hot_apply'
  ) {
    return {
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
    };
  }
  if (result.errorCode === 'restart_failed' || applicationPhase === 'restart') {
    return {
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'failed',
      outcomeAction: 'none',
    };
  }
  if (result.errorCode === 'metadata_update_failed') {
    return null;
  }
  return null;
}

function emitFailedSwitchAttemptEvent(input: Readonly<{
  emitSessionEvent: (sessionId: string, event: unknown) => void;
  sessionId: string;
  result: SessionConnectedServiceAuthSwitchResult;
}>): void {
  if (input.result.ok) return;
  const projection = resolveFailedSwitchAttemptEventProjection(input.result);
  if (!projection) return;
  input.emitSessionEvent(input.sessionId, {
    type: 'connected_service_account_switch_attempt',
    ok: false,
    action: projection.action,
    attemptedContinuityMode: projection.attemptedContinuityMode,
    outcome: projection.outcome,
    outcomeAction: projection.outcomeAction,
    errorCode: input.result.errorCode,
    partialState: null,
    ...(input.result.diagnostics?.uxDiagnostic
      ? { diagnostic: input.result.diagnostics.uxDiagnostic }
      : {}),
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
}>): Promise<unknown | null> {
  if (!input.materializeRuntimeAuthSelection || input.next.source !== 'connected') return null;
  return await input.materializeRuntimeAuthSelection({
    tracked: input.tracked,
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceId: input.serviceId,
    previous: input.previous,
    next: input.next,
    previousBindings: input.previousBindings,
    normalizedBindings: input.normalizedBindings,
    groupMetadata: input.groupMetadataByServiceId?.get(input.serviceId),
  });
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

function hasTrackedRuntimeAlreadyAdoptedExpectedGroupGeneration(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  tracked: TrackedSession;
  serviceId: ConnectedServiceId;
  next: EffectiveBinding;
}>): boolean {
  if (input.request.rematerializeServiceId) return false;
  if (input.next.source !== 'connected' || input.next.selection !== 'group') return false;
  const expectedGeneration = readExpectedGroupGenerationForService({
    request: input.request,
    serviceId: input.serviceId,
  });
  if (expectedGeneration === null) return false;

  const selection = readConnectedServiceChildSelectionsFromEnv(
    input.tracked.spawnOptions?.environmentVariables ?? {},
  )?.get(input.serviceId) ?? null;
  if (!selection || selection.kind !== 'group') return false;
  return selection.groupId === input.next.groupId
    && selection.activeProfileId === input.next.profileId
    && selection.generation === expectedGeneration;
}

async function rematerializeUnchangedConnectedServiceBinding(input: Readonly<{
  request: SessionConnectedServiceAuthSwitchRequest;
  reason: ConnectedServiceSessionAuthSwitchReason;
  tracked: TrackedSession;
  trackedAgentId: CatalogAgentId;
  previousByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, EffectiveBinding>;
  normalizedBindings: ConnectedServiceBindingsV1;
  groupMetadataByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceGroupRuntimeMetadata>;
  resolveContinuity: SwitchSessionConnectedServiceAuthInput['resolveContinuity'];
  materializeRuntimeAuthSelection: SwitchSessionConnectedServiceAuthInput['materializeRuntimeAuthSelection'];
  restartSession: SwitchSessionConnectedServiceAuthInput['restartSession'];
  hotApply: SwitchSessionConnectedServiceAuthInput['hotApply'];
  persistSessionBindings: SwitchSessionConnectedServiceAuthInput['persistSessionBindings'];
  recoverAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['recoverAfterRuntimeAuthSwitch'];
  continueAfterRuntimeAuthSwitch: SwitchSessionConnectedServiceAuthInput['continueAfterRuntimeAuthSwitch'];
  verifyProviderAccountAdoption: SwitchSessionConnectedServiceAuthInput['verifyProviderAccountAdoption'];
  postSwitchVerificationMode: SwitchSessionConnectedServiceAuthInput['postSwitchVerificationMode'];
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  registerHotApplyTargets: SwitchSessionConnectedServiceAuthInput['registerHotApplyTargets'];
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
  if (hasTrackedRuntimeAlreadyAdoptedExpectedGroupGeneration({
    request: input.request,
    tracked: input.tracked,
    serviceId,
    next,
  })) {
    return {
      ok: true,
      action: 'unchanged',
      normalizedBindings: input.normalizedBindings,
      continuityByServiceId: {},
      warnings: [],
    };
  }

  const previous = input.previousByServiceId.get(serviceId) ?? null;
  const previousBindings = readConnectedServiceBindingsOrEmpty(input.tracked.spawnOptions?.connectedServices);
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
  });
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
    ...(connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1 }
      : {}),
    environmentVariables: nextEnvironmentVariables,
  };

  try {
    if (
      connectedServiceMaterializationIdentityV1
      && !readConnectedServiceMaterializationIdentityFromSpawnOptions(previousSpawnOptions)
    ) {
      try {
        await input.persistSessionBindings?.({
          sessionId: input.request.sessionId,
          normalizedBindings: input.normalizedBindings,
          connectedServiceMaterializationIdentityV1,
        });
      } catch (error) {
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
        if (isPostSwitchRecoveryFailure(hotApplyResult)) {
          return hotApplySucceededButRecoveryFailed(input.reason);
        }
        if (hotApplyFailureRequiresRestart(hotApplyResult)) {
          try {
            await input.restartSession(input.tracked);
          } catch (error) {
            input.tracked.spawnOptions = previousSpawnOptions;
            return failureResult('restart_failed', {
              ...restartFailure(input.reason, error),
              diagnosticSource: input.diagnosticSource,
            });
          }
          const restartContinuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
            action: 'restart_requested',
            serviceIds,
            normalizedBindings: input.normalizedBindings,
            expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
          });
          const continuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
            verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
            postSwitchVerificationMode: input.postSwitchVerificationMode,
            diagnosticSource: input.diagnosticSource,
            reason: input.reason,
            tracked: input.tracked,
            sessionId: input.request.sessionId,
            attemptId: restartContinuationAttemptId,
            normalizedBindings: input.normalizedBindings,
            agentId: input.trackedAgentId,
            nextByServiceId: input.nextByServiceId,
            serviceIds,
            action: 'restart_requested',
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
          };
        }
        input.tracked.spawnOptions = previousSpawnOptions;
        return failureResult('hot_apply_failed', {
          serviceId: hotApplyResult.serviceId,
          failurePhase: 'hot_apply',
          diagnosticSource: input.diagnosticSource,
          application: applicationFailure(input.reason, 'hot_apply'),
          serviceResultsByServiceId: hotApplyResult.serviceResultsByServiceId,
          underlyingError: hotApplyResult.underlyingError,
        });
      }
      input.registerHotApplyTargets(input.tracked);
      const continuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
        recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
        verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
        postSwitchVerificationMode: input.postSwitchVerificationMode,
        diagnosticSource: input.diagnosticSource,
        reason: input.reason,
        tracked: input.tracked,
        sessionId: input.request.sessionId,
        attemptId: continuationAttemptId,
        normalizedBindings: input.normalizedBindings,
        agentId: input.trackedAgentId,
        nextByServiceId: input.nextByServiceId,
        serviceIds,
        action: 'hot_applied',
        ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
      });
      if (continuationOutcome.failure) {
        if (!isRetryableProviderAccountAdoptionMismatch(continuationOutcome.failure)) return continuationOutcome.failure;
        const restartContinuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
          action: 'restart_requested',
          serviceIds,
          normalizedBindings: input.normalizedBindings,
          expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
        });
        const restartOutcome = await restartAfterRetryableHotApplyAdoptionMismatch({
          restartSession: input.restartSession,
          recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
          continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
          verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
          postSwitchVerificationMode: input.postSwitchVerificationMode,
          diagnosticSource: input.diagnosticSource,
          reason: input.reason,
          tracked: input.tracked,
          sessionId: input.request.sessionId,
          attemptId: restartContinuationAttemptId,
          normalizedBindings: input.normalizedBindings,
          agentId: input.trackedAgentId,
          nextByServiceId: input.nextByServiceId,
          serviceIds,
          ...(runtimeAuthSelectionsByServiceId ? { runtimeAuthSelectionsByServiceId } : {}),
        });
        if (restartOutcome.failure) return withSwitchAttemptedAction(restartOutcome.failure, 'hot_applied');
        return {
          ok: true,
          action: 'restart_requested',
          normalizedBindings: input.normalizedBindings,
          continuityByServiceId: { [serviceId]: 'restart_rematerialize' },
          warnings: continuity.warnings ?? [],
          ...spreadPostSwitchVerification(restartOutcome),
        };
      }
      return {
        ok: true,
        action: 'hot_applied',
        normalizedBindings: input.normalizedBindings,
        continuityByServiceId: { [serviceId]: continuity.mode },
        warnings: continuity.warnings ?? [],
        ...spreadPostSwitchVerification(continuationOutcome),
      };
    }

    await input.restartSession(input.tracked);
    const continuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
      recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
      postSwitchVerificationMode: input.postSwitchVerificationMode,
      diagnosticSource: input.diagnosticSource,
      reason: input.reason,
      tracked: input.tracked,
      sessionId: input.request.sessionId,
      attemptId: continuationAttemptId,
      normalizedBindings: input.normalizedBindings,
      agentId: input.trackedAgentId,
      nextByServiceId: input.nextByServiceId,
      serviceIds,
      action: 'restart_requested',
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
    };
  } catch (error) {
    input.tracked.spawnOptions = previousSpawnOptions;
    const phase = continuity.mode === 'hot_apply' ? 'hot_apply' : 'restart';
    return failureResult(
      continuity.mode === 'hot_apply' ? 'hot_apply_failed' : 'restart_failed',
      phase === 'hot_apply'
        ? {
            failurePhase: phase,
            diagnosticSource: input.diagnosticSource,
            application: applicationFailure(input.reason, phase),
            underlyingError: summarizeConnectedServiceSwitchApplyError(error),
          }
        : {
            ...restartFailure(input.reason, error),
            diagnosticSource: input.diagnosticSource,
          },
    );
  }
}

export type ApplyConnectedServiceAuthGenerationToTrackedSessionInput =
  Omit<SwitchSessionConnectedServiceAuthInput, 'core'>;

export async function applyConnectedServiceAuthGenerationToTrackedSession(
  input: ApplyConnectedServiceAuthGenerationToTrackedSessionInput,
): Promise<SessionConnectedServiceAuthSwitchResult> {
  const switchReason = input.reason ?? 'manual';
  const diagnosticSource = resolveSwitchUxDiagnosticSource(switchReason);
  const tracked = findTrackedSession(input.getChildren(), input.request.sessionId);
  if (!tracked) {
    const inactive = await input.resolveInactiveSession?.({ sessionId: input.request.sessionId }) ?? null;
    if (!inactive) return failureResult('session_not_found', { failurePhase: 'session_lookup' });
    if (input.request.agentId.trim() !== inactive.agentId) {
      return failureResult('agent_mismatch', { failurePhase: 'agent_validation' });
    }

    const normalized = await normalizeRequestedBindings({
      api: input.api,
      agentId: inactive.agentId,
      request: input.request,
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

    emitSwitchEvents({
      emitSessionEvent: input.emitSessionEvent,
      sessionId: input.request.sessionId,
      reason: switchReason,
      mode: 'spawn_next_turn',
      previousByServiceId,
      nextByServiceId,
    });

    return {
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: normalized.normalized,
      continuityByServiceId,
      warnings,
    };
  }

  const trackedAgentId = resolveTrackedAgentId(tracked);
  if (!trackedAgentId || input.request.agentId.trim() !== trackedAgentId) {
    return failureResult('agent_mismatch', { failurePhase: 'agent_validation' });
  }

  const normalized = await normalizeRequestedBindings({
    api: input.api,
    agentId: trackedAgentId,
    request: input.request,
  });
  if (!normalized.ok) return normalized;

  const previousBindings = readConnectedServiceBindingsOrEmpty(tracked.spawnOptions?.connectedServices);
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
      reason: switchReason,
      tracked,
      trackedAgentId,
      previousByServiceId,
      nextByServiceId,
      normalizedBindings: normalized.normalized,
      resolveContinuity: input.resolveContinuity,
      materializeRuntimeAuthSelection: input.materializeRuntimeAuthSelection,
      restartSession: input.restartSession,
      hotApply: input.hotApply,
      persistSessionBindings: input.persistSessionBindings,
      recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
      postSwitchVerificationMode: input.postSwitchVerificationMode,
      diagnosticSource,
      registerHotApplyTargets: input.registerHotApplyTargets,
      groupMetadataByServiceId: normalized.groupMetadataByServiceId,
    });
    if (rematerialized) return rematerialized;
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
  const runtimeAuthSelectionsByServiceId = new Map<ConnectedServiceId, unknown>();
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
    });
    const blockingMaterializationDiagnostics = readRuntimeAuthSelectionBlockingMaterializationDiagnostics(
      runtimeAuthSelection,
    );
    if (blockingMaterializationDiagnostics.length > 0) {
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
    if (continuity.mode !== 'hot_apply') {
      allChangedServicesHotApply = false;
    }
  }

  let action: 'restart_requested' | 'hot_applied' = allChangedServicesHotApply
    ? 'hot_applied'
    : 'restart_requested';
  const changedServiceIdSet = new Set<ConnectedServiceId>(changedServiceIds);
  const postSwitchVerificationByServiceId: AcceptedConnectedServiceAccountVerificationByServiceId = {};
  const continuationAttemptId = buildConnectedServiceSwitchContinuationAttemptId({
    action,
    serviceIds: changedServiceIdSet,
    normalizedBindings: normalized.normalized,
    expectedGroupGenerationByServiceId: input.request.expectedGroupGenerationByServiceId,
  });

  const nextEnvironmentVariables = buildTrackedSessionEnvironmentVariables({
    existingEnvironmentVariables: previousSpawnOptions?.environmentVariables,
    normalizedBindings: normalized.normalized,
    ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
    groupMetadataByServiceId: normalized.groupMetadataByServiceId,
  });
  tracked.spawnOptions = {
    ...(tracked.spawnOptions ?? { directory: '' }),
    connectedServices: normalized.normalized,
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
      } catch (error) {
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
        if (isPostSwitchRecoveryFailure(hotApplyResult)) {
          return hotApplySucceededButRecoveryFailed(switchReason);
        }
        if (hotApplyFailureRequiresRestart(hotApplyResult)) {
          try {
            await input.restartSession(tracked);
          } catch (error) {
            const rollback = await rollbackPersistedSessionBindings({
              persistSessionBindings: input.persistSessionBindings,
              sessionId: input.request.sessionId,
              previousBindings,
              connectedServiceMaterializationIdentityV1:
                readConnectedServiceMaterializationIdentityFromSpawnOptions(previousSpawnOptions),
            });
            tracked.spawnOptions = previousSpawnOptions;
            if (!rollback.ok) {
              return partialAppliedPendingReconciliation({
                reason: switchReason,
                phase: 'restart',
                rollback: rollback.diagnostic,
              });
            }
            return failureResult('restart_failed', {
              ...restartFailure(switchReason, error),
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
          const continuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
            verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
            postSwitchVerificationMode: input.postSwitchVerificationMode,
            diagnosticSource,
            reason: switchReason,
            tracked,
            sessionId: input.request.sessionId,
            attemptId: restartContinuationAttemptId,
            normalizedBindings: normalized.normalized,
            agentId: trackedAgentId,
            nextByServiceId,
            serviceIds: changedServiceIdSet,
            action,
            ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
          });
          if (continuationOutcome.failure) return continuationOutcome.failure;
          mergePostSwitchVerification(postSwitchVerificationByServiceId, continuationOutcome);
        } else {
          const rollback = await rollbackPersistedSessionBindings({
            persistSessionBindings: input.persistSessionBindings,
            sessionId: input.request.sessionId,
            previousBindings,
            connectedServiceMaterializationIdentityV1:
              readConnectedServiceMaterializationIdentityFromSpawnOptions(previousSpawnOptions),
          });
          tracked.spawnOptions = previousSpawnOptions;
          if (!rollback.ok) {
            return partialAppliedPendingReconciliation({
              reason: switchReason,
              phase: 'hot_apply',
              rollback: rollback.diagnostic,
            });
          }
          return failureResult('hot_apply_failed', {
            serviceId: hotApplyResult.serviceId,
            failurePhase: 'hot_apply',
            diagnosticSource,
            application: applicationFailure(switchReason, 'hot_apply'),
            serviceResultsByServiceId: hotApplyResult.serviceResultsByServiceId,
            underlyingError: hotApplyResult.underlyingError,
          });
        }
      } else {
        input.registerHotApplyTargets(tracked);
        const continuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
          recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
          continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
          verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
          postSwitchVerificationMode: input.postSwitchVerificationMode,
          diagnosticSource,
          reason: switchReason,
          tracked,
          sessionId: input.request.sessionId,
          attemptId: continuationAttemptId,
          normalizedBindings: normalized.normalized,
          agentId: trackedAgentId,
          nextByServiceId,
          serviceIds: changedServiceIdSet,
          action: 'hot_applied',
          ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
        });
        if (continuationOutcome.failure) {
          if (!isRetryableProviderAccountAdoptionMismatch(continuationOutcome.failure)) return continuationOutcome.failure;
          try {
            await input.restartSession(tracked);
          } catch (error) {
            const rollback = await rollbackPersistedSessionBindings({
              persistSessionBindings: input.persistSessionBindings,
              sessionId: input.request.sessionId,
              previousBindings,
              connectedServiceMaterializationIdentityV1:
                readConnectedServiceMaterializationIdentityFromSpawnOptions(previousSpawnOptions),
            });
            tracked.spawnOptions = previousSpawnOptions;
            if (!rollback.ok) {
              return partialAppliedPendingReconciliation({
                reason: switchReason,
                phase: 'restart',
                rollback: rollback.diagnostic,
              });
            }
            return failureResult('restart_failed', {
              ...restartFailure(switchReason, error),
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
          const restartContinuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
            recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
            continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
            verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
            postSwitchVerificationMode: input.postSwitchVerificationMode,
            diagnosticSource,
            reason: switchReason,
            tracked,
            sessionId: input.request.sessionId,
            attemptId: restartContinuationAttemptId,
            normalizedBindings: normalized.normalized,
            agentId: trackedAgentId,
            nextByServiceId,
            serviceIds: changedServiceIdSet,
            action,
            ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
          });
          if (restartContinuationOutcome.failure) {
            return withSwitchAttemptedAction(restartContinuationOutcome.failure, 'hot_applied');
          }
          mergePostSwitchVerification(postSwitchVerificationByServiceId, restartContinuationOutcome);
        } else {
          mergePostSwitchVerification(postSwitchVerificationByServiceId, continuationOutcome);
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
      } catch (error) {
        tracked.spawnOptions = previousSpawnOptions;
        return failureResult('metadata_update_failed', { failurePhase: 'metadata', diagnosticSource });
      }
      try {
        await input.restartSession(tracked);
      } catch (error) {
        const rollback = await rollbackPersistedSessionBindings({
          persistSessionBindings: input.persistSessionBindings,
          sessionId: input.request.sessionId,
          previousBindings,
          connectedServiceMaterializationIdentityV1:
            readConnectedServiceMaterializationIdentityFromSpawnOptions(previousSpawnOptions),
        });
        tracked.spawnOptions = previousSpawnOptions;
        if (!rollback.ok) {
          return partialAppliedPendingReconciliation({
            reason: switchReason,
            phase: 'restart',
            rollback: rollback.diagnostic,
          });
        }
        return failureResult('restart_failed', {
          ...restartFailure(switchReason, error),
          diagnosticSource,
        });
      }
      const continuationOutcome = await runPostSwitchVerificationRecoveryAndContinuation({
        recoverAfterRuntimeAuthSwitch: input.recoverAfterRuntimeAuthSwitch,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch,
        verifyProviderAccountAdoption: input.verifyProviderAccountAdoption,
        postSwitchVerificationMode: input.postSwitchVerificationMode,
        diagnosticSource,
        reason: switchReason,
        tracked,
        sessionId: input.request.sessionId,
        attemptId: continuationAttemptId,
        normalizedBindings: normalized.normalized,
        agentId: trackedAgentId,
        nextByServiceId,
        serviceIds: changedServiceIdSet,
        action: 'restart_requested',
        ...(runtimeAuthSelectionsByServiceId.size === 0 ? {} : { runtimeAuthSelectionsByServiceId }),
      });
      if (continuationOutcome.failure) return continuationOutcome.failure;
      mergePostSwitchVerification(postSwitchVerificationByServiceId, continuationOutcome);
    }
  } catch (error) {
    tracked.spawnOptions = previousSpawnOptions;
    const phase = action === 'hot_applied' ? 'hot_apply' : 'restart';
    return failureResult(
      action === 'hot_applied' ? 'hot_apply_failed' : 'restart_failed',
      phase === 'hot_apply'
        ? {
            failurePhase: phase,
            diagnosticSource,
            application: applicationFailure(switchReason, phase),
            underlyingError: summarizeConnectedServiceSwitchApplyError(error),
          }
        : {
            ...restartFailure(switchReason, error),
            diagnosticSource,
          },
    );
  }

  emitSwitchEvents({
    emitSessionEvent: input.emitSessionEvent,
    sessionId: input.request.sessionId,
    reason: switchReason,
    mode: action === 'hot_applied' ? 'hot_apply' : 'restart_resume',
    previousByServiceId,
    nextByServiceId,
  });

  return {
    ok: true,
    action,
    normalizedBindings: normalized.normalized,
    continuityByServiceId,
    warnings,
    ...spreadPostSwitchVerification({ verificationByServiceId: postSwitchVerificationByServiceId }),
  };
}

export async function switchSessionConnectedServiceAuth(
  input: SwitchSessionConnectedServiceAuthInput,
): Promise<SessionConnectedServiceAuthSwitchResult> {
  const switchReason = input.reason ?? 'manual';
  const { core, transitionLockMode, ...applyInput } = input;
  const result = await runSerializedConnectedServiceTransition({
    core,
    transitionLockMode,
    sessionId: input.request.sessionId,
    reason: switchReason,
    execute: async () => await applyConnectedServiceAuthGenerationToTrackedSession({
      ...applyInput,
      reason: switchReason,
    }),
  });
  emitFailedSwitchAttemptEvent({
    emitSessionEvent: input.emitSessionEvent,
    sessionId: input.request.sessionId,
    result,
  });
  return result;
}
