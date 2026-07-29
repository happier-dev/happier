export function createCodeRabbitReviewExecutionProfile() {
  return {
    id: 'review',
    intent: 'review' as const,
    title: 'CodeRabbit review',
    description: 'Review the current change with CodeRabbit.',
    promptAsset: 'review-prompt',
    actions: [{ kind: 'hostAction' as const, actionId: 'reviews.comments.create' as const }],
    defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
    compatibleAgents: ['coderabbit'],
  };
}
