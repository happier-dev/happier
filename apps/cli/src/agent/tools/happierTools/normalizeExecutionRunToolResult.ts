import type { ExecutionRunServiceResult, WaitForExecutionRunResult } from '@/session/services/executionRuns';

import type { HappierBuiltInToolDispatchResult } from './types';

export function normalizeExecutionRunToolResult(
  result: ExecutionRunServiceResult<unknown> | WaitForExecutionRunResult,
): HappierBuiltInToolDispatchResult {
  if (!result.ok) {
    return { ok: false, errorCode: result.code, error: result.message ?? result.code };
  }

  if ('data' in result) {
    return { ok: true, result: result.data };
  }

  const { ok: _ok, ...payload } = result;
  return { ok: true, result: payload };
}
