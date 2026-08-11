import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListAttentionPromotionReason } from './attentionPromotion/sessionListAttentionPromotionTypes';
import type { SessionListWorkingPlacementReason } from './placement/sessionListPlacementProjection';
import { t } from '@/text';
import {
    resolveDisplayIdentityForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';
import { isUserFacingSession } from './isUserFacingSession';
import { deriveSessionListMeaningfulActivityAt } from './deriveSessionListActivity';
import { resolveSessionWorkspacePresentation, type WorkspacePathDisplayModeV1 } from './sessionWorkspacePresentation';
import {
    buildSessionFolderAssignmentKey,
    buildSessionFolderTree,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
    type SessionFolderTreeNode,
    type SessionFolderWorkspaceRefV1,
} from '../folders';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'sessions' | 'project' | 'pinned' | 'attention' | 'working' | 'shared' | 'folder';
        groupKey?: string;
        workspaceKey?: string;
        workspace?: SessionFolderWorkspaceRefV1;
        renderWorkspaceKey?: string;
        folderId?: string;
        parentFolderId?: string | null;
        depth?: number;
        sessionCount?: number;
        workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        seedSessionId?: string | null;
        serverId?: string;
        serverName?: string;
        subtitle?: string;
        machine?: MachineDisplayRenderable;
    }
    | {
        type: 'session';
        session: SessionListRenderableSession;
        section?: 'active' | 'inactive';
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'attention' | 'working' | 'shared' | 'folder';
        folderId?: string | null;
        folderDepth?: number;
        pinned?: boolean;
        attentionPromotionReason?: SessionListAttentionPromotionReason;
        workingPlacementReason?: SessionListWorkingPlacementReason;
        variant?: 'default' | 'no-path';
        serverId?: string;
        serverName?: string;
        workspace?: SessionFolderWorkspaceRefV1;
    };

export interface BuildSessionListViewDataOptions {
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    sectionModeV1?: 'activity' | 'single';
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    /**
     * Optional state snapshot used to resolve reachable machine targets when session metadata is stale
     * (e.g. after a handoff between machines).
     */
    sessionTargetState?: SessionMachineTargetState;
    serverScope?: {
        serverId: string;
        serverName?: string;
    };
    sessionFolders?: {
        enabled: boolean;
        folders: SessionFoldersV1;
        assignmentsBySessionKey: Readonly<Record<string, string | null | undefined>>;
    };
}

type ServerScopeMeta = Readonly<{
    serverId?: string;
    serverName?: string;
}>;

type SessionListActivitySection = 'active' | 'inactive';
type SessionListSectionScope = SessionListActivitySection | 'sessions';

function isSessionActive(session: { active: boolean }): boolean {
    return session.active;
}

function resolveSectionForSession(
    section: SessionListSectionScope,
    session: SessionListRenderableSession,
): SessionListActivitySection {
    if (section !== 'sessions') return section;
    return isSessionActive(session) ? 'active' : 'inactive';
}

function resolveGroupingForSection(
    section: 'active' | 'inactive',
    options: BuildSessionListViewDataOptions,
): 'project' | 'date' {
    if (section === 'active') {
        return options.activeGroupingV1 ?? 'project';
    }
    if (options.inactiveGroupingV1) return options.inactiveGroupingV1;
    return options.groupInactiveSessionsByProject ? 'project' : 'date';
}

function normalizeServerIdForKey(serverId?: string): string {
    const normalized = String(serverId ?? '').trim();
    return normalized || '__unknown_server__';
}

function formatYyyyMmDdLocal(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

type ProjectGroup = {
    key: string;
    workspaceHash: string;
    workspaceKey: string;
    displayPath: string;
    displayTitle: string;
    machine: MachineDisplayRenderable;
    workspaceMachineId: string | null;
    workspaceRootPath: string;
    latestCreatedAt: number;
    sessions: SessionListRenderableSession[];
};

function hasKnownWorkspaceMachine(
    group: ProjectGroup,
    machines: Record<string, MachineDisplayRenderable>,
): boolean {
    return Boolean(group.workspaceMachineId && machines[group.workspaceMachineId]);
}

function mergeMissingMachineProjectGroups(
    groups: Map<string, ProjectGroup>,
    machines: Record<string, MachineDisplayRenderable>,
): void {
    const groupsByPath = new Map<string, ProjectGroup[]>();
    for (const group of groups.values()) {
        if (!hasKnownWorkspaceMachine(group, machines)) continue;
        const bucket = groupsByPath.get(group.workspaceRootPath) ?? [];
        bucket.push(group);
        groupsByPath.set(group.workspaceRootPath, bucket);
    }

    for (const [key, group] of Array.from(groups.entries())) {
        if (hasKnownWorkspaceMachine(group, machines)) continue;
        const candidates = groupsByPath.get(group.workspaceRootPath) ?? [];
        if (candidates.length !== 1) continue;
        const target = candidates[0];
        target.sessions.push(...group.sessions);
        target.latestCreatedAt = Math.max(target.latestCreatedAt, group.latestCreatedAt);
        groups.delete(key);
    }
}

function compareSessionsStableNewestFirst(a: SessionListRenderableSession, b: SessionListRenderableSession): number {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
}

function resolveSessionDateGroupingAt(session: SessionListRenderableSession): number {
    return deriveSessionListMeaningfulActivityAt({
        sessionCreatedAt: session.createdAt,
        sessionMeaningfulActivityAt: session.meaningfulActivityAt ?? null,
        latestCommittedMessageCreatedAt: null,
        latestThinkingActivityAt: null,
        latestPendingMessageCreatedAt: null,
    }) ?? 0;
}

function compareSessionsStableNewestUpdatedFirst(a: SessionListRenderableSession, b: SessionListRenderableSession): number {
    const left = resolveSessionDateGroupingAt(a);
    const right = resolveSessionDateGroupingAt(b);
    if (right !== left) return right - left;
    return a.id.localeCompare(b.id);
}

function groupSessionsByProject(params: Readonly<{
    sessions: ReadonlyArray<SessionListRenderableSession>;
    machines: Record<string, MachineDisplayRenderable>;
    sessionTargetState?: SessionMachineTargetState;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();
    const sessionTargetState = params.sessionTargetState;

    for (const session of params.sessions) {
        // One resolution per session. Asking for the machine id and the path separately resolved
        // the same display target — and re-read the same project — twice per row on the
        // session-list build path, which the store runs for every list rebuild.
        const target = sessionTargetState
            ? resolveDisplayIdentityForSessionFromState({
                state: sessionTargetState,
                sessionId: session.id,
                metadata: session.metadata ?? null,
            })
            : null;
        const workspace = resolveSessionWorkspacePresentation({
            metadata: session.metadata ?? null,
            machines: params.machines,
            target,
            workspacePathDisplayModeV1: params.workspacePathDisplayModeV1,
        });
        const key = workspace.groupKey;

        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, {
                key,
                workspaceHash: workspace.workspaceHash,
                workspaceKey: workspace.workspaceKey,
                displayPath: workspace.displayPath,
                displayTitle: workspace.displayTitle,
                machine: workspace.machine,
                workspaceMachineId: workspace.machineId,
                workspaceRootPath: workspace.pathKey,
                latestCreatedAt: session.createdAt,
                sessions: [session],
            });
        } else {
            existing.sessions.push(session);
            existing.latestCreatedAt = Math.max(existing.latestCreatedAt, session.createdAt);
            if (!existing.workspaceMachineId && workspace.machineId) {
                existing.workspaceMachineId = workspace.machineId;
            }
        }
    }

    mergeMissingMachineProjectGroups(groups, params.machines);

    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
        if (b.latestCreatedAt !== a.latestCreatedAt) return b.latestCreatedAt - a.latestCreatedAt;
        if (a.displayPath !== b.displayPath) return a.displayPath.localeCompare(b.displayPath);
        return a.key.localeCompare(b.key);
    });

    for (const group of sortedGroups) {
        group.sessions.sort(compareSessionsStableNewestFirst);
    }

    return sortedGroups;
}

function pushProjectGroupsToList(params: Readonly<{
    listData: SessionListViewItem[];
    groups: ReadonlyArray<ProjectGroup>;
    section: SessionListSectionScope;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
    sessionFolders?: BuildSessionListViewDataOptions['sessionFolders'];
}>): void {
    for (const group of params.groups) {
        const hasGroupHeader = Boolean(group.displayPath);
        const groupKey = `server:${params.serverKey}:project:${group.workspaceHash}`;
        const projectHeader: Extract<SessionListViewItem, { type: 'header' }> = {
            type: 'header',
            title: group.displayTitle,
            headerKind: 'project',
            groupKey,
            workspaceKey: group.workspaceKey,
            workspaceScopeHint: params.serverScopeMeta.serverId && group.workspaceMachineId && group.workspaceRootPath
                ? {
                    serverId: params.serverScopeMeta.serverId,
                    machineId: group.workspaceMachineId,
                    rootPath: group.workspaceRootPath,
                }
                : null,
            seedSessionId: group.sessions[0]?.id ?? null,
            machine: group.machine,
            subtitle: group.machine.metadata?.displayName || group.machine.metadata?.host || group.machine.id,
            ...params.serverScopeMeta,
        };

        if (hasGroupHeader) {
            params.listData.push(projectHeader);
        }

        const variant: 'default' | 'no-path' = hasGroupHeader ? 'no-path' : 'default';
        const folderOptions = params.sessionFolders?.enabled === true && hasGroupHeader ? params.sessionFolders : null;
        if (folderOptions) {
            const workspace = resolveDurableWorkspaceRefForSessionListHeader(projectHeader);
            if (workspace) {
                pushFolderAwareProjectSessionsToList({
                    listData: params.listData,
                    sessions: group.sessions,
                    section: params.section,
                    projectGroupKey: groupKey,
                    variant,
                    serverScopeMeta: params.serverScopeMeta,
                    renderWorkspaceKey: group.workspaceKey,
                    workspace,
                    sessionFolders: folderOptions,
                });
                continue;
            }
        }

        group.sessions.forEach((session) => {
            params.listData.push({
                type: 'session',
                session,
                section: resolveSectionForSession(params.section, session),
                groupKey,
                groupKind: 'project',
                variant,
                ...params.serverScopeMeta,
            });
        });
    }
}

function buildFolderGroupKey(params: Readonly<{
    projectGroupKey: string;
    folderId: string;
}>): string {
    return `${params.projectGroupKey}:folder:${params.folderId}`;
}

function pushFolderAwareProjectSessionsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
    projectGroupKey: string;
    variant: 'default' | 'no-path';
    serverScopeMeta: ServerScopeMeta;
    renderWorkspaceKey: string;
    workspace: SessionFolderWorkspaceRefV1;
    sessionFolders: NonNullable<BuildSessionListViewDataOptions['sessionFolders']>;
    sectionBySessionId?: ReadonlyMap<string, SessionListActivitySection>;
}>): void {
    const tree = buildSessionFolderTree(params.sessionFolders.folders, params.workspace);
    if (tree.rootNodes.length === 0) {
        params.sessions.forEach((session) => {
            params.listData.push({
                type: 'session',
                session,
                section: params.sectionBySessionId?.get(session.id) ?? resolveSectionForSession(params.section, session),
                groupKey: params.projectGroupKey,
                groupKind: 'project',
                variant: params.variant,
                folderId: null,
                folderDepth: 0,
                ...params.serverScopeMeta,
            });
        });
        return;
    }

    const sessionsByFolderId = new Map<string, SessionListRenderableSession[]>();
    const rootSessions: SessionListRenderableSession[] = [];
    for (const session of params.sessions) {
        const assignmentKey = buildSessionFolderAssignmentKey(params.serverScopeMeta.serverId, session.id);
        const folderId = params.sessionFolders.assignmentsBySessionKey[assignmentKey] ?? null;
        if (folderId && tree.nodesById.has(folderId)) {
            const bucket = sessionsByFolderId.get(folderId) ?? [];
            bucket.push(session);
            sessionsByFolderId.set(folderId, bucket);
        } else {
            rootSessions.push(session);
        }
    }

    const pushNode = (node: SessionFolderTreeNode): void => {
        const headerDepth = node.depth;
        const sessionDepth = node.depth + 1;
        const folderGroupKey = buildFolderGroupKey({
            projectGroupKey: params.projectGroupKey,
            folderId: node.id,
        });
        const folderSessions = sessionsByFolderId.get(node.id) ?? [];
        params.listData.push({
            type: 'header',
            title: node.name,
            headerKind: 'folder',
            groupKey: folderGroupKey,
            workspace: node.workspace,
            renderWorkspaceKey: params.renderWorkspaceKey,
            folderId: node.id,
            parentFolderId: node.parentId,
            depth: headerDepth,
            sessionCount: folderSessions.length,
            ...params.serverScopeMeta,
        });
        node.children.forEach(pushNode);
        folderSessions.forEach((session) => {
            params.listData.push({
                type: 'session',
                session,
                section: params.sectionBySessionId?.get(session.id) ?? resolveSectionForSession(params.section, session),
                groupKey: folderGroupKey,
                groupKind: 'folder',
                variant: params.variant,
                folderId: node.id,
                folderDepth: sessionDepth,
                ...params.serverScopeMeta,
            });
        });
    };

    tree.rootNodes.forEach(pushNode);
    rootSessions.forEach((session) => {
        params.listData.push({
            type: 'session',
            session,
            section: params.sectionBySessionId?.get(session.id) ?? resolveSectionForSession(params.section, session),
            groupKey: params.projectGroupKey,
            groupKind: 'project',
            variant: params.variant,
            folderId: null,
            folderDepth: 0,
            ...params.serverScopeMeta,
        });
    });
}

function resolveSectionScopeForCollectedProjectSessions(
    sessions: ReadonlyArray<Extract<SessionListViewItem, { type: 'session' }>>,
): SessionListSectionScope {
    let hasActive = false;
    let hasInactive = false;

    for (const session of sessions) {
        const section = session.section === 'active' || session.section === 'inactive'
            ? session.section
            : resolveSectionForSession('sessions', session.session);
        if (section === 'active') {
            hasActive = true;
        } else {
            hasInactive = true;
        }
        if (hasActive && hasInactive) return 'sessions';
    }

    if (hasActive) return 'active';
    if (hasInactive) return 'inactive';
    return 'inactive';
}

export function applySessionFoldersToSessionListViewData(
    source: ReadonlyArray<SessionListViewItem>,
    options: NonNullable<BuildSessionListViewDataOptions['sessionFolders']>,
): SessionListViewItem[] {
    if (options.enabled !== true || source.length === 0) return source as SessionListViewItem[];
    if (source.some((item) => item.type === 'header' && item.headerKind === 'folder')) {
        return source as SessionListViewItem[];
    }

    let changed = false;
    const out: SessionListViewItem[] = [];
    for (let index = 0; index < source.length; index += 1) {
        const item = source[index];
        if (item.type !== 'header' || item.headerKind !== 'project') {
            out.push(item);
            continue;
        }

        const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
        if (!workspace || !item.groupKey) {
            out.push(item);
            continue;
        }

        const sessions: Array<Extract<SessionListViewItem, { type: 'session' }>> = [];
        let cursor = index + 1;
        while (cursor < source.length) {
            const next = source[cursor];
            if (next.type !== 'session' || next.groupKey !== item.groupKey) break;
            sessions.push(next);
            cursor += 1;
        }

        out.push(item);
        const beforeLength = out.length;
        const sectionBySessionId = new Map<string, SessionListActivitySection>();
        for (const session of sessions) {
            if (session.section === 'active' || session.section === 'inactive') {
                sectionBySessionId.set(session.session.id, session.section);
            }
        }
        pushFolderAwareProjectSessionsToList({
            listData: out,
            sessions: sessions.map((session) => session.session),
            section: resolveSectionScopeForCollectedProjectSessions(sessions),
            projectGroupKey: item.groupKey,
            variant: sessions[0]?.variant ?? 'default',
            serverScopeMeta: {
                serverId: item.serverId,
                serverName: item.serverName,
            },
            renderWorkspaceKey: item.workspaceKey ?? item.renderWorkspaceKey ?? '',
            workspace,
            sessionFolders: options,
            sectionBySessionId,
        });
        changed = changed || out.length !== beforeLength + sessions.length;
        index = cursor - 1;
    }

    return changed ? out : source as SessionListViewItem[];
}

function pushDateGroupsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
}>): void {
    if (params.sessions.length === 0) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: SessionListRenderableSession[] = [];
    let currentDateString: string | null = null;
    const sessions = params.sessions.slice().sort(compareSessionsStableNewestUpdatedFirst);

    const flush = () => {
        if (currentDateGroup.length === 0 || !currentDateString) return;

        const groupDate = new Date(currentDateString);
        const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

        let headerTitle: string;
        if (sessionDateOnly.getTime() === today.getTime()) {
            headerTitle = t('sessionHistory.today');
        } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
            headerTitle = t('sessionHistory.yesterday');
        } else {
            const diffTime = today.getTime() - sessionDateOnly.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            headerTitle = t('sessionHistory.daysAgo', { count: diffDays });
        }

        const groupKey = `server:${params.serverKey}:${params.section}:day:${formatYyyyMmDdLocal(sessionDateOnly)}`;
        params.listData.push({ type: 'header', title: headerTitle, headerKind: 'date', groupKey, ...params.serverScopeMeta });
        currentDateGroup.forEach((sess) => {
            params.listData.push({
                type: 'session',
                session: sess,
                section: resolveSectionForSession(params.section, sess),
                groupKey,
                groupKind: 'date',
                ...params.serverScopeMeta,
            });
        });
    };

    for (const session of sessions) {
        const sessionDate = new Date(resolveSessionDateGroupingAt(session));
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            flush();
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }

    flush();
}

function pushSharedSessionsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
}>): void {
    if (params.sessions.length === 0) return;

    const groupKey = `server:${params.serverKey}:${params.section}:shared`;
    params.listData.push({
        type: 'header',
        title: t('friends.sharedSessions'),
        headerKind: 'shared',
        groupKey,
        ...params.serverScopeMeta,
    });

    params.sessions.forEach((session) => {
        params.listData.push({
            type: 'session',
            session,
            section: resolveSectionForSession(params.section, session),
            groupKey,
            groupKind: 'shared',
            ...params.serverScopeMeta,
        });
    });
}

function pushOwnedSessionsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
    grouping: 'project' | 'date';
    machines: Record<string, MachineDisplayRenderable>;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
    sessionTargetState?: SessionMachineTargetState;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    sessionFolders?: BuildSessionListViewDataOptions['sessionFolders'];
}>): void {
    if (params.sessions.length === 0) return;

    if (params.grouping === 'project') {
        pushProjectGroupsToList({
            listData: params.listData,
            groups: groupSessionsByProject({
                sessions: params.sessions,
                machines: params.machines,
                sessionTargetState: params.sessionTargetState,
                workspacePathDisplayModeV1: params.workspacePathDisplayModeV1,
            }),
            section: params.section,
            serverKey: params.serverKey,
            serverScopeMeta: params.serverScopeMeta,
            sessionFolders: params.sessionFolders,
        });
        return;
    }

    pushDateGroupsToList({
        listData: params.listData,
        sessions: params.sessions,
        section: params.section,
        serverKey: params.serverKey,
        serverScopeMeta: params.serverScopeMeta,
    });
}

export function buildSessionListViewData(
    sessions: Record<string, SessionListRenderableSession>,
    machines: Record<string, MachineDisplayRenderable>,
    options: BuildSessionListViewDataOptions
): SessionListViewItem[] {
    const serverScopeMeta = options.serverScope
        ? {
            serverId: options.serverScope.serverId,
            serverName: options.serverScope.serverName,
        }
        : {};
    const activeSessions: SessionListRenderableSession[] = [];
    const inactiveSessions: SessionListRenderableSession[] = [];
    const activeSharedSessions: SessionListRenderableSession[] = [];
    const inactiveSharedSessions: SessionListRenderableSession[] = [];

    Object.values(sessions).forEach((session) => {
        // Hide system sessions from user-facing lists by default.
        if (!isUserFacingSession(session)) {
            return;
        }
        const isSharedSession = typeof session.owner === 'string' && session.owner.trim().length > 0;
        if (isSharedSession && isSessionActive(session)) {
            activeSharedSessions.push(session);
        } else if (isSharedSession) {
            inactiveSharedSessions.push(session);
        } else if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    activeSessions.sort(compareSessionsStableNewestFirst);
    inactiveSessions.sort(compareSessionsStableNewestFirst);
    activeSharedSessions.sort(compareSessionsStableNewestFirst);
    inactiveSharedSessions.sort(compareSessionsStableNewestFirst);

    const listData: SessionListViewItem[] = [];
    const serverKey = normalizeServerIdForKey(options.serverScope?.serverId);
    const sectionMode = options.sectionModeV1 === 'single' ? 'single' : 'activity';

    if (sectionMode === 'single') {
        const allOwnedSessions = [...activeSessions, ...inactiveSessions].sort(compareSessionsStableNewestFirst);
        const allSharedSessions = [...activeSharedSessions, ...inactiveSharedSessions].sort(compareSessionsStableNewestFirst);
        if (allOwnedSessions.length > 0 || allSharedSessions.length > 0) {
            const grouping = resolveGroupingForSection('active', options);
            listData.push({
                type: 'header',
                title: t('tabs.sessions'),
                headerKind: 'sessions',
                groupKey: `sessions:${serverKey}`,
                ...serverScopeMeta,
            });
            pushSharedSessionsToList({
                listData,
                sessions: allSharedSessions,
                section: 'sessions',
                serverKey,
                serverScopeMeta,
            });
            pushOwnedSessionsToList({
                listData,
                sessions: allOwnedSessions,
                section: 'sessions',
                grouping,
                machines,
                serverKey,
                serverScopeMeta,
                sessionTargetState: options.sessionTargetState,
                workspacePathDisplayModeV1: options.workspacePathDisplayModeV1,
                sessionFolders: options.sessionFolders,
            });
        }
        return listData;
    }

    if (activeSessions.length > 0 || activeSharedSessions.length > 0) {
        const grouping = resolveGroupingForSection('active', options);
        listData.push({ type: 'header', title: 'Active', headerKind: 'active', ...serverScopeMeta });
        pushSharedSessionsToList({
            listData,
            sessions: activeSharedSessions,
            section: 'active',
            serverKey,
            serverScopeMeta,
        });
        pushOwnedSessionsToList({
            listData,
            sessions: activeSessions,
            section: 'active',
            grouping,
            machines,
            serverKey,
            serverScopeMeta,
            sessionTargetState: options.sessionTargetState,
            workspacePathDisplayModeV1: options.workspacePathDisplayModeV1,
            sessionFolders: options.sessionFolders,
        });
    }

    if (inactiveSessions.length > 0 || inactiveSharedSessions.length > 0) {
        const grouping = resolveGroupingForSection('inactive', options);
        listData.push({ type: 'header', title: 'Inactive', headerKind: 'inactive', ...serverScopeMeta });
        pushSharedSessionsToList({
            listData,
            sessions: inactiveSharedSessions,
            section: 'inactive',
            serverKey,
            serverScopeMeta,
        });
        pushOwnedSessionsToList({
            listData,
            sessions: inactiveSessions,
            section: 'inactive',
            grouping,
            machines,
            serverKey,
            serverScopeMeta,
            sessionTargetState: options.sessionTargetState,
            workspacePathDisplayModeV1: options.workspacePathDisplayModeV1,
            sessionFolders: options.sessionFolders,
        });
    }

    return listData;
}
