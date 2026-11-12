import { readSessionStopConfirmationFailure } from './stopConfirmation.js';
import type { AdmittedActionInputById } from '../../actionSpecs.js';
import { completeActionResult } from '../resultProjection.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';

/** Home decides whether Stop is needed; Stop decides when deletion may be retried. */
export async function executeSessionDelete(params: Readonly<{
  input: AdmittedActionInputById['session.delete'];
  context: ActionExecutorContext;
  deps: Pick<ActionExecutorDeps, 'homeDomainAction' | 'detachedSessionDelete'>;
  isDeferredApprovalResult(result: ActionExecuteResult): boolean;
}>): Promise<ActionExecuteResult> {
  const { input, context, deps } = params;
  if ('runId' in input) {
    if (!deps.detachedSessionDelete) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.delete' };
    return completeActionResult(await deps.detachedSessionDelete({ input, context }));
  }
  const home = deps.homeDomainAction;
  if (!home) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.delete' };
  const remove = async (): Promise<ActionExecuteResult> => {
    const result = completeActionResult(await home({ actionId: 'session.delete', input, context,
      ...(context.signal ? { signal: context.signal } : {}) }));
    return !result.ok && result.errorCode === 'session_absent' ? { ok: true, result: { success: true } } : result;
  };
  const initial = await remove();
  if (initial.ok || initial.errorCode !== 'session_active') return initial;
  if (!context.hostReviewedChild) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
  const stopped = await context.hostReviewedChild.invoke({ action: 'session.stop', role: 'stop', input: { sessionId: input.sessionId } });
  if (!stopped.ok || params.isDeferredApprovalResult(stopped)) return stopped;
  if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const stopFailure = readSessionStopConfirmationFailure(input.sessionId, stopped.result);
  if (stopFailure) return stopFailure;
  return await remove();
}
