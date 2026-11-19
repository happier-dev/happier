export const CODERABBIT_REVIEW_SCOPES: readonly ('worktree' | 'paths')[] = ['worktree'];

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
    optionsSchema: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        configFiles: { type: 'array' as const, title: 'Instruction files', items: { type: 'string' as const } },
        gate: { type: 'string' as const, title: 'Severity gate', description: 'Request a fresh review and report findings at or above this severity as a blocked gate.', enum: ['critical', 'major', 'minor', 'trivial', 'info'] },
      },
    },
    metadata: { reviewScopes: CODERABBIT_REVIEW_SCOPES, reviewInstructionsInput: 'unsupported' },
  };
}
