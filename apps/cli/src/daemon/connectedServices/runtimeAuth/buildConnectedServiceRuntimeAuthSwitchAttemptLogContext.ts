import type { ConnectedServiceRuntimeFailureClassification } from './types';

type UnknownRecord = Readonly<Record<string, unknown>>;

export type ConnectedServiceRuntimeAuthSwitchAttemptLogContext = Readonly<{
  trigger: 'runtime_auth_failure';
  decision: 'reactive_runtime_auth_switch';
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  reportedProfileId: string | null;
  targetProfileId: string | null;
  resultStatus: string;
  outcomeStatus: string | null;
  generation: number | null;
  mode: string | null;
  failurePhase: string | null;
  errorCode: string | null;
  errorName: string | null;
  errorMessage: string | null;
  routedThroughFsm: boolean;
  latencyMs: number;
  limitCategory: string | null;
  quotaScope: string | null;
  providerLimitId: string | null;
  retryAfterMs: number | null;
  resetsAtMs: number | null;
  planType: string | null;
  materializationIdentityId: string | null;
  targetMaterializedRoot: string | null;
  vendorResumeId: string | null;
  candidatePersistedSessionFile: string | null;
  requestedStateMode: string | null;
  effectiveStateMode: string | null;
  reachabilityMissReason: string | null;
  verificationStatus: string | null;
  verificationReason: string | null;
  excludedSummary: ReadonlyArray<Readonly<{
    profileId: string;
    reason: string;
    retryAtMs: number | null;
  }>> | null;
  decisionTraceSummary: Readonly<{
    activeProfileId: string | null;
    reason: string | null;
    candidates: ReadonlyArray<Readonly<{
      profileId: string;
      decision: string;
      exclusionReason: string | null;
      retryAtMs: number | null;
      quotaEvidence: Readonly<{
        status: string | null;
        remainingPercent: number | null;
        capturedAtMs: number | null;
        exhausted: boolean | null;
      }>;
    }>>;
  }> | null;
}>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function readRecordProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function summarizeSensitiveString(value: unknown): string | null {
  return readString(value) === null ? null : 'present';
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readSwitchAttemptResult(result: unknown): UnknownRecord | null {
  if (!isRecord(result)) return null;
  const nested = readRecordProperty(result, 'result');
  if (readString(readRecordProperty(result, 'status')) === 'switch_attempted' && isRecord(nested)) {
    return nested;
  }
  return result;
}

function readContinuityDiagnostics(diagnostics: unknown): UnknownRecord | null {
  const continuity = readRecordProperty(diagnostics, 'continuity');
  return isRecord(continuity) ? continuity : null;
}

function readExcludedSummary(switchResult: unknown): ConnectedServiceRuntimeAuthSwitchAttemptLogContext['excludedSummary'] {
  const excluded = readRecordProperty(switchResult, 'excluded');
  if (!Array.isArray(excluded)) return null;
  const sanitized = excluded.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const profileId = readString(readRecordProperty(entry, 'profileId'));
    const reason = readString(readRecordProperty(entry, 'reason'));
    if (!profileId || !reason) return [];
    return [{
      profileId,
      reason,
      retryAtMs: readNumber(readRecordProperty(entry, 'retryAtMs')),
    }];
  });
  return sanitized.length > 0 ? sanitized : null;
}

function readDecisionTraceSummary(
  diagnostics: unknown,
): ConnectedServiceRuntimeAuthSwitchAttemptLogContext['decisionTraceSummary'] {
  const decisionTrace = readRecordProperty(diagnostics, 'decisionTrace');
  if (!isRecord(decisionTrace)) return null;
  const candidates = readRecordProperty(decisionTrace, 'candidates');
  const sanitizedCandidates = Array.isArray(candidates)
    ? candidates.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const profileId = readString(readRecordProperty(candidate, 'profileId'));
      const decision = readString(readRecordProperty(candidate, 'decision'));
      if (!profileId || !decision) return [];
      const quotaEvidence = readRecordProperty(candidate, 'quotaEvidence');
      return [{
        profileId,
        decision,
        exclusionReason: readString(readRecordProperty(candidate, 'exclusionReason')),
        retryAtMs: readNumber(readRecordProperty(candidate, 'retryAtMs')),
        quotaEvidence: {
          status: readString(readRecordProperty(quotaEvidence, 'status')),
          remainingPercent: readNumber(readRecordProperty(quotaEvidence, 'remainingPercent')),
          capturedAtMs: readNumber(readRecordProperty(quotaEvidence, 'capturedAtMs')),
          exhausted: readBoolean(readRecordProperty(quotaEvidence, 'exhausted')),
        },
      }];
    })
    : [];
  return {
    activeProfileId: readString(readRecordProperty(decisionTrace, 'activeProfileId')),
    reason: readString(readRecordProperty(decisionTrace, 'reason')),
    candidates: sanitizedCandidates,
  };
}

function readVerificationRecordForService(input: Readonly<{
  switchResult: unknown;
  serviceId: string;
}>): UnknownRecord | null {
  const byServiceId = readRecordProperty(input.switchResult, 'verificationByServiceId');
  const verification = readRecordProperty(byServiceId, input.serviceId);
  return isRecord(verification) ? verification : null;
}

function resolveFailurePhase(input: Readonly<{
  resultStatus: string;
  errorCode: string | null;
  handlerFailure: boolean;
  explicitFailurePhase: string | null;
}>): string | null {
  if (input.explicitFailurePhase) return input.explicitFailurePhase;
  if (input.handlerFailure) return 'handler';
  switch (input.errorCode) {
    case 'provider_session_state_unavailable_for_resume':
    case 'connected_service_materialization_identity_missing':
    case 'resume_reachability_inputs_missing':
      return 'continuity';
    case 'metadata_update_failed':
      return 'metadata_persist';
    default:
      break;
  }
  switch (input.resultStatus) {
    case 'generation_apply_failed':
      return 'apply';
    case 'selection_mismatch':
      return 'binding_resolution';
    case 'no_eligible_member':
    case 'no_eligible_members':
      return 'selection';
    case 'recovery_action_required':
    case 'temporary_retry_armed':
    case 'temporary_retry_unavailable':
      return 'classification';
    default:
      return null;
  }
}

export function buildConnectedServiceRuntimeAuthSwitchAttemptLogContext(input: Readonly<{
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification;
  result?: unknown;
  handlerFailure?: Readonly<{
    errorCode: string;
    errorName: string;
    errorMessage: string;
  }> | null;
  routedThroughFsm: boolean;
  startedAtMs: number;
  finishedAtMs: number;
}>): ConnectedServiceRuntimeAuthSwitchAttemptLogContext {
  const switchResult = readSwitchAttemptResult(input.result);
  const outcomeStatus = readString(readRecordProperty(input.result, 'status'));
  const resultStatus = input.handlerFailure
    ? 'recovery_handler_failed'
    : readString(readRecordProperty(switchResult, 'status')) ?? outcomeStatus ?? 'unknown';
  const diagnostics = readRecordProperty(switchResult, 'diagnostics');
  const continuityDiagnostics = readContinuityDiagnostics(diagnostics);
  const excludedSummary = readExcludedSummary(switchResult);
  const decisionTraceSummary = readDecisionTraceSummary(diagnostics);
  const verification = readVerificationRecordForService({
    switchResult,
    serviceId: input.classification.serviceId,
  });
  const explicitFailurePhase = readString(readRecordProperty(diagnostics, 'failurePhase'));
  const errorCode = input.handlerFailure?.errorCode
    ?? readString(readRecordProperty(switchResult, 'errorCode'))
    ?? readString(readRecordProperty(diagnostics, 'errorCode'));

  return {
    trigger: 'runtime_auth_failure',
    decision: 'reactive_runtime_auth_switch',
    sessionId: input.sessionId,
    serviceId: input.classification.serviceId,
    groupId: input.classification.groupId,
    reportedProfileId: input.classification.profileId,
    targetProfileId: readString(readRecordProperty(switchResult, 'activeProfileId')),
    resultStatus,
    outcomeStatus,
    generation: readNumber(readRecordProperty(switchResult, 'generation')),
    mode: readString(readRecordProperty(switchResult, 'mode')),
    failurePhase: resolveFailurePhase({
      resultStatus,
      errorCode,
      handlerFailure: Boolean(input.handlerFailure),
      explicitFailurePhase,
    }),
    errorCode,
    errorName: input.handlerFailure?.errorName ?? null,
    errorMessage: input.handlerFailure?.errorMessage ?? null,
    routedThroughFsm: input.routedThroughFsm,
    latencyMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
    limitCategory: input.classification.limitCategory ?? null,
    quotaScope: input.classification.quotaScope ?? null,
    providerLimitId: input.classification.providerLimitId ?? null,
    retryAfterMs: input.classification.retryAfterMs ?? null,
    resetsAtMs: input.classification.resetsAtMs,
    planType: input.classification.planType,
    materializationIdentityId: readString(readRecordProperty(continuityDiagnostics, 'materializationIdentityId')),
    targetMaterializedRoot: summarizeSensitiveString(readRecordProperty(continuityDiagnostics, 'targetMaterializedRoot')),
    vendorResumeId: summarizeSensitiveString(readRecordProperty(continuityDiagnostics, 'vendorResumeId')),
    candidatePersistedSessionFile: summarizeSensitiveString(readRecordProperty(continuityDiagnostics, 'candidatePersistedSessionFile')),
    requestedStateMode: readString(readRecordProperty(continuityDiagnostics, 'requestedStateMode')),
    effectiveStateMode: readString(readRecordProperty(continuityDiagnostics, 'effectiveStateMode')),
    reachabilityMissReason: readString(readRecordProperty(continuityDiagnostics, 'reachabilityMissReason')),
    verificationStatus: readString(readRecordProperty(verification, 'status')),
    verificationReason: readString(readRecordProperty(verification, 'reason')),
    excludedSummary,
    decisionTraceSummary,
  };
}
