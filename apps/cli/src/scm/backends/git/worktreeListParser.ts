import type { ScmWorktree } from '@happier-dev/protocol';

function normalizeBranchRef(rawBranch: string | null): string | null {
    if (!rawBranch) return null;
    const trimmed = rawBranch.trim();
    if (!trimmed) return null;
    return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed;
}

export function parseGitWorktreeListPorcelain(input: {
    worktreesOutput: string;
    currentWorktreePath: string | null;
    mainWorktreePath?: string | null;
}): ReadonlyArray<ScmWorktree> {
    const lines = input.worktreesOutput.split('\n');
    const currentPath = input.currentWorktreePath?.trim() || null;
    const mainPath = input.mainWorktreePath?.trim() || null;
    const worktrees: ScmWorktree[] = [];

    let activePath: string | null = null;
    let activeBranch: string | null = null;

    const flush = () => {
        const path = activePath?.trim() || null;
        if (!path) return;
        worktrees.push({
            path,
            branch: normalizeBranchRef(activeBranch),
            isCurrent: currentPath === path,
            isMain: mainPath === path,
        });
        activePath = null;
        activeBranch = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            flush();
            continue;
        }
        if (line.startsWith('worktree ')) {
            flush();
            activePath = line.slice('worktree '.length);
            continue;
        }
        if (line.startsWith('branch ')) {
            activeBranch = line.slice('branch '.length);
        }
    }

    flush();

    return worktrees.sort((left, right) => left.path.localeCompare(right.path));
}
