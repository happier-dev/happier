import { randomUUID } from 'node:crypto';
import { createActionExecuteFailureError, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

export type ExternalActionHeaderRefusalReason =
  | 'external_credential_without_authorization'
  | 'signing_key_missing'
  | 'installation_id_missing'
  | 'target_missing'
  | 'dependency_home_identity_mismatch'
  | 'requester_account_custody_mismatch'
  | 'approval_replay_mismatch'
  | 'template_account_mismatch'
  | 'authorization_headers_missing'
  /** This Home port has no signed external carrier for the requested effect. */
  | 'external_transport_unsupported';

export type ExternalActionHeaderRefusal = Readonly<{
  ok: false;
  reason: ExternalActionHeaderRefusalReason;
  requestId: string;
}>;

/** No credential, target or Home values enter the diagnostic carrier. */
export function refuseExternalActionHeaders(
  reason: ExternalActionHeaderRefusalReason, requestId: string = randomUUID(),
): ExternalActionHeaderRefusal {
  return { ok: false, reason, requestId };
}

/** The one refusal projection: returned by failure-returning ports, thrown by null-only adapters. */
export function externalActionHeaderRefusalFailure(refusal: ExternalActionHeaderRefusal): ActionExecuteFailure {
  logger.infoFile('[ExternalAction] Header authorization refused', {
    reason: refusal.reason, requestId: refusal.requestId,
  });
  return {
    ok: false, errorCode: 'action_failed',
    error: `External Action authorization unavailable: ${refusal.reason}`,
    requestId: refusal.requestId, effectAttempted: false,
    details: { authorizationRefusalReason: refusal.reason },
    failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null },
  };
}

/** Null-only transport adapters throw this existing Action carrier, never flatten its cause. */
export function createExternalActionHeaderRefusalError(
  refusal: ExternalActionHeaderRefusal = refuseExternalActionHeaders('authorization_headers_missing'),
): ReturnType<typeof createActionExecuteFailureError> {
  return createActionExecuteFailureError(externalActionHeaderRefusalFailure(refusal));
}

export function requireExternalActionHeaders(
  result: Readonly<{ ok: true; headers: Readonly<Record<string, string>> }> | ExternalActionHeaderRefusal,
): Readonly<Record<string, string>> {
  if (!result.ok) throw createExternalActionHeaderRefusalError(result);
  return result.headers;
}
