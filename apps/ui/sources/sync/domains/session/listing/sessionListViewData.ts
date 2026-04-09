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
import { resolveSessionListGroupingModes } from './resolveSessionListGroupingModes';
import { t } from '@/text';
import {
    resolveMachineTargetForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';
import { normalizeTrimmedString } from './normalizeTrimmedString';

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

type SessionTargetDisplay = Readonly<{
    machineId: string;
    path: string | null;
}>;

function resolveSessionTargetDisplayFromState(params: Readonly<{
    state: SessionMachineTargetState;
    sessionId: string;
    metadata: Readonly<{
        machineId?: string | null;
        path?: string | null;
    }> | null;
}>): SessionTargetDisplay {
    const reachableTarget = resolveMachineTargetForSessionFromState(params.state, params.sessionId);
    return {
        machineId:
            reachableTarget?.machineId
            ?? normalizeTrimmedString(params.metadata?.machineId)
            ?? '',
        path: reachableTarget?.basePath ?? params.metadata?.path ?? null,
    };
}

function groupSessionsByProject(params: Readonly<{
    sessions: ReadonlyArray<SessionListRenderableSession>;
    machines: Record<string, MachineDisplayRenderable>;
    sessionTargetState?: SessionMachineTargetState;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();
    const sessionTargetState = params.sessionTargetState;

    for (const session of params.sessions) {
        const sessionTargetDisplay = sessionTargetState
            ? resolveSessionTargetDisplayFromState({
                  state: sessionTargetState,
                  sessionId: session.id,
                  metadata: session.metadata ?? null,
              })
            : null;
        const displayMachineId = sessionTargetDisplay?.machineId ?? session.metadata?.machineId ?? '';
        const displayPath = sessionTargetDisplay?.path ?? session.metadata?.path ?? null;
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
            const displayMachine = groupingParts.host
                ? resolveBestMachineDisplayRenderableForHost(params.machines, groupingParts.host) ?? makeUnknownMachine(groupingParts.host)
                : displayMachineId
                    ? params.machines[displayMachineId] ?? makeUnknownMachine(displayMachineId)
                    : makeUnknownMachine('unknown');
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
        let wsHash = 0x811c9dc5;
        for (let index = 0; index < group.key.length; index += 1) {
            wsHash ^= group.key.charCodeAt(index);
            wsHash = (wsHash * 0x01000193) >>> 0;
        }
        const wsHashHex = wsHash.toString(16).padStart(8, '0');
        const groupKey = `server:${params.serverKey}:${params.section}:project:${wsHashHex}`;
        const workspaceKey = `wl_${wsHashHex}`;

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
        title: params.section === 'active' ? t('common.active') : t('common.inactive'),
        headerKind: params.section,
        groupKey: `${params.section}:${params.serverScopeMeta.serverId ?? 'local'}`,
        ...params.serverScopeMeta,
    });

    if (params.sharedSessions.length > 0) {
        pushSessionGroupEntriesToList({
            listData: params.listData,
            section: params.section,
            groupKind: 'shared',
            header: {
                title: t('friends.sharedSessions'),
                headerKind: 'shared',
                groupKey: `server:${params.serverKey}:${params.section}:shared`,
            },
            sessions: params.sharedSessions,
            serverScopeMeta: params.serverScopeMeta,
        });
    }

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

    if (params.ownedSessions.length === 0) {
        return;
    }

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

        const groupKey = `server:${params.serverKey}:${params.section}:day:${sessionDateOnly.getFullYear()}-${String(sessionDateOnly.getMonth() + 1).padStart(2, '0')}-${String(sessionDateOnly.getDate()).padStart(2, '0')}`;
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

    for (const session of params.ownedSessions) {
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

export function buildSessionListViewData(
    sessions: Readonly<Record<string, SessionListRenderableSession>>,
    machines: Readonly<Record<string, MachineDisplayRenderable>>,
    options: BuildSessionListViewDataOptions
): SessionListViewItem[] {
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
            if (session.active) {
                activeSharedSessions ??= [];
                activeSharedSessions.push(session);
            } else {
                inactiveSharedSessions ??= [];
                inactiveSharedSessions.push(session);
            }
        } else if (session.active) {
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
    const groupingModes = resolveSessionListGroupingModes({
        groupInactiveSessionsByProject: options.groupInactiveSessionsByProject,
        activeGroupingV1: options.activeGroupingV1,
        inactiveGroupingV1: options.inactiveGroupingV1,
    });

    pushSessionSectionToList({
        listData,
        ownedSessions: activeOwnedSessions,
        sharedSessions: activeSharedSessions,
        section: 'active',
        grouping: groupingModes.activeGrouping,
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
        grouping: groupingModes.inactiveGrouping,
        machines,
        serverKey,
        serverScopeMeta,
        sessionTargetState: options.sessionTargetState,
    });

    return listData.length === 0 ? EMPTY_SESSION_LIST_VIEW_DATA : listData;
}
