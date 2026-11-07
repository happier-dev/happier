import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { refuseExternalActionPhase } from '@/daemon/externalActions/externalActionPhase';

/** Diagnostic outcome of the incumbent issuer, never a second admission decision. */
export type ExternalActionIssuerRefusal = Readonly<{
  ok: false;
  phase: 'preparation' | 'mint' | 'binding' | 'requester_bootstrap';
  requiredFact: string;
  code?: string;
  details?: unknown;
  failureCause?: ActionExecuteFailure['failureCause'];
}>;

/** Existing Action failure vocabulary carries the issuer's decision to the agent. */
export function projectSessionActionIssuerRefusal(refusal: ExternalActionIssuerRefusal,
  machineId?: string, signal?: AbortSignal): ActionExecuteFailure {
  if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const phase = `session.authorization.${refusal.phase}`;
  const ownerDetails = refusal.details && typeof refusal.details === 'object' ? refusal.details : {};
  const requiredFact = 'requiredFact' in ownerDetails && typeof ownerDetails.requiredFact === 'string'
    ? ownerDetails.requiredFact : refusal.requiredFact;
  const remedy = 'remedy' in ownerDetails && typeof ownerDetails.remedy === 'string'
    ? ownerDetails.remedy : refusal.phase === 'mint'
      ? 'Reconnect this Account to its Home, then retry from a fresh Session'
      : refusal.phase === 'binding'
        ? 'Update Home and this Machine, then retry from a fresh Session'
        : 'Start a fresh Session on the connected Machine, then retry the action';
  const errorCode = refusal.code === 'credential_scope_denied' || refusal.code === 'present_user_required'
    ? refusal.code : 'action_forbidden';
  // Only our static branch fact is logged, never Home details, proof, or input.
  refuseExternalActionPhase(phase, machineId, undefined, { refusalBranch: refusal.requiredFact });
  return { ok: false, errorCode, error: errorCode,
    details: { ...ownerDetails, reason: 'external_authorization_refused', phase, requiredFact, remedy },
    failureCause: refusal.failureCause ?? projectActionFailureCauseV1({ code: errorCode }, phase) };
}
