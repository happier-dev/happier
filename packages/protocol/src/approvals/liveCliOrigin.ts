import { ExternalActionRequestIdV1Schema } from '../actions/externalActionApi.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import type { ApprovalRequest } from './approvalRequestV1.js';
import type { TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';
import { isTargetApproval, resolveApprovalExecutor } from './resolveApprovalExecutor.js';

export const LIVE_CLI_APPROVAL_DECIDE_METHOD = 'approval.origin.decide';
const prefix = 'approval-origin.';

export function liveCliApprovalOriginScope(requestId: string): string {
  // JSON preserves distinct lone surrogates; the existing digest bounds Unicode
  // request IDs without putting any private operand into the routing address.
  const identity = JSON.stringify(ExternalActionRequestIdV1Schema.parse(requestId));
  return `${prefix}${computeCanonicalDomainSeparatedDigest('happier.approval.live-cli-origin.v1', [identity])}`;
}

/** Address published by the standalone terminal, never by a signed daemon invocation. */
export function readLiveCliApprovalOriginScope(request: ApprovalRequest | TargetActionApprovalRequestV1): string | null {
  if (!isTargetApproval(request) && request.v !== 2) return null;
  const executor = resolveApprovalExecutor(request);
  if (executor.kind !== 'live_invocation' || executor.daemonMachineId) return null;
  const origin = request.executionOriginV1;
  return origin?.surface === 'cli' && origin.caller.kind === 'host'
    ? liveCliApprovalOriginScope(origin.requestId) : null;
}

export function isLiveCliApprovalOriginMethod(method: string): boolean {
  const suffix = `:${LIVE_CLI_APPROVAL_DECIDE_METHOD}`;
  return method.startsWith(prefix) && method.endsWith(suffix)
    && /^[A-Za-z0-9_-]{43}$/.test(method.slice(prefix.length, -suffix.length));
}
