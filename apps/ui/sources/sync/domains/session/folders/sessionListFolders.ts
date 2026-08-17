import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { buildSessionFolderAssignmentKey } from './assignmentKeys';
import { buildSessionFolderCollapseKey } from './collapseKeys';
import { resolveSessionFolderFocusScope, type SessionFolderFocusScope } from './focus';
import { buildSessionFolderTree, type SessionFolderTreeNode } from './tree';
import { selectAvailableSessionFolders } from './types';
import type {
    SessionFolderList,
    SessionFoldersV1,
    SessionFolderWorkspaceRefV1,
} from './types';
import {
    buildSessionFolderWorkspaceRefKey,
    compareSessionFolderWorkspaceRefs,
    resolveDurableWorkspaceRefForSessionListHeader,
} from './workspaceRefs';

export type FolderAwareSessionListIndexResult = Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    folderFocus: SessionFolderFocusScope | null;
}>;

type ProjectGroup = Readonly<{
    header: Extract<SessionListIndexItem, { type: 'header' }>;
    sessions: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>;
    workspace: SessionFolderWorkspaceRefV1 | null;
}>;

function cloneSessionWithFolder(
    session: Extract<SessionListIndexItem, { type: 'session' }>,
    folderId: string | null,
    folderDepth: number,
    groupKey: string,
    workspace: SessionFolderWorkspaceRefV1,
): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        ...session,
        groupKey,
        groupKind: 'folder',
        folderId,
        folderDepth,
        workspace,
        variant: 'no-path',
    };
}

export function buildSessionFolderGroupKey(params: Readonly<{
    serverId: string | null | undefined;
    workspace: SessionFolderWorkspaceRefV1;
    folderId: string | null;
}>): string {
    return `folder:${String(params.serverId ?? params.workspace.serverId ?? 'local').trim() || 'local'}:${buildSessionFolderWorkspaceRefKey(params.workspace)}:${params.folderId ?? 'root'}`;
}

function collectFolderIds(nodes: readonly SessionFolderTreeNode[], out: Set<string>): void {
    for (const node of nodes) {
        out.add(node.id);
        collectFolderIds(node.children, out);
    }
}

function pushFolderNode(params: Readonly<{
    out: SessionListIndexItem[];
    node: SessionFolderTreeNode;
    workspace: SessionFolderWorkspaceRefV1;
    serverId: string | null | undefined;
    workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
    seedSessionId?: string | null;
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    sessionsByFolderId: ReadonlyMap<string, ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>>;
}>): void {
    const groupKey = buildSessionFolderGroupKey({ serverId: params.serverId, workspace: params.workspace, folderId: params.node.id });
    params.out.push({
        type: 'header',
        title: params.node.name,
        headerKind: 'folder',
        groupKey,
        serverId: params.serverId ?? undefined,
        workspaceScopeHint: params.workspaceScopeHint ?? null,
        seedSessionId: params.seedSessionId ?? null,
        folderId: params.node.id,
        folderDepth: params.node.depth,
        workspace: params.workspace,
        displayState: params.node.displayState,
    });

    const collapseKey = buildSessionFolderCollapseKey({
        serverId: params.serverId ?? null,
        workspace: params.workspace,
        folderId: params.node.id,
    });
    if (params.collapsedGroupKeys[collapseKey] === true) {
        return;
    }

    for (const child of params.node.children) {
        pushFolderNode({ ...params, node: child });
    }

    const folderSessions = params.sessionsByFolderId.get(params.node.id) ?? [];
    for (const session of folderSessions) {
        params.out.push(cloneSessionWithFolder(session, params.node.id, params.node.depth + 1, groupKey, params.workspace));
    }
}

function splitProjectGroups(source: ReadonlyArray<SessionListIndexItem>): ProjectGroup[] {
    const groups: ProjectGroup[] = [];
    let current: {
        header: Extract<SessionListIndexItem, { type: 'header' }>;
        sessions: Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        workspace: SessionFolderWorkspaceRefV1 | null;
    } | null = null;

    const flush = () => {
        if (current) {
            groups.push({
                header: current.header,
                sessions: current.sessions,
                workspace: current.workspace,
            });
        }
        current = null;
    };

    for (const item of source) {
        if (item.type === 'header' && item.headerKind === 'project') {
            flush();
            current = {
                header: item,
                sessions: [],
                workspace: resolveDurableWorkspaceRefForSessionListHeader(item),
            };
            continue;
        }
        if (item.type === 'header') {
            flush();
            groups.push({ header: item, sessions: [], workspace: null });
            continue;
        }
        if (current && item.type === 'session') {
            current.sessions.push(item);
        }
    }
    flush();
    return groups;
}

export function applySessionFolderTreeToSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    folders: SessionFolderList;
    assignmentsBySessionKey: Readonly<Record<string, string | null | undefined>>;
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    focusedFolder: Readonly<{
        folderId: string;
        workspace: SessionFolderWorkspaceRefV1;
        serverId?: string | null;
    }> | null;
}>): FolderAwareSessionListIndexResult {
    const availableFolders: SessionFoldersV1 =
        selectAvailableSessionFolders(params.folders);
    const focus = resolveSessionFolderFocusScope(
        availableFolders,
        params.focusedFolder,
    );
    const out: SessionListIndexItem[] = [];
    const groups = splitProjectGroups(params.source);
    const renderedFolderIds = new Set<string>();

    for (const group of groups) {
        if (!group.workspace || group.header.headerKind !== 'project') {
            out.push(group.header);
            for (const session of group.sessions) out.push(session);
            continue;
        }

        const scopedFocus = focus && compareSessionFolderWorkspaceRefs(focus.folder.workspace, group.workspace)
            ? focus
            : null;
        const assignedFolderIds = new Set<string>();
        for (const session of group.sessions) {
            const folderId = params.assignmentsBySessionKey[
                buildSessionFolderAssignmentKey(
                    session.serverId ?? group.header.serverId ?? null,
                    session.sessionId,
                )
            ];
            if (folderId) assignedFolderIds.add(folderId);
        }
        const folderById = new Map(
            params.folders.folders.map((folder) => [folder.id, folder] as const),
        );
        for (const folderId of [...assignedFolderIds]) {
            let parentId = folderById.get(folderId)?.parentId ?? null;
            const seen = new Set<string>([folderId]);
            while (parentId && !seen.has(parentId)) {
                assignedFolderIds.add(parentId);
                seen.add(parentId);
                parentId = folderById.get(parentId)?.parentId ?? null;
            }
        }
        const tree = buildSessionFolderTree(params.folders, group.workspace, {
            includeLockedFolderIds: assignedFolderIds,
        });
        const knownFolderIds = new Set<string>();
        collectFolderIds(tree.rootNodes, knownFolderIds);
        for (const folderId of knownFolderIds) {
            renderedFolderIds.add(folderId);
        }

        const sessionsByFolderId = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();
        const rootSessions: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
        for (const session of group.sessions) {
            const assignedFolderId = params.assignmentsBySessionKey[
                buildSessionFolderAssignmentKey(session.serverId ?? group.header.serverId ?? null, session.sessionId)
            ] ?? null;
            if (assignedFolderId && knownFolderIds.has(assignedFolderId)) {
                if (!sessionsByFolderId.has(assignedFolderId)) sessionsByFolderId.set(assignedFolderId, []);
                sessionsByFolderId.get(assignedFolderId)!.push(session);
            } else {
                rootSessions.push(session);
            }
        }

        out.push(group.header);

        if (scopedFocus) {
            for (const session of group.sessions) {
                const assignedFolderId = params.assignmentsBySessionKey[
                    buildSessionFolderAssignmentKey(session.serverId ?? group.header.serverId ?? null, session.sessionId)
                ] ?? null;
                if (assignedFolderId && scopedFocus.folderIds.has(assignedFolderId)) {
                    out.push(cloneSessionWithFolder(
                        session,
                        assignedFolderId,
                        1,
                        buildSessionFolderGroupKey({ serverId: group.header.serverId, workspace: group.workspace, folderId: assignedFolderId }),
                        group.workspace,
                    ));
                }
            }
            continue;
        }

        const rootGroupKey = buildSessionFolderGroupKey({ serverId: group.header.serverId, workspace: group.workspace, folderId: null });
        for (const node of tree.rootNodes) {
            pushFolderNode({
                out,
                node,
                workspace: group.workspace,
                serverId: group.header.serverId,
                workspaceScopeHint: group.header.workspaceScopeHint,
                seedSessionId: group.header.seedSessionId,
                collapsedGroupKeys: params.collapsedGroupKeys,
                sessionsByFolderId,
            });
        }
        for (const session of rootSessions) {
            out.push(cloneSessionWithFolder(session, null, 0, rootGroupKey, group.workspace));
        }
    }

    const remainingLockedFolders = params.folders.folders
        .filter((folder) =>
            folder.displayState?.status === 'locked'
            && !renderedFolderIds.has(folder.id))
        .slice()
        .sort((left, right) => {
            const leftSort = left.sortKey ?? '';
            const rightSort = right.sortKey ?? '';
            return leftSort.localeCompare(rightSort)
                || left.id.localeCompare(right.id);
        });
    const remainingIds = new Set(
        remainingLockedFolders.map((folder) => folder.id),
    );
    const childrenByParentId = new Map<
        string | null,
        typeof remainingLockedFolders
    >();
    for (const folder of remainingLockedFolders) {
        const parentId = folder.parentId && remainingIds.has(folder.parentId)
            ? folder.parentId
            : null;
        const siblings = childrenByParentId.get(parentId) ?? [];
        siblings.push(folder);
        childrenByParentId.set(parentId, siblings);
    }
    const visited = new Set<string>();
    const fallbackServerId = groups
        .map((group) => group.header.serverId)
        .find((serverId): serverId is string => Boolean(serverId));
    const appendLockedFolder = (
        folder: (typeof remainingLockedFolders)[number],
        depth: number,
    ) => {
        if (visited.has(folder.id)) return;
        visited.add(folder.id);
        out.push({
            type: 'header',
            title: '',
            headerKind: 'folder',
            groupKey: `locked-folder:${fallbackServerId ?? 'local'}:${folder.id}`,
            serverId: fallbackServerId,
            folderId: folder.id,
            folderDepth: depth,
            displayState: folder.displayState,
        });
        for (const child of childrenByParentId.get(folder.id) ?? []) {
            appendLockedFolder(child, depth + 1);
        }
    };
    for (const root of childrenByParentId.get(null) ?? []) {
        appendLockedFolder(root, 0);
    }
    for (const folder of remainingLockedFolders) {
        appendLockedFolder(folder, 0);
    }

    return { items: out, folderFocus: focus };
}
