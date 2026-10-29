import { ActionIdSchema } from '../actions/actionIds.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { requiresPresentUserExecutionAuthorityForActionInputV1 } from '../actions/decisionAuthority.js';
import { ExternalActionRequestIdV1Schema } from '../actions/externalActionApi.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import type { ApprovalRequest } from './approvalRequestV1.js';

export const LIVE_CLI_APPROVAL_DECIDE_METHOD = 'approval.origin.decide';
const prefix = 'approval-origin.';

/** Private Account input remains with the live standalone terminal, not its daemon. */
export function requiresLiveCliApprovalOrigin(request: ApprovalRequest): boolean {
  if (request.v !== 2 || request.approval?.flow !== 'blocking' || request.requesterConfirmation) return false;
  const origin = request.executionOriginV1;
  const actionId = ActionIdSchema.safeParse(request.actionId);
  if (!actionId.success || origin.surface !== 'cli' || origin.caller.kind !== 'host'
    || !origin.accountId || !origin.serverIdentityId || origin.target || origin.sessionId
    || origin.runId || origin.runOccurrenceId || origin.sessionInputSource
    || origin.externalActionExecutionAuthorization || origin.externalActionInputSignature
    || origin.originalActionEnvelope || origin.principalId || origin.credentialId) return false;
  const spec = getActionSpec(actionId.data);
  return spec.approvalInputCustody === 'live_only' && spec.approvalResultCustody !== 'live_only'
    && spec.executionPlacement === 'account' && spec.executionPlacementForInput === undefined
    && spec.requiredAuthority === 'account_automation'
    && !requiresPresentUserExecutionAuthorityForActionInputV1(spec, request.actionArgs);
}

export function liveCliApprovalOriginScope(requestId: string): string {
  // JSON preserves distinct lone surrogates; the existing digest bounds Unicode
  // request IDs without putting any private operand into the routing address.
  const identity = JSON.stringify(ExternalActionRequestIdV1Schema.parse(requestId));
  return `${prefix}${computeCanonicalDomainSeparatedDigest('happier.approval.live-cli-origin.v1', [identity])}`;
}

export function isLiveCliApprovalOriginMethod(method: string): boolean {
  const suffix = `:${LIVE_CLI_APPROVAL_DECIDE_METHOD}`;
  return method.startsWith(prefix) && method.endsWith(suffix)
    && /^[A-Za-z0-9_-]{43}$/.test(method.slice(prefix.length, -suffix.length));
}
