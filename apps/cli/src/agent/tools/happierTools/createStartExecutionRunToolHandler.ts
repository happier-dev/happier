import type { ActionId } from '@happier-dev/protocol';

import type { ExecutionRunServiceResult } from '@/session/services/executionRuns';

import { normalizeExecutionRunToolResult } from './normalizeExecutionRunToolResult';
import type { HappierBuiltInToolDispatchResult } from './types';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{ defaultSessionId: string; surface: 'mcp' | 'cli' | 'session_agent' }>,
  ) => Promise<ActionExecutorResult>;
}>;

function isExecutionRunServiceResult(value: unknown): value is ExecutionRunServiceResult<unknown> {
  return Boolean(value) && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok');
}

export function createStartExecutionRunToolHandler(params: Readonly<{
  executor: ActionExecutorLike;
  surface: 'mcp' | 'cli' | 'session_agent';
}>): (sessionId: string, request: unknown) => Promise<HappierBuiltInToolDispatchResult> {
  return async (sessionId: string, request: unknown) => {
    const res = await params.executor.execute(
      'execution.run.start',
      request,
      { surface: params.surface, defaultSessionId: sessionId },
    );

    if (!res.ok) {
      return { ok: false, errorCode: res.errorCode, error: res.error };
    }

    if (res.result && typeof res.result === 'object' && (res.result as any).kind === 'approval_request_created') {
      return { ok: true, result: res.result };
    }

    if (!isExecutionRunServiceResult(res.result)) {
      return { ok: false, errorCode: 'invalid_execution_run_result', error: 'invalid_execution_run_result' };
    }

    return normalizeExecutionRunToolResult(res.result);
  };
}
