import type { decodeExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';

import type { ExecutionRunProfileBoundedCompleteResult } from '../ExecutionRunIntentProfile';

type ResultDecodeFailure = Extract<ReturnType<typeof decodeExecutionRunProfileResult>, { ok: false }>;

/**
 * A refused result names why: the decoder's reason and where in the schema its first issue failed. Only the schema
 * side is kept (schema path, keyword, and AJV's schema-worded message), never the instance pointer, which can name a
 * key the model wrote, and only the one issue the summary reads (AUTO-FIX-W16 item 4, REVIEW-DELTA7 F2).
 */
export function invalidProfileResultOutput(lead: string, decoded: ResultDecodeFailure): ExecutionRunProfileBoundedCompleteResult {
  const first = decoded.issues?.[0];
  const issue = first ? { schemaPath: first.schemaPath, keyword: first.keyword, message: first.message } : null;
  return {
    status: 'failed',
    summary: `${lead} (${decoded.reason}${issue ? `: ${issue.schemaPath} ${issue.message}` : ''}).`,
    toolResultOutput: { error: { code: 'invalid_output', reason: decoded.reason, ...(issue ? { issue } : {}) } },
  };
}
