export function createPanelReviewExecutionProfile() {
  return {
    id: 'review', intent: 'review' as const, title: 'Panel review',
    description: 'Run a single reviewer or a repository-configured native panel.',
    promptAsset: 'review-prompt', compatibleAgents: ['panels'],
    actions: [{ kind: 'hostAction' as const, actionId: 'reviews.comments.create' as const }],
    defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
    optionsSchema: {
      type: 'object' as const, additionalProperties: false as const,
      properties: {
        panel: { type: 'string' as const, title: 'Panel', description: 'Panel name from repository configuration. Use none for one reviewer.' },
        reviewType: { type: 'string' as const, title: 'Review type', enum: ['exhaustive', 'security', 'design', 'lookahead', 'test-value'] },
        agent: { type: 'string' as const, title: 'Native agent', description: 'Executable Agent configured on this Machine, such as codex or claude-code.' },
        reasoning: { type: 'string' as const, title: 'Reasoning effort', enum: ['fast', 'standard', 'thorough', 'maximum', 'low', 'medium', 'high', 'xhigh', 'max'] },
      },
    },
    metadata: { reviewScopes: ['worktree'] },
  };
}

/** Values have already crossed the shared profile options admission boundary. */
export type PanelReviewOptions = Readonly<{ panel?: string; reviewType?: string; agent?: string; reasoning?: string }>;
