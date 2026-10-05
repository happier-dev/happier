import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { parseSessionBoardActionPortResultV1 } from '../sessions/board/actions.js';
import { admitWidgetActionSurfaceV1 } from './widgetActionScopeV1.js';
import { buildWidgetSnapshotBoardUpsertV1, WidgetSnapshotPostInputV1Schema } from './widgetSnapshotV1.js';

/** Invoked only after the existing configurable Action approval owner admits publication. */
export async function executeWidgetSnapshotPostV1(
  deps: ActionExecutorDeps, input: unknown, context: ActionExecutorContext,
): Promise<ActionExecuteResult> {
  const args = WidgetSnapshotPostInputV1Schema.parse(input);
  const refusal = admitWidgetActionSurfaceV1(deps, args.surface, context);
  if (refusal) return refusal;
  if (!deps.sessionBoardAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
  const boardInput = buildWidgetSnapshotBoardUpsertV1(args);
  // The Board port rechecks Session editor/audience/mode rights before its one sealed mutation.
  const lastRefusal = admitWidgetActionSurfaceV1(deps, args.surface, context);
  if (lastRefusal) return lastRefusal;
  const result = await deps.sessionBoardAction({ actionId: 'session.board.item.upsert', input: boardInput, context,
    ...(context.signal ? { signal: context.signal } : {}) });
  const validated = parseSessionBoardActionPortResultV1('session.board.item.upsert', boardInput, result, {
    expectedSessionId: boardInput.sessionId, expectedServerId: args.surface.serverId,
  });
  if (!validated.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  return validated.kind === 'failure' ? validated.data as Extract<ActionExecuteResult, { ok: false }>
    : { ok: true, result: validated.data };
}
