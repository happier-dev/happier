export const deepsecReviewDescriptor = Object.freeze({
  id: 'deepsec',
  displayKey: 'plugins.deepsec.name',
  capabilities: {
    session: { supported: false },
    executionRun: {
      supported: true,
      review: {
        intents: ['review'],
        modes: ['repository_security_audit', 'change_scoped_review'],
        requiresSystemCli: 'deepsec',
        requiredPrerequisites: ['node>=22', 'claude-or-codex', 'AI_GATEWAY_API_KEY'],
        directCommentWrite: false,
        taxonomyFamilies: ['security', 'cwe', 'cve', 'secrets'],
        costClass: 'expensive',
        cancellation: { supportsAbort: true, processTree: true },
      },
    },
  },
} as const);
