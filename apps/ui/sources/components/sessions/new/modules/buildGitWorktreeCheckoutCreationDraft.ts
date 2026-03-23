import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';

export function buildGitWorktreeCheckoutCreationDraft(params: Readonly<{
    existingDraft: NewSessionCheckoutCreationDraft | null;
    fallbackDisplayName: string;
    baseRef?: string | null;
    branchMode?: 'new' | 'existing';
}>): NewSessionCheckoutCreationDraft {
    const branchMode = params.branchMode ?? 'new';

    if (params.existingDraft?.kind === 'git_worktree' && params.existingDraft.branchMode === 'new' && branchMode === 'new') {
        return {
            ...params.existingDraft,
            baseRef: params.baseRef ?? null,
            branchMode,
        };
    }

    return {
        kind: 'git_worktree',
        displayName: params.fallbackDisplayName,
        baseRef: params.baseRef ?? null,
        branchMode,
    };
}
