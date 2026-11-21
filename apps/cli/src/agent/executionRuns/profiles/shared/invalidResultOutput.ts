import type { decodeExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';

import type { ExecutionRunProfileBoundedCompleteResult } from '../ExecutionRunIntentProfile';

type ResultDecodeFailure = Extract<ReturnType<typeof decodeExecutionRunProfileResult>, { ok: false }>;

/**
 * A refused result names why: the decoder's reason and the schema pointers it failed at. Those are schema words,
 * never the output itself, so the run record can say whether the model or the contract was wrong (AUTO-FIX-W16: a
 * deploy_suggestion run failed `invalid_output` with nothing kept to decide it).
 */
export function invalidProfileResultOutput(lead: string, decoded: ResultDecodeFailure): ExecutionRunProfileBoundedCompleteResult {
  const first = decoded.issues?.[0];
  return {
    status: 'failed',
    summary: `${lead} (${decoded.reason}${first ? `: ${first.pointer || '/'} ${first.message}` : ''}).`,
    toolResultOutput: { error: { code: 'invalid_output', reason: decoded.reason,
      ...(decoded.issues?.length ? { issues: decoded.issues } : {}) } },
  };
}
