import { buildScmReviewedMarksKey, createScmReviewedMarksRecordPort } from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmComparison, ScmReviewedMarkResponse } from '@happier-dev/protocol/scm';
import { createCliAccountKvJsonTransport, type CliAccountKvJsonTransportParams } from '@/api/client/accountKvJsonTransport';

type AccountMarkParams = Omit<CliAccountKvJsonTransportParams, 'key'> & Readonly<{ comparison: ScmComparison }>;
function port(params: AccountMarkParams) {
  return createScmReviewedMarksRecordPort({ comparison: params.comparison,
    transport: createCliAccountKvJsonTransport({ ...params, key: buildScmReviewedMarksKey(params.comparison.id) }) });
}
async function execute(operation: () => Promise<ScmReviewedMarkResponse>): Promise<ScmReviewedMarkResponse> {
  try { return await operation(); }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : 'reviewed_marks_unavailable';
    return { success: false, errorCode: code, error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' };
  }
}
/** Called only for an explicitly admitted personal Action with an authorized saved comparison. */
export function createCliScmReviewedMarkAction(params: AccountMarkParams & Readonly<{ changeRefs: readonly string[]; reviewed: boolean }>): Promise<ScmReviewedMarkResponse> {
  return execute(() => port(params).setReviewed(params.changeRefs, params.reviewed));
}
export function clearCliScmReviewedMarks(params: AccountMarkParams): Promise<ScmReviewedMarkResponse> {
  return execute(() => port(params).clear());
}
