import { CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS, CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { SPAWN_SESSION_ERROR_CODES, SPAWN_SESSION_ERROR_DETAIL_KINDS } from '@happier-dev/protocol/spawnSession';
import type { SpawnSessionResult } from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from './diagnostics/connectedServiceUxDiagnostics';
import type { ConnectedServiceSpawnResumeUnreachableError } from './resolveConnectedServiceAuthForSpawn';
import { sanitizeConnectedServiceDiagnosticString } from './runtimeAuth/sanitizeConnectedServiceDiagnosticString';

export function resolveSafeResumeUnreachableDiagnosticReason(
  error: ConnectedServiceSpawnResumeUnreachableError,
): string {
  const rawReason = typeof error.reason === 'string' ? error.reason.trim() : '';
  const sensitiveContextValues = [error.vendorResumeId, error.cwd, error.targetMaterializedRoot]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  const sanitizedReason = sanitizeConnectedServiceDiagnosticString(rawReason, {
    maxLength: 160,
    redactedValues: sensitiveContextValues,
  });
  if (
    sanitizedReason !== rawReason
    || sensitiveContextValues.some((value) => rawReason.includes(value))
  ) {
    return 'resume_reachability_unavailable';
  }
  if (/^[a-zA-Z0-9_.:-]{1,160}$/.test(rawReason) && !/[\\/]/.test(rawReason)) {
    return rawReason;
  }
  return 'resume_reachability_unavailable';
}

/**
 * Map a fail-closed connected-service resume-reachability error (K1 §2) into a spawn-error result.
 *
 * D2 contract: this is purely ADDITIVE on top of the pre-existing mapping. The result still uses
 * `SPAWN_VALIDATION_FAILED` and a human-readable `errorMessage` (so legacy/copy-based consumers keep
 * working), and carries a structured `errorDetail` with the appropriate retry or continuity recovery.
 * The detail is a UI-safe projection: provider resume ids and local paths stay on the daemon-local
 * error/log path.
 */
export function buildSpawnResumeUnreachableErrorResult(
  error: ConnectedServiceSpawnResumeUnreachableError,
): Extract<SpawnSessionResult, { type: 'error' }> {
  const reason = resolveSafeResumeUnreachableDiagnosticReason(error);
  const retryable = reason === 'resume_reachability_check_failed';
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    errorMessage: `${error.errorCode} (failurePhase=${error.failurePhase}, agentId=${error.agentId}, reason=${reason})`,
    errorDetail: {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: error.errorCode,
      failurePhase: error.failurePhase,
      agentId: error.agentId,
      reason,
      uxDiagnostic: buildConnectedServiceUxDiagnostic({
        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: error.agentId,
        retryable,
        ...(retryable ? { suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry] } : {}),
        diagnostics: {
          reason,
        },
      }),
    },
  };
}
