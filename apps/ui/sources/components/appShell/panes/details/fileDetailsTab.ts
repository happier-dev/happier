import type { FileTargetAnchor, WorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

/** File identity and resource shape are shared by Session and Project panes. */
export function workspaceFileDetailsTabKey(path: string, rootPath?: string): string {
    return rootPath ? `file-root:${JSON.stringify([normalizeWorkspaceRootPathV1(rootPath), path])}` : `file:${path}`;
}

export function createWorkspaceFileDetailsTab(fullPath: string, anchor?: FileTargetAnchor, anchorSource?: ReviewCommentSource, view?: WorkspaceFileLinkView) {
    const fileName = fullPath.split(/[\\/]/).pop() ?? fullPath;
    return {
        key: workspaceFileDetailsTabKey(fullPath, view?.rootPath),
        kind: 'file' as const,
        title: fileName,
        resource: { kind: 'file' as const, path: fullPath, ...(anchor ? { anchor } : {}), ...(anchorSource ? { anchorSource } : {}),
            ...(view?.rootPath ? { rootPath: view.rootPath } : {}),
            ...(view?.view ? { fileView: view.view } : {}),
            ...(view?.blame === undefined ? {} : { blame: view.blame }),
            ...(view?.openAs ? { fileOpenAs: view.openAs } : {}),
        },
    };
}
