import { DEEPSEC_REVIEW_MODES, DEEPSEC_THINKING_LEVELS } from './command.js';
import { DEEPSEC_REVIEW_PROFILE_ID, DEEPSEC_SECURITY_AUDIT_PROFILE_ID } from './profileMode.js';

export const DEEPSEC_AGENT_CLIS = ['claude', 'codex', 'both'] as const;

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
    metadata: { reviewCostConsentOption: 'confirmedCostWarning', reviewInstructionsInput: 'unsupported' },
    optionsInputHints: { fields: [{
      path: 'thinkingLevel', title: 'Reasoning effort', widget: 'select' as const,
      options: DEEPSEC_THINKING_LEVELS.map(value => ({ value, label: value })),
    }] },
    optionsSchema: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        mode: { type: 'string' as const, enum: [...DEEPSEC_REVIEW_MODES], title: 'Review scope' },
        profileId: { type: 'string' as const, enum: [DEEPSEC_REVIEW_PROFILE_ID, DEEPSEC_SECURITY_AUDIT_PROFILE_ID] },
        thinkingLevel: { type: 'string' as const, enum: [...DEEPSEC_THINKING_LEVELS], title: 'Reasoning effort' },
        agentCli: { type: 'string' as const, enum: [...DEEPSEC_AGENT_CLIS], title: 'Local agent' },
        confirmedCostWarning: { type: 'boolean' as const, title: 'Accept DeepSec charges', description: 'Every DeepSec review uses paid model access. Accept the charges for this start only; never saved as a preference.' },
        preferredExecutablePath: { type: 'string' as const, title: 'Executable path' },
        executablePath: { type: 'string' as const },
      },
    },
  };
}
