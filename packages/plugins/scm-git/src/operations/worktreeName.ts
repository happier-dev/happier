import { join } from 'node:path';

function normalizeWorktreeNameSegment(segment: string): string {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return '';

    return trimmed
        .replace(/\s+/g, '-')
        .replace(/@\{/g, '-')
        .replace(/[~^:?*[\]\\]/g, '-')
        .replace(/\.{2,}/g, '-')
        .replace(/(^[./-]+)|([./-]+$)/g, '')
        .replace(/-+/g, '-');
}

function hasForbiddenGitRefSegment(segment: string): boolean {
    const normalizedSegment = normalizeWorktreeNameSegment(segment);
    return normalizedSegment === '@' || normalizedSegment.endsWith('.lock');
}

export function normalizeWorktreeDisplayName(value: string): string {
    const normalizedSegments = value
        .trim()
        .replaceAll('\\', '/')
        .split('/')
        .map(normalizeWorktreeNameSegment)
        .filter((segment) => segment.length > 0);

    return normalizedSegments.join('/');
}

export function hasForbiddenGitRefName(value: string): boolean {
    return value
        .trim()
        .replaceAll('\\', '/')
        .split('/')
        .some(hasForbiddenGitRefSegment);
}

export const WORKTREE_RELATIVE_PARENT_DIR = '.dev/worktree';

export function buildWorktreeRelativePath(branchName: string): string {
    const trimmed = branchName.trim();
    return trimmed ? `${WORKTREE_RELATIVE_PARENT_DIR}/${trimmed}` : WORKTREE_RELATIVE_PARENT_DIR;
}

export function buildWorktreeTargetPath(repoRoot: string, branchName: string): string {
    return join(repoRoot, ...buildWorktreeRelativePath(branchName).split('/'));
}
