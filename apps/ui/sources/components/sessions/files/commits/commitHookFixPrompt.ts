import { t } from '@/text';

import type { CommitProposal } from './commitProposal';

/**
 * What "Ask this session to fix it" (lab WT4-C4) puts in the Session composer: which hook stopped which
 * commit, and exactly what it reported. Null unless a hook stopped the run.
 */
export function buildCommitHookFixPrompt(proposal: CommitProposal): string | null {
    const outcome = proposal.outcome;
    if (outcome?.kind !== 'hookFailed') return null;
    const group = proposal.groups.find((candidate) => candidate.id === outcome.groupId);
    if (!group) return null;
    const head = outcome.hookName
        ? t('commitProposal.askFix', { hook: outcome.hookName, number: group.number, message: group.message })
        : t('commitProposal.askFixGeneric', { number: group.number, message: group.message });
    const output = outcome.output?.replace(/\n+$/, '');
    return output ? `${head}\n\n\`\`\`\n${output}\n\`\`\`` : head;
}
