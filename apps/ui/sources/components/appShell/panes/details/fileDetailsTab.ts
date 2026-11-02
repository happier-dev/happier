import type { FileTargetAnchor, WorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { DetailsTab } from './workspace/detailsWorkspaceTypes';

/** An explicit base is meaningful only when it differs from the destination's ordinary base. */
export function resolveFileDetailsRootPath(rootPath: string | undefined, scopeId?: string): string | undefined {
    if (!rootPath) return undefined;
    const root = normalizeWorkspaceRootPathV1(rootPath);
    if (!root) return undefined;
    const state = scopeId ? readRegisteredStorageState() : null;
    if (!state || !scopeId) return root;
    const session = parseSessionPaneScopeId(scopeId);
    const project = parseProjectPaneScopeId(scopeId);
    const ref = project ? resolveWorkspaceRefById(readProjectAccountWorkspaceRefs(state) ?? [], project.workspaceRefId, project.serverId) : null;
    const scopeRoot = session ? resolveWorkspaceTargetForSessionFromState(state, session.address ?? session.sessionId)?.rootPath
        : ref?.kind === 'resolved' ? ref.ref.rootPath : null;
    return root === normalizeWorkspaceRootPathV1(scopeRoot) ? undefined : root;
}

/** All direct, routed and Action file placements enter the same pane admission. */
export function normalizeFileDetailsTab<T extends DetailsTab>(tab: T, scopeId: string): T {
    if (tab.kind !== 'file' || !tab.resource || typeof tab.resource !== 'object') return tab;
    const resource = tab.resource;
    if (!('path' in resource) || typeof resource.path !== 'string') return tab;
    const rootPath = resolveFileDetailsRootPath('rootPath' in resource && typeof resource.rootPath === 'string' ? resource.rootPath : undefined, scopeId);
    const key = workspaceFileDetailsTabKey(resource.path, rootPath);
    if (tab.key === key && (!('rootPath' in resource) || resource.rootPath === rootPath)) return tab;
    const { rootPath: _root, ...rest } = resource as Readonly<Record<string, unknown>>;
    return { ...tab, key, resource: { ...rest, ...(rootPath ? { rootPath } : {}) } };
}

/** File identity and resource shape are shared by Session and Project panes. */
export function workspaceFileDetailsTabKey(path: string, rootPath?: string, scopeId?: string): string {
    const root = resolveFileDetailsRootPath(rootPath, scopeId);
    return root ? `file-root:${JSON.stringify([root, path])}` : `file:${path}`;
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
