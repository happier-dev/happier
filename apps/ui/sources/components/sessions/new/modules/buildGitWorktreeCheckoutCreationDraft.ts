import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';

export function buildGitWorktreeCheckoutCreationDraft(params: Readonly<{
    existingDraft: NewSessionCheckoutCreationDraft | null;
    /**
     * Authoritative, already-resolved display name (e.g. the user's chosen name
     * from the "name your worktree" step). When present and non-blank it wins
     * over both the preserved existing name and the fallback — the user has
     * explicitly named this worktree, so we never silently keep a prior name.
     */
    displayName?: string | null;
    fallbackDisplayName: string;
    baseRef?: string | null;
    branchMode?: 'new' | 'existing';
}>): NewSessionCheckoutCreationDraft {
    const branchMode = params.branchMode ?? 'new';

    const explicitDisplayName = params.displayName?.trim();
    if (explicitDisplayName) {
        return {
            kind: 'git_worktree',
            displayName: explicitDisplayName,
            baseRef: params.baseRef ?? null,
            branchMode,
        };
    }

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
