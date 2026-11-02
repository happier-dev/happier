import { isSessionStopConfirmed, SessionStopResultSchema } from '../../../sessions/control/contract.js';
import type { AdmittedActionInputById } from '../../actionSpecs.js';
import { completeActionResult } from '../resultProjection.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';

/** Home decides whether Stop is needed; Stop decides when deletion may be retried. */
export async function executeSessionDelete(params: Readonly<{
  input: AdmittedActionInputById['session.delete'];
  context: ActionExecutorContext;
  deps: Pick<ActionExecutorDeps, 'homeDomainAction'>;
  isDeferredApprovalResult(result: ActionExecuteResult): boolean;
}>): Promise<ActionExecuteResult> {
  const { input, context, deps } = params;
  const home = deps.homeDomainAction;
  if (!home) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.delete' };
  const remove = async () => completeActionResult(await home({ actionId: 'session.delete', input, context,
    ...(context.signal ? { signal: context.signal } : {}) }));
  const initial = await remove();
  if (initial.ok || initial.errorCode !== 'session_active') return initial;
  if (!context.hostReviewedChild) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
  const stopped = await context.hostReviewedChild.invoke({ action: 'session.stop', role: 'stop', input: { sessionId: input.sessionId } });
  if (!stopped.ok || params.isDeferredApprovalResult(stopped)) return stopped;
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const stop = SessionStopResultSchema.safeParse(stopped.result);
  if (!stop.success || !isSessionStopConfirmed(stop.data)) {
    return { ok: false, errorCode: 'session_stop_unconfirmed', error: 'session_stop_unconfirmed' };
  }
  return await remove();
}
