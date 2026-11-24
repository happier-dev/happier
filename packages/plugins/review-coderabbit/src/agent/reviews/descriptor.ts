export const coderabbitReviewDescriptor = Object.freeze({
  id: 'coderabbit',
  displayKey: 'plugins.coderabbit.name',
  capabilities: {
    session: { supported: false },
    executionRun: {
      supported: true,
      review: {
        intents: ['review'],
        modes: ['change_scoped_review'],
        taxonomyFamilies: ['style', 'correctness', 'maintainability'],
        requiresSystemCli: 'coderabbit',
        requiredSecrets: [],
        costClass: 'metered',
        cancellation: { supportsAbort: true, processTree: true },
        directCommentWrite: false,
      },
    },
  },
} as const);
