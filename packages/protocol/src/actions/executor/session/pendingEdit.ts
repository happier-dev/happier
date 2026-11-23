import { SessionPendingEditInputV1Schema, SessionPendingRetryInputV1Schema } from '../../specs/session/pendingEdit.js';
import { clientActionUnavailable } from '../../clientDispatchV1.js';
import { withoutClientActionInput } from '../../clientActionInput.js';
import { completeActionResult } from '../resultProjection.js';
import type { CoreInvocation } from '../coreInvocation.js';

export async function dispatchSessionPendingClientAction(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'ctx' | 'deps'>) {
  if (inv.actionId === 'session.pending.retry') {
    const retryRequested = await inv.deps.sessionPendingRetry?.({
      input: SessionPendingRetryInputV1Schema.parse(withoutClientActionInput(inv.parsed.data)), context: inv.ctx,
    });
    return retryRequested ? completeActionResult({ status: 'retry_requested' }) : clientActionUnavailable(inv.actionId);
  }
  if (inv.actionId !== 'session.pending.edit') return null;
  if (!inv.deps.sessionPendingEdit) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
  return completeActionResult(await inv.deps.sessionPendingEdit({
    input: SessionPendingEditInputV1Schema.parse(withoutClientActionInput(inv.parsed.data)), context: inv.ctx,
  }));
}
