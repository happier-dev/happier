import { buildScmReviewedMarksKey, createScmReviewedMarksRecordPort } from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmComparison, ScmReviewedMarkResponse } from '@happier-dev/protocol/scm';
import { createCliAccountKvJsonTransport, type CliAccountKvJsonTransportParams } from '@/api/client/accountKvJsonTransport';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

type AccountMarkParams = Omit<CliAccountKvJsonTransportParams, 'key'> & Readonly<{
  comparison: ScmComparison;
  /** Actual authenticated requester from the host ingress, never Action input. */
  requesterAccountId?: string;
}>;
function port(params: AccountMarkParams) {
  // Account crypto and the token are a pair. A Machine collaborator's identity
  // cannot turn the custodian's pair into that collaborator's personal record.
  if (params.requesterAccountId !== undefined && params.requesterAccountId !== readAccountIdFromToken(params.credentials.token)) {
    throw Object.assign(new Error('Authenticated requester Account material is unavailable'), { code: 'reviewed_marks_unavailable' });
  }
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
