import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import type { WidgetSurfaceRefV1 } from './widgetInstanceV1.js';

/** Captured host authority admits metadata reads and instance operations alike. */
export function admitWidgetActionSurfaceV1(
  deps: Pick<ActionExecutorDeps, 'widgetAccountScope'>,
  surface: WidgetSurfaceRefV1,
  context: ActionExecutorContext,
): ActionExecuteFailure | null {
  const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  if (context.signal?.aborted) return failure('cancelled');
  let scope: ReturnType<NonNullable<ActionExecutorDeps['widgetAccountScope']>>;
  try { scope = deps.widgetAccountScope?.() ?? null; }
  catch { return failure('widget_scope_unavailable'); }
  if (!scope) return failure('widget_scope_unavailable');
  if (scope.serverId !== surface.serverId || context.serverId && context.serverId !== surface.serverId)
    return failure('server_target_mismatch');
  if (scope.accountId !== surface.accountId) return failure('account_target_mismatch');
  return null;
}
