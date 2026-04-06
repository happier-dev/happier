import { isHiddenSystemSession } from '@happier-dev/protocol';
import { resolveBestMachineDisplayRenderableForHost, type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { resolveSessionProjectGroupingKeyPartsWithMachineMetadata } from './sessionListProjectGroupingKeys';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import { normalizeSessionListServerScope } from './normalizeSessionListServerScope';
import {
    sortSessionListRenderableSessionsNewestFirstIfNeeded,
} from './sessionListRenderableSorting';
import { t } from '@/text';
import {
    resolveDisplayMachineIdForSessionFromState,
    resolveDisplayPathForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'project' | 'pinned' | 'shared';
        groupKey?: string;
        workspaceKey?: string;
        workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
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

const EMPTY_SESSION_LIST_VIEW_DATA: SessionListViewItem[] = [];

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

function makeUnknownMachine(id: string): MachineDisplayRenderable {
    return {
        id,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
    };
}

function formatYyyyMmDdLocal(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function hashFNV1a32Hex(input: string): string {
    // FNV-1a 32-bit. Used to avoid persisting raw local paths in synced keys.
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

type ProjectGroup = {
    key: string;
    displayPath: string;
    machine: MachineDisplayRenderable;
    workspaceMachineId: string | null;
    workspaceRootPath: string | null;
    latestCreatedAt: number;
    sessions: SessionListRenderableSession[];
};

type SessionListHeaderItem = Extract<SessionListViewItem, { type: 'header' }>;

type SessionListGroupSessionKind = NonNullable<Extract<SessionListViewItem, { type: 'session' }>['groupKind']>;

function groupSessionsByProject(params: Readonly<{
    sessions: ReadonlyArray<SessionListRenderableSession>;
    machines: Record<string, MachineDisplayRenderable>;
    sessionTargetState?: SessionMachineTargetState;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();
    const sessionTargetState = params.sessionTargetState;

    for (const session of params.sessions) {
        const displayMachineId =
            sessionTargetState
                ? resolveDisplayMachineIdForSessionFromState({
                      state: sessionTargetState,
                      sessionId: session.id,
                      metadata: session.metadata ?? null,
                  })
                : session.metadata?.machineId ?? '';
        const displayPath =
            sessionTargetState
                ? resolveDisplayPathForSessionFromState({
                      state: sessionTargetState,
                      sessionId: session.id,
                      metadata: session.metadata ?? null,
                  })
                : session.metadata?.path ?? null;
        const machine = displayMachineId ? params.machines[displayMachineId] : undefined;
        const groupingParts = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
            session.metadata ?? null,
            machine?.metadata ?? null,
            displayPath,
        );
        const key = `${groupingParts.machineGroupId}:${groupingParts.pathKey}`;
        const normalizedMachineId = groupingParts.machineId;
        const normalizedRootPath = groupingParts.displayPath;

        const existing = groups.get(key);
        if (!existing) {
            const displayMachine = (() => {
                if (groupingParts.host) {
                    return resolveBestMachineDisplayRenderableForHost(params.machines, groupingParts.host) ?? makeUnknownMachine(groupingParts.host);
                }
                if (displayMachineId) {
                    return params.machines[displayMachineId] ?? makeUnknownMachine(displayMachineId);
                }
                return makeUnknownMachine('unknown');
            })();
            groups.set(key, {
                key,
                displayPath: groupingParts.pathKey ? formatPathRelativeToHome(groupingParts.pathKey, groupingParts.homeDir ?? undefined) : '',
                machine: displayMachine,
                workspaceMachineId: normalizedMachineId,
                workspaceRootPath: normalizedRootPath,
                latestCreatedAt: session.createdAt,
                sessions: [session],
            });
        } else {
            existing.sessions.push(session);
            existing.latestCreatedAt = Math.max(existing.latestCreatedAt, session.createdAt);
            if (!existing.workspaceMachineId && normalizedMachineId) {
                existing.workspaceMachineId = normalizedMachineId;
            }
            if (!existing.workspaceRootPath && normalizedRootPath) {
                existing.workspaceRootPath = normalizedRootPath;
            }
        }
    }

    const sortedGroups = Array.from(groups.values());
    if (sortedGroups.length > 1) {
        sortedGroups.sort((a, b) => {
            if (b.latestCreatedAt !== a.latestCreatedAt) return b.latestCreatedAt - a.latestCreatedAt;
            if (a.displayPath !== b.displayPath) return a.displayPath.localeCompare(b.displayPath);
            return a.key.localeCompare(b.key);
        });
    }

    for (const group of sortedGroups) {
        sortSessionListRenderableSessionsNewestFirstIfNeeded(group.sessions);
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
        const wsHash = hashFNV1a32Hex(group.key);
        const groupKey = `server:${params.serverKey}:${params.section}:project:${wsHash}`;
        const workspaceKey = `wl_${wsHash}`;

        const variant: 'default' | 'no-path' = hasGroupHeader ? 'no-path' : 'default';
        pushSessionGroupEntriesToList({
            listData: params.listData,
            section: params.section,
            groupKind: 'project',
            header: {
                title: group.displayPath,
                headerKind: 'project',
                groupKey,
                workspaceKey,
                workspaceScopeHint: params.serverScopeMeta.serverId && group.workspaceMachineId && group.workspaceRootPath
                    ? {
                        serverId: params.serverScopeMeta.serverId,
                        machineId: group.workspaceMachineId,
                        rootPath: group.workspaceRootPath,
                    }
                    : null,
                machine: group.machine,
                subtitle: group.machine.metadata?.displayName || group.machine.metadata?.host || group.machine.id,
            },
            sessions: group.sessions,
            variant,
            serverScopeMeta: params.serverScopeMeta,
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
        pushSessionGroupEntriesToList({
            listData: params.listData,
            section: params.section,
            groupKind: 'date',
            header: {
                title: headerTitle,
                headerKind: 'date',
                groupKey,
            },
            sessions: currentDateGroup,
            serverScopeMeta: params.serverScopeMeta,
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

function pushSharedGroupToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: 'active' | 'inactive';
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
}>): void {
    if (params.sessions.length === 0) return;

    const groupKey = `server:${params.serverKey}:${params.section}:shared`;
    pushSessionGroupEntriesToList({
        listData: params.listData,
        section: params.section,
        groupKind: 'shared',
        header: {
            title: t('friends.sharedSessions'),
            headerKind: 'shared',
            groupKey,
        },
        sessions: params.sessions,
        serverScopeMeta: params.serverScopeMeta,
    });
}

function pushSessionGroupEntriesToList(params: Readonly<{
    listData: SessionListViewItem[];
    header: Omit<SessionListHeaderItem, 'type'>;
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: 'active' | 'inactive';
    groupKind: SessionListGroupSessionKind;
    serverScopeMeta: ServerScopeMeta;
    variant?: 'default' | 'no-path';
}>): void {
    params.listData.push({
        type: 'header',
        ...params.header,
        ...params.serverScopeMeta,
    });

    for (const session of params.sessions) {
        params.listData.push({
            type: 'session',
            session,
            section: params.section,
            groupKey: params.header.groupKey,
            groupKind: params.groupKind,
            ...(params.variant ? { variant: params.variant } : {}),
            ...params.serverScopeMeta,
        });
    }
}

function pushSessionSectionToList(params: Readonly<{
    listData: SessionListViewItem[];
    ownedSessions: ReadonlyArray<SessionListRenderableSession>;
    sharedSessions: ReadonlyArray<SessionListRenderableSession>;
    section: 'active' | 'inactive';
    grouping: 'project' | 'date';
    machines: Record<string, MachineDisplayRenderable>;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
    sessionTargetState?: SessionMachineTargetState;
}>): void {
    if (params.ownedSessions.length === 0 && params.sharedSessions.length === 0) {
        return;
    }

    params.listData.push({
        type: 'header',
        title: params.section === 'active' ? 'Active' : 'Inactive',
        headerKind: params.section,
        ...params.serverScopeMeta,
    });

    pushSharedGroupToList({
        listData: params.listData,
        sessions: params.sharedSessions,
        section: params.section,
        serverKey: params.serverKey,
        serverScopeMeta: params.serverScopeMeta,
    });

    if (params.grouping === 'project') {
        pushProjectGroupsToList({
            listData: params.listData,
            groups: groupSessionsByProject({
                sessions: params.ownedSessions,
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
        sessions: params.ownedSessions,
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
    let hasOwnSession = false;
    for (const sessionIdRaw in sessions) {
        if (Object.prototype.hasOwnProperty.call(sessions, sessionIdRaw)) {
            hasOwnSession = true;
            break;
        }
    }
    if (!hasOwnSession) {
        return EMPTY_SESSION_LIST_VIEW_DATA;
    }

    const normalizedServerScope = options.serverScope
        ? normalizeSessionListServerScope(options.serverScope.serverId, options.serverScope.serverName)
        : null;
    const serverScopeMeta = normalizedServerScope
        ? {
            serverId: normalizedServerScope.serverId ?? undefined,
            serverName: normalizedServerScope.serverName ?? undefined,
        }
        : {};
    let activeOwnedSessions: SessionListRenderableSession[] | null = null;
    let inactiveOwnedSessions: SessionListRenderableSession[] | null = null;
    let activeSharedSessions: SessionListRenderableSession[] | null = null;
    let inactiveSharedSessions: SessionListRenderableSession[] | null = null;
    let visibleSessionCount = 0;

    for (const sessionIdRaw in sessions) {
        if (!Object.prototype.hasOwnProperty.call(sessions, sessionIdRaw)) {
            continue;
        }

        const session = sessions[sessionIdRaw];
        // Hide system sessions from user-facing lists by default.
        if (session.metadata?.hiddenSystemSession === true || isHiddenSystemSession({ metadata: session.metadata as never })) {
            continue;
        }
        visibleSessionCount += 1;
        const isSharedSession = typeof session.owner === 'string' && session.owner.trim().length > 0;
        if (isSharedSession) {
            if (isSessionActive(session)) {
                activeSharedSessions ??= [];
                activeSharedSessions.push(session);
            } else {
                inactiveSharedSessions ??= [];
                inactiveSharedSessions.push(session);
            }
        } else if (isSessionActive(session)) {
            activeOwnedSessions ??= [];
            activeOwnedSessions.push(session);
        } else {
            inactiveOwnedSessions ??= [];
            inactiveOwnedSessions.push(session);
        }
    }

    if (visibleSessionCount === 0) {
        return EMPTY_SESSION_LIST_VIEW_DATA;
    }

    activeOwnedSessions ??= [];
    inactiveOwnedSessions ??= [];
    activeSharedSessions ??= [];
    inactiveSharedSessions ??= [];

    sortSessionListRenderableSessionsNewestFirstIfNeeded(activeOwnedSessions);
    sortSessionListRenderableSessionsNewestFirstIfNeeded(inactiveOwnedSessions);
    sortSessionListRenderableSessionsNewestFirstIfNeeded(activeSharedSessions);
    sortSessionListRenderableSessionsNewestFirstIfNeeded(inactiveSharedSessions);

    const listData: SessionListViewItem[] = [];

    const serverKey = normalizeSessionListKeyParts(normalizedServerScope?.serverId).serverKey;

    pushSessionSectionToList({
        listData,
        ownedSessions: activeOwnedSessions,
        sharedSessions: activeSharedSessions,
        section: 'active',
        grouping: resolveGroupingForSection('active', options),
        machines,
        serverKey,
        serverScopeMeta,
        sessionTargetState: options.sessionTargetState,
    });

    pushSessionSectionToList({
        listData,
        ownedSessions: inactiveOwnedSessions,
        sharedSessions: inactiveSharedSessions,
        section: 'inactive',
        grouping: resolveGroupingForSection('inactive', options),
        machines,
        serverKey,
        serverScopeMeta,
        sessionTargetState: options.sessionTargetState,
    });

    return listData.length === 0 ? EMPTY_SESSION_LIST_VIEW_DATA : listData;
}
