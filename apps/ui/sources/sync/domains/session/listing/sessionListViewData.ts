import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { isUserFacingSession } from './isUserFacingSession';
import { resolveSessionProjectGroupingKeyPartsWithMachineMetadata } from './sessionListProjectGroupingKeys';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import { normalizeSessionListServerScope } from './normalizeSessionListServerScope';
import {
    resolveSessionListRenderableMeaningfulActivityAt,
    sortSessionListRenderableSessionsNewestFirstIfNeeded,
    sortSessionListRenderableSessionsNewestUpdatedFirstIfNeeded,
} from './sessionListRenderableSorting';
import { resolveSessionListGroupingModes, type SessionListSectionMode } from './resolveSessionListGroupingModes';
import { t } from '@/text';
import {
    resolveDisplayMachineTargetForSessionFromState,
    resolveMachineTargetForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import {
    resolveWorkspaceTargetForSessionFromState,
    type WorkspaceTargetForSessionState,
} from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'sessions' | 'project' | 'pinned' | 'shared' | 'folder';
        groupKey?: string;
        workspaceKey?: string;
        seedSessionId?: string | null;
        workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        serverId?: string;
        serverName?: string;
        subtitle?: string;
        machine?: MachineDisplayRenderable;
        folderId?: string;
        folderDepth?: number;
    }
    | {
        type: 'session';
        session: SessionListRenderableSession;
        section?: 'active' | 'inactive';
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'shared' | 'folder';
        pinned?: boolean;
        variant?: 'default' | 'no-path';
        serverId?: string;
        serverName?: string;
        folderId?: string | null;
        folderDepth?: number;
    };

export interface BuildSessionListViewDataOptions {
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    sectionModeV1?: SessionListSectionMode;
    /**
     * Optional state snapshot used to resolve reachable machine targets when session metadata is stale
     * and to derive canonical workspace scope hints for grouped project headers.
     */
    sessionTargetState?: WorkspaceTargetForSessionState;
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
    latestCreatedAt: number;
    sessions: SessionListRenderableSession[];
};

type SessionListHeaderItem = Extract<SessionListViewItem, { type: 'header' }>;

type SessionListGroupSessionKind = NonNullable<Extract<SessionListViewItem, { type: 'session' }>['groupKind']>;
type SessionListActivitySection = 'active' | 'inactive';
type SessionListSectionScope = SessionListActivitySection | 'sessions';

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
        homeDir?: string | null;
    }> | null;
}>): SessionTargetDisplay {
    const reachableTarget = resolveDisplayMachineTargetForSessionFromState({
        state: params.state,
        sessionId: params.sessionId,
        metadata: params.metadata,
    }) ?? resolveMachineTargetForSessionFromState(params.state, params.sessionId);
    const targetMachineId = normalizeTrimmedString(reachableTarget?.machineId);
    if (
        targetMachineId
        && !targetMachineId.startsWith('host:')
        && !params.state.machines?.[targetMachineId]
    ) {
        const metadataMachineId = normalizeTrimmedString(params.metadata?.machineId);
        if (
            metadataMachineId
            && !metadataMachineId.startsWith('host:')
            && params.state.machines?.[metadataMachineId]
        ) {
            return {
                machineId: metadataMachineId,
                path: params.metadata?.path ?? reachableTarget?.basePath ?? null,
            };
        }
        const metadataHomeDir = normalizeTrimmedString(params.metadata?.homeDir);
        const matchingMachine = metadataHomeDir
            ? Object.values(params.state.machines ?? {}).filter((machine) =>
                normalizeTrimmedString(machine.metadata?.homeDir) === metadataHomeDir,
            )
            : [];
        if (matchingMachine.length === 1 && matchingMachine[0]?.id) {
            return {
                machineId: matchingMachine[0].id,
                path: reachableTarget?.basePath ?? params.metadata?.path ?? null,
            };
        }
    }
    return {
        machineId:
            targetMachineId
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
        const groupingMetadata = displayMachineId || displayPath
            ? {
                ...(session.metadata ?? {}),
                ...(displayMachineId ? { machineId: displayMachineId } : {}),
                ...(displayPath ? { path: displayPath } : {}),
            }
            : session.metadata ?? null;
        const groupingParts = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
            groupingMetadata,
            machine?.metadata ?? null,
            displayPath,
        );
        const key = `${groupingParts.machineGroupId}:${groupingParts.pathKey}`;

        const existing = groups.get(key);
        if (!existing) {
            const displayMachine = displayMachineId
                ? params.machines[displayMachineId] ?? makeUnknownMachine(displayMachineId)
                : makeUnknownMachine('unknown');
            groups.set(key, {
                key,
                displayPath: groupingParts.pathKey ? formatPathRelativeToHome(groupingParts.pathKey, groupingParts.homeDir ?? undefined) : '',
                machine: displayMachine,
                latestCreatedAt: session.createdAt,
                sessions: [session],
            });
        } else {
            existing.sessions.push(session);
            existing.latestCreatedAt = Math.max(existing.latestCreatedAt, session.createdAt);
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
    section: SessionListSectionScope;
    serverKey: string;
    serverScopeMeta: ServerScopeMeta;
    machines: Record<string, MachineDisplayRenderable>;
    sessionTargetState?: WorkspaceTargetForSessionState;
}>): void {
    for (const group of params.groups) {
        const hasGroupHeader = Boolean(group.displayPath);
        let wsHash = 0x811c9dc5;
        for (let index = 0; index < group.key.length; index += 1) {
            wsHash ^= group.key.charCodeAt(index);
            wsHash = (wsHash * 0x01000193) >>> 0;
        }
        const wsHashHex = wsHash.toString(16).padStart(8, '0');
        const groupKey = `server:${params.serverKey}:project:${wsHashHex}`;
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
                seedSessionId: group.sessions[0]?.id ?? null,
                workspaceScopeHint: resolveWorkspaceScopeHintForGroup({
                    group,
                    machines: params.machines,
                    serverId: params.serverScopeMeta.serverId,
                    sessionTargetState: params.sessionTargetState,
                }),
                machine: group.machine,
                subtitle: group.machine.metadata?.displayName || group.machine.metadata?.host || group.machine.id,
            },
            sessions: group.sessions,
            variant,
            serverScopeMeta: params.serverScopeMeta,
        });
    }
}

function resolveWorkspaceScopeHintForGroup(params: Readonly<{
    group: ProjectGroup;
    machines: Record<string, MachineDisplayRenderable>;
    serverId?: string;
    sessionTargetState?: WorkspaceTargetForSessionState;
}>): SessionListHeaderItem['workspaceScopeHint'] {
    const serverId = normalizeTrimmedString(params.serverId);
    if (!serverId) {
        return null;
    }

    if (params.sessionTargetState) {
        for (const session of params.group.sessions) {
            const target = resolveWorkspaceTargetForSessionFromState(
                params.sessionTargetState,
                session.id,
                { fallbackServerId: serverId },
            );
            if (!target) {
                const displayTarget = resolveSessionTargetDisplayFromState({
                    state: params.sessionTargetState,
                    sessionId: session.id,
                    metadata: session.metadata ?? null,
                });
                if (!displayTarget.machineId || !displayTarget.path || !params.sessionTargetState.machines?.[displayTarget.machineId]) {
                    continue;
                }
                return {
                    serverId,
                    machineId: displayTarget.machineId,
                    rootPath: displayTarget.path,
                };
            }
            return {
                serverId: target.serverId,
                machineId: target.machineId,
                rootPath: target.rootPath,
            };
        }
        return null;
    }

    for (const session of params.group.sessions) {
        const machineId = normalizeTrimmedString(session.metadata?.machineId);
        if (!machineId) {
            continue;
        }
        const machine = params.machines[machineId];
        const groupingParts = resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
            session.metadata ?? null,
            machine?.metadata ?? null,
            session.metadata?.path,
        );
        if (!groupingParts.pathKey) {
            continue;
        }
        return {
            serverId,
            machineId,
            rootPath: groupingParts.pathKey,
        };
    }

    return null;
}

function pushSessionGroupEntriesToList(params: Readonly<{
    listData: SessionListViewItem[];
    header: Omit<SessionListHeaderItem, 'type'>;
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
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
            section: resolveSectionForSession(params.section, session),
            groupKey: params.header.groupKey,
            groupKind: params.groupKind,
            ...(params.variant ? { variant: params.variant } : {}),
            ...params.serverScopeMeta,
        });
    }
}

function resolveSectionForSession(
    section: SessionListSectionScope,
    session: SessionListRenderableSession,
): SessionListActivitySection {
    if (section !== 'sessions') {
        return section;
    }
    return session.active ? 'active' : 'inactive';
}

function pushSessionSectionToList(params: Readonly<{
    listData: SessionListViewItem[];
    ownedSessions: ReadonlyArray<SessionListRenderableSession>;
    sharedSessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
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
        title: params.section === 'sessions'
            ? t('tabs.sessions')
            : params.section === 'active'
                ? t('common.active')
                : t('common.inactive'),
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
            machines: params.machines,
            sessionTargetState: params.sessionTargetState,
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
    const dateGroupedSessions = sortSessionListRenderableSessionsNewestUpdatedFirstIfNeeded([...params.ownedSessions]);

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

    for (const session of dateGroupedSessions) {
        const sessionDate = new Date(resolveSessionListRenderableMeaningfulActivityAt(session));
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
        if (!isUserFacingSession(session)) {
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
        sectionModeV1: options.sectionModeV1,
    });

    if (groupingModes.sectionMode === 'single') {
        const ownedSessions = [...activeOwnedSessions, ...inactiveOwnedSessions];
        const sharedSessions = [...activeSharedSessions, ...inactiveSharedSessions];
        sortSessionListRenderableSessionsNewestFirstIfNeeded(ownedSessions);
        sortSessionListRenderableSessionsNewestFirstIfNeeded(sharedSessions);
        pushSessionSectionToList({
            listData,
            ownedSessions,
            sharedSessions,
            section: 'sessions',
            grouping: groupingModes.activeGrouping,
            machines,
            serverKey,
            serverScopeMeta,
            sessionTargetState: options.sessionTargetState,
        });
        return listData.length === 0 ? EMPTY_SESSION_LIST_VIEW_DATA : listData;
    }

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
