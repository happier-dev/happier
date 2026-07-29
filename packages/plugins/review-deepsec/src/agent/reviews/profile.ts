export type DeepSecReviewProfileKind = 'review' | 'repository_security_audit';
export function createDeepSecReviewExecutionProfile(kind: DeepSecReviewProfileKind) {
  const repositoryAudit = kind === 'repository_security_audit';
  return {
    id: repositoryAudit ? 'repository-security-audit' : 'review',
    intent: 'review' as const,
    title: repositoryAudit ? 'DeepSec repository security audit' : 'DeepSec review',
    description: repositoryAudit
      ? 'Run a repository-wide DeepSec security audit.'
      : 'Review the current change with DeepSec.',
    promptAsset: repositoryAudit ? 'repository-security-audit-prompt' : 'review-prompt',
    actions: [{ kind: 'hostAction' as const, actionId: 'reviews.comments.create' as const }],
    defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
    compatibleAgents: ['deepsec'],
  };
}
