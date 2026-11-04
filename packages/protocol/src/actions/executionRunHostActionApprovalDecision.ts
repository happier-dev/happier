import type { ExecutionRunHostActionApprovalRequestV1 } from '../approvals/executionRunHostActionApprovalRequestV1.js';
import { executionRunHostActionApprovalSubjectsEqual, ExecutionRunHostActionApprovalSettlementV1Schema, StoredExecutionRunHostActionApprovalRequestV1Schema } from '../approvals/executionRunHostActionApprovalRequestV1.js';
import type { ActionExecuteResult } from './actionExecutionResult.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { canCredentialDecideV1 } from './decisionAuthority.js';
import { isApiTokenGrantTargetMemberV1 } from '../auth/apiTokenGrant.js';
import { getSharedBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { approvalReadFailure } from './executor/approvalRead.js';

/** Host current intent shares the authenticated Action admission and live coordinator. */
export function createExecutionRunHostActionApprovalDecision(deps: Readonly<{
  read: (artifactId: string) => Promise<ExecutionRunHostActionApprovalRequestV1 | null>;
  update: (args: Readonly<{ artifactId: string; request: ExecutionRunHostActionApprovalRequestV1 }>) => Promise<
    Readonly<{ ok: true } | { ok: false; errorCode: string; error?: string }>>;
  now?: () => number;
}>): NonNullable<ActionExecutorDeps['executionRunHostActionApprovalReplay']> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
  const result = (request: ExecutionRunHostActionApprovalRequestV1): ActionExecuteResult =>
    ({ ok: true, result: ExecutionRunHostActionApprovalSettlementV1Schema.parse({ ok: true, status: request.status }) });
  return async ({ artifactId, decision, initialRead, context, callerGrant, signal }) => {
    let existing: ExecutionRunHostActionApprovalRequestV1 | null;
    try {
      if (initialRead) {
        const parsed = StoredExecutionRunHostActionApprovalRequestV1Schema.safeParse(initialRead.request);
        existing = parsed.success ? parsed.data : null;
      } else existing = await deps.read(artifactId);
    } catch (error) { return approvalReadFailure(error); }
    if (!existing) return null;
    if (!canCredentialDecideV1({ authority: context?.authority ?? 'account_automation', grant: callerGrant ?? null })) {
      return failure('present_user_required');
    }
    if (context?.defaultSessionId && context.defaultSessionId !== existing.sessionId) return failure('approval_request_conflict');
    if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, { kind: 'session', sessionId: existing.sessionId },
      context?.defaultSessionMachineId)) return failure('credential_scope_denied');
    if (existing.status !== 'open') {
      if (existing.status === 'approved' && decision === 'approve') {
        signal?.throwIfAborted();
        // Repeated settlement is observation-only once the live waiter left.
        await coordinator.resolveBlockingDecision({ artifactId, request: existing, decision: 'approve',
          decisionAuthority: context?.authority ?? 'account_automation' });
        return result(existing);
      }
      return (existing.status === 'rejected' && decision === 'reject') || (existing.status === 'canceled' && decision === 'cancel')
        ? result(existing) : failure('approval_not_open');
    }
    if (decision === 'approve' && coordinator.getLiveWaiterCount(artifactId) === 0) return failure('approval_origin_unavailable');
    const now = Math.max((deps.now ?? Date.now)(), existing.updatedAtMs);
    const next: ExecutionRunHostActionApprovalRequestV1 = decision === 'cancel'
      ? { ...existing, status: 'canceled', updatedAtMs: now }
      : { ...existing, status: decision === 'approve' ? 'approved' : 'rejected', updatedAtMs: now,
        decision: { kind: decision, decidedAtMs: now,
          ...(context?.authority === 'present_user' ? { authority: 'present_user',
            ...((context.expectedAccountId ?? context.runtimeAccountId)
              ? { decidingAccountId: context.expectedAccountId ?? context.runtimeAccountId } : {}),
          } : {}),
        } };
    signal?.throwIfAborted();
    const updated = await deps.update({ artifactId, request: next });
    if (!updated.ok) return failure(updated.errorCode);
    let persisted: ExecutionRunHostActionApprovalRequestV1 | null;
    try { persisted = await deps.read(artifactId); } catch (error) { return approvalReadFailure(error); }
    if (!persisted) return failure('approval_not_found');
    if (!executionRunHostActionApprovalSubjectsEqual(existing, persisted)) return failure('approval_request_conflict');
    if (persisted.status !== next.status || persisted.decision?.kind !== next.decision?.kind) return failure('approval_not_open');
    signal?.throwIfAborted();
    if (decision === 'approve') {
      await coordinator.resolveBlockingDecision({ artifactId, request: persisted, decision,
        decisionAuthority: context?.authority ?? 'account_automation' });
    } else coordinator.notifyApprovalUpdated({ artifactId, request: persisted });
    return result(persisted);
  };
}
