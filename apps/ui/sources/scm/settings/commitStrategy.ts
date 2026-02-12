import type { ScmCommitCreateRequest } from '@happier-dev/protocol';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export const SCM_COMMIT_STRATEGIES = ['atomic', 'git_staging'] as const;
export type ScmCommitStrategy = (typeof SCM_COMMIT_STRATEGIES)[number];

export function isAtomicCommitStrategy(strategy: ScmCommitStrategy): boolean {
    return strategy === 'atomic';
}

export function allowsLiveStaging(input: {
    strategy: ScmCommitStrategy;
    snapshot: ScmWorkingSnapshot | null | undefined;
}): boolean {
    if (isAtomicCommitStrategy(input.strategy)) {
        return false;
    }
    return input.snapshot?.capabilities?.writeInclude === true
        && input.snapshot?.capabilities?.writeExclude === true;
}

export function resolveCommitScopeForStrategy(
    strategy: ScmCommitStrategy,
    options?: { selectedPaths?: string[] | null }
): ScmCommitCreateRequest['scope'] | undefined {
    if (isAtomicCommitStrategy(strategy)) {
        const selectedPaths = normalizeCommitSelectionPaths(options?.selectedPaths);
        if (selectedPaths.length > 0) {
            return {
                kind: 'paths',
                include: selectedPaths,
            };
        }
        return { kind: 'all-pending' };
    }
    return undefined;
}

function normalizeCommitSelectionPaths(paths: string[] | null | undefined): string[] {
    if (!paths || paths.length === 0) {
        return [];
    }

    const unique = new Set<string>();
    for (const path of paths) {
        const normalized = typeof path === 'string' ? path.trim() : '';
        if (!normalized) continue;
        unique.add(normalized);
    }

    return Array.from(unique).sort((a, b) => a.localeCompare(b));
}
