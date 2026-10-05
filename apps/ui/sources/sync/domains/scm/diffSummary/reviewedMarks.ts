import type { ScmReviewedMarksRecord } from '@happier-dev/protocol/scm';

export type ScmReviewedMarksState = Readonly<{
  status: 'idle' | 'ready' | 'error' | 'retired'; record: ScmReviewedMarksRecord | null; version: number; errorCode?: string;
}>;
export function createScmReviewedMarksState(): ScmReviewedMarksState { return { status: 'idle', record: null, version: -1 }; }
export function reconcileScmReviewedMarksState(current: ScmReviewedMarksState, next: ScmReviewedMarksState): ScmReviewedMarksState {
  if (next.status === 'ready' && next.version < current.version) return current;
  const equalRecord = current.record === next.record || (current.record !== null && next.record !== null
    && current.record.comparisonId === next.record.comparisonId
    && current.record.reviewedChangeRefs.length === next.record.reviewedChangeRefs.length
    && current.record.reviewedChangeRefs.every((ref, index) => ref === next.record?.reviewedChangeRefs[index]));
  if (equalRecord && current.status === next.status && current.version === next.version && current.errorCode === next.errorCode) return current;
  return equalRecord ? { ...next, record: current.record } : next;
}
