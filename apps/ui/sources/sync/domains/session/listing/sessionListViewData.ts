import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { t } from '@/text';
import {
    resolveDisplayMachineIdForSessionFromState,
    resolveDisplayPathForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';
import { isUserFacingSession } from './isUserFacingSession';
import { resolveSessionWorkspacePresentation } from './sessionWorkspacePresentation';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'project' | 'pinned' | 'shared';
        groupKey?: string;
        workspaceKey?: string;
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
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'shared';
        pinned?: boolean;
        variant?: 'default' | 'no-path';
        serverId?: string;
        serverName?: string;
    };

export interface BuildSessionListViewDataOptions {
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    /**
     * Optional state snapshot used to resolve reachable machine targets when session metadata is stale
     * (e.g. after a handoff between machines).
     */
    sessionTargetState?: SessionMachineTargetState;
    serverScope?: {
        serverId: string;
        serverName?: string;
    };
}

type ServerScopeMeta = Readonly<{
    serverId?: string;
    serverName?: string;
}>;

function isSessionActive(session: { active: boolean }): boolean {
    return session.active;
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
    machine: MachineDisplayRenderable;
    workspaceMachineId: string | null;
    workspaceRootPath: string;
    latestCreatedAt: number;
    sessions: SessionListRenderableSession[];
};

function compareSessionsStableNewestFirst(a: SessionListRenderableSession, b: SessionListRenderableSession): number {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
}

function groupSessionsByProject(params: Readonly<{
    sessions: ReadonlyArray<SessionListRenderableSession>;
    machines: Record<string, MachineDisplayRenderable>;
    sessionTargetState?: SessionMachineTargetState;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();
    const sessionTargetState = params.sessionTargetState;

    for (const session of params.sessions) {
        const target = sessionTargetState
            ? {
                machineId: resolveDisplayMachineIdForSessionFromState({
                    state: sessionTargetState,
                    sessionId: session.id,
                    metadata: session.metadata ?? null,
                }),
                basePath: resolveDisplayPathForSessionFromState({
                    state: sessionTargetState,
                    sessionId: session.id,
                    metadata: session.metadata ?? null,
                }),
            }
            : null;
        const workspace = resolveSessionWorkspacePresentation({
            metadata: session.metadata ?? null,
            machines: params.machines,
            target,
        });
        const key = workspace.groupKey;

        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, {
                key,
                workspaceHash: workspace.workspaceHash,
                workspaceKey: workspace.workspaceKey,
                displayPath: workspace.displayPath,
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
    section: 'active' | 'inactive';
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
}>): void {
    for (const group of params.groups) {
        const hasGroupHeader = Boolean(group.displayPath);
        const groupKey = `server:${params.serverKey}:${params.section}:project:${group.workspaceHash}`;

        if (hasGroupHeader) {
            params.listData.push({
                type: 'header',
                title: group.displayPath,
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
            });
        }

        const variant: 'default' | 'no-path' = hasGroupHeader ? 'no-path' : 'default';
        group.sessions.forEach((session) => {
            params.listData.push({
                type: 'session',
                session,
                section: params.section,
                groupKey,
                groupKind: 'project',
                variant,
                ...params.serverScopeMeta,
            });
        });
    }
}

function pushDateGroupsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: 'active' | 'inactive';
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
}>): void {
    if (params.sessions.length === 0) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: SessionListRenderableSession[] = [];
    let currentDateString: string | null = null;

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
                section: params.section,
                groupKey,
                groupKind: 'date',
                ...params.serverScopeMeta,
            });
        });
    };

    for (const session of params.sessions) {
        const sessionDate = new Date(session.createdAt);
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
    section: 'active' | 'inactive';
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
            section: params.section,
            groupKey,
            groupKind: 'shared',
            ...params.serverScopeMeta,
        });
    });
}

function pushOwnedSessionsToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: 'active' | 'inactive';
    grouping: 'project' | 'date';
    machines: Record<string, MachineDisplayRenderable>;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
    sessionTargetState?: SessionMachineTargetState;
}>): void {
    if (params.sessions.length === 0) return;

    if (params.grouping === 'project') {
        pushProjectGroupsToList({
            listData: params.listData,
            groups: groupSessionsByProject({
                sessions: params.sessions,
                machines: params.machines,
                sessionTargetState: params.sessionTargetState,
            }),
            section: params.section,
            serverKey: params.serverKey,
            serverScopeMeta: params.serverScopeMeta,
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
        });
    }

    return listData;
}
