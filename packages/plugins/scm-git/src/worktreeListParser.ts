import type { ScmWorktree } from '@happier-dev/plugin-sdk/experimental/scm';

import { deriveGitWorktreeId } from './deriveGitWorktreeId.js';

function normalizeBranchRef(rawBranch: string | null): string | null {
    if (!rawBranch) return null;
    const trimmed = rawBranch.trim();
    if (!trimmed) return null;
    return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed;
}

function normalizeGitPathToken(rawPath: string | null | undefined): string | null {
    if (rawPath === null || rawPath === undefined || rawPath.length === 0) {
        return null;
    }
    return rawPath;
}

export function parseGitWorktreeListPorcelain(input: {
    worktreesOutput: string;
    currentWorktreePath: string | null;
    mainWorktreePath?: string | null;
}): ReadonlyArray<ScmWorktree> {
    if (input.worktreesOutput.includes('\0')) {
        return parseGitWorktreeListPorcelainZ(input);
    }

    const lines = input.worktreesOutput.split('\n');
    const currentPath = input.currentWorktreePath?.trim() || null;
    const mainPath = input.mainWorktreePath?.trim() || null;
    const worktrees: ScmWorktree[] = [];

    let activePath: string | null = null;
    let activeBranch: string | null = null;
    let activeIsPrunable = false;

    const flush = () => {
        const path = activePath?.trim() || null;
        if (!path) return;
        worktrees.push({
            id: deriveGitWorktreeId(path),
            path,
            branch: normalizeBranchRef(activeBranch),
            isCurrent: currentPath === path,
            isMain: mainPath === path,
            ...(activeIsPrunable ? { isPrunable: true } : {}),
        });
        activePath = null;
        activeBranch = null;
        activeIsPrunable = false;
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
            continue;
        }
        if (line.startsWith('prunable ')) {
            activeIsPrunable = true;
        }
    }

    flush();

    return worktrees.sort((left, right) => left.path.localeCompare(right.path));
}

function parseGitWorktreeListPorcelainZ(input: {
    worktreesOutput: string;
    currentWorktreePath: string | null;
    mainWorktreePath?: string | null;
}): ReadonlyArray<ScmWorktree> {
    const tokens = input.worktreesOutput.split('\0');
    const currentPath = normalizeGitPathToken(input.currentWorktreePath);
    const mainPath = normalizeGitPathToken(input.mainWorktreePath);
    const worktrees: ScmWorktree[] = [];

    let activePath: string | null = null;
    let activeBranch: string | null = null;
    let activeIsPrunable = false;

    const flush = () => {
        const path = normalizeGitPathToken(activePath);
        if (!path) return;
        worktrees.push({
            id: deriveGitWorktreeId(path),
            path,
            branch: normalizeBranchRef(activeBranch),
            isCurrent: currentPath === path,
            isMain: mainPath === path,
            ...(activeIsPrunable ? { isPrunable: true } : {}),
        });
        activePath = null;
        activeBranch = null;
        activeIsPrunable = false;
    };

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        if (token.length === 0) {
            flush();
            continue;
        }
        if (token === 'worktree') {
            flush();
            const pathToken = tokens[index + 1];
            if (pathToken !== undefined) {
                activePath = pathToken;
                index += 1;
            }
            continue;
        }
        if (token.startsWith('worktree ')) {
            flush();
            activePath = token.slice('worktree '.length);
            continue;
        }
        if (token.startsWith('branch ')) {
            activeBranch = token.slice('branch '.length);
            continue;
        }
        if (token.startsWith('prunable')) {
            activeIsPrunable = true;
        }
    }

    flush();

    return worktrees.sort((left, right) => left.path.localeCompare(right.path));
}
