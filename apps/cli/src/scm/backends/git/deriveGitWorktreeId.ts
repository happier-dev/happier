import { createHash } from 'node:crypto';

const GIT_WORKTREE_ID_PREFIX = 'gitwt_';
const GIT_WORKTREE_ID_BYTES = 9;

function normalizeGitWorktreePath(path: string): string {
    return String(path).trim().replace(/[\\/]+$/, '');
}

export function deriveGitWorktreeId(path: string): string {
    const normalizedPath = normalizeGitWorktreePath(path);
    const digest = createHash('sha256')
        .update(normalizedPath, 'utf8')
        .digest('base64url');
    return `${GIT_WORKTREE_ID_PREFIX}${digest.slice(0, GIT_WORKTREE_ID_BYTES)}`;
}
