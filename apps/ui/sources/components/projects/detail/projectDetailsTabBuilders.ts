import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function createProjectFileDetailsTab(fullPath: string, anchor?: FileTargetAnchor, anchorSource?: ReviewCommentSource): DetailsTab {
    const fileName = fullPath.split(/[\\/]/).pop() ?? fullPath;
    return {
        key: `file:${fullPath}`,
        kind: 'file',
        title: fileName,
        resource: { kind: 'file', path: fullPath, ...(anchor ? { anchor } : {}), ...(anchorSource ? { anchorSource } : {}) },
    };
}

export function createProjectCommitDetailsTab(sha: string): DetailsTab | null {
    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
    if (!safeSha) return null;
    return {
        key: `commit:${safeSha}`,
        kind: 'commit',
        title: safeSha.slice(0, 7),
        resource: { kind: 'commit', sha: safeSha },
    };
}
