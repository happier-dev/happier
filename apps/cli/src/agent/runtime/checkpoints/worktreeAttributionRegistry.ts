import type { RepositoryCheckpointAttributionScope } from '@/scm/checkpoints';

export type WorktreeAttributionInterval = Readonly<{
    repoRoot: string;
    intervalId: string;
}>;

export type WorktreeAttributionRegistry = Readonly<{
    begin: (input: WorktreeAttributionInterval) => WorktreeAttributionInterval;
    end: (input: WorktreeAttributionInterval) => void;
    resolveAttributionScope: (input: WorktreeAttributionInterval) => RepositoryCheckpointAttributionScope;
}>;

function normalizeRepoRoot(repoRoot: string): string {
    return repoRoot.trim();
}

export function createWorktreeAttributionRegistry(): WorktreeAttributionRegistry {
    const activeByRepoRoot = new Map<string, Set<string>>();

    return {
        begin(input) {
            const repoRoot = normalizeRepoRoot(input.repoRoot);
            const intervalId = input.intervalId.trim();
            if (!repoRoot || !intervalId) return input;
            const active = activeByRepoRoot.get(repoRoot) ?? new Set<string>();
            active.add(intervalId);
            activeByRepoRoot.set(repoRoot, active);
            return { repoRoot, intervalId };
        },
        end(input) {
            const repoRoot = normalizeRepoRoot(input.repoRoot);
            const active = activeByRepoRoot.get(repoRoot);
            if (!active) return;
            active.delete(input.intervalId.trim());
            if (active.size === 0) {
                activeByRepoRoot.delete(repoRoot);
            }
        },
        resolveAttributionScope(input) {
            const repoRoot = normalizeRepoRoot(input.repoRoot);
            const active = activeByRepoRoot.get(repoRoot);
            return active && active.size > 1 ? 'shared_worktree' : 'unknown';
        },
    };
}

export const defaultWorktreeAttributionRegistry = createWorktreeAttributionRegistry();
