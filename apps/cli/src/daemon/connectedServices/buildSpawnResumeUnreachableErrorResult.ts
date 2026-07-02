import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  type SpawnSessionResult,
} from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from './diagnostics/connectedServiceUxDiagnostics';
import type { ConnectedServiceSpawnResumeUnreachableError } from './resolveConnectedServiceAuthForSpawn';

function resolveResumeUnreachableUxDiagnosticCode(
  error: ConnectedServiceSpawnResumeUnreachableError,
) {
  if (error.reason === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing) {
    return CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing;
  }
  return CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume;
}

function resolveSafePublicReason(error: ConnectedServiceSpawnResumeUnreachableError): string {
  const rawReason = typeof error.reason === 'string' ? error.reason.trim() : '';
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
 * working), and ALSO carries a structured `errorDetail` so the client can programmatically recognize
 * "resume unreachable" and surface the "switch unavailable" explanation + "start fresh under the new
 * account" affordance. The detail is a UI-safe projection: provider resume ids and local paths stay
 * on the daemon-local error/log path, not in the protocol payload.
 */
export function buildSpawnResumeUnreachableErrorResult(
  error: ConnectedServiceSpawnResumeUnreachableError,
): Extract<SpawnSessionResult, { type: 'error' }> {
  const reason = resolveSafePublicReason(error);
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
        code: resolveResumeUnreachableUxDiagnosticCode(error),
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: error.agentId,
        retryable: false,
        diagnostics: {
          reason,
        },
      }),
    },
  };
}
