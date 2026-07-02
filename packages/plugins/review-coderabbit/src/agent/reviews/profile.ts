export function createCodeRabbitReviewExecutionProfile() {
  return {
    id: 'coderabbit.review',
    kind: 'executionRun.profile',
    version: '1',
    intent: 'review',
    displayKey: 'plugins.coderabbit.executionRuns.review.label',
    actionIds: ['review.start'],
  } as const;
}
