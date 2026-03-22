import type { ExecutionRunServiceResult } from '@/session/services/executionRuns';

import type { HappierBuiltInToolDispatchResult } from './types';

export function normalizeExecutionRunToolResult(
  result: ExecutionRunServiceResult<unknown>,
): HappierBuiltInToolDispatchResult {
  return result.ok
    ? { ok: true, result: result.data }
    : { ok: false, errorCode: result.code, error: result.message ?? result.code };
}
