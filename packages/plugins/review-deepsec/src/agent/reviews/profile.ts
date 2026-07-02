export type DeepSecReviewProfileKind = 'review' | 'repository_security_audit';

export function createDeepSecReviewExecutionProfile(kind: DeepSecReviewProfileKind) {
  if (kind === 'repository_security_audit') {
    return {
      id: 'deepsec.securityReview',
      kind: 'executionRun.profile',
      version: '1',
      intent: 'review',
      displayKey: 'plugins.deepsec.executionRuns.securityReview.label',
      actionIds: ['review.start'],
    } as const;
  }
  return {
    id: 'deepsec.review',
    kind: 'executionRun.profile',
    version: '1',
    intent: 'review',
    displayKey: 'plugins.deepsec.executionRuns.review.label',
    actionIds: ['review.start'],
  } as const;
}
