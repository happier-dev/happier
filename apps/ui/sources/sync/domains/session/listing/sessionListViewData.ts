import { normalizeSessionFolderWorkspaceRef } from '@/sync/domains/session/folders/workspaceRefs';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders/types';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { isUserFacingSession } from './isUserFacingSession';
import {
    buildSessionProjectGroupingIdentity,
    resolveSessionProjectGroupingKeyPartsWithMachineMetadata,
    sessionProjectGroupingIdentityKey,
} from './sessionListProjectGroupingKeys';
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
import { buildSessionListDateGroups } from './sessionListDateGroups';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'sessions' | 'project' | 'pinned' | 'loading' | 'folder';
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
        /** The group's session-folder scope when it is not a path (the Chats group). */
        workspace?: SessionFolderWorkspaceRefV1;
    }
    | {
        type: 'session';
        session: SessionListRenderableSession;
        section?: 'active' | 'inactive';
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'loading' | 'folder';
        pinned?: boolean;
        variant?: 'default' | 'no-path';
        serverId?: string;
        serverName?: string;
        folderId?: string | null;
        workspace?: SessionFolderWorkspaceRefV1;
        folderDepth?: number;
    };

export interface BuildSessionListViewDataOptions {
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
    /** The group title: the folder, or "Chats" for the machine's no-folder sessions. */
    displayPath: string;
    bucket: 'path' | 'managed';
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
    serverId?: string | null;
    machines: Record<string, MachineDisplayRenderable>;
    metadata: Readonly<{
        machineId?: string | null;
        path?: string | null;
        homeDir?: string | null;
    }> | null;
}>): SessionTargetDisplay {
    const reachableTarget = resolveDisplayMachineTargetForSessionFromState({
        state: params.state,
        sessionId: params.sessionId,
        serverId: params.serverId,
        metadata: params.metadata,
    }) ?? resolveMachineTargetForSessionFromState(params.state, params.serverId
        ? { serverId: params.serverId, sessionId: params.sessionId }
        : params.sessionId);
    const targetMachineId = normalizeTrimmedString(reachableTarget?.machineId);
    if (
        targetMachineId
        && !targetMachineId.startsWith('host:')
        && !params.machines[targetMachineId]
    ) {
        const metadataMachineId = normalizeTrimmedString(params.metadata?.machineId);
        if (
            metadataMachineId
            && !metadataMachineId.startsWith('host:')
            && params.machines[metadataMachineId]
        ) {
            return {
                machineId: metadataMachineId,
                path: params.metadata?.path ?? reachableTarget?.basePath ?? null,
            };
        }
        const metadataHomeDir = normalizeTrimmedString(params.metadata?.homeDir);
        const matchingMachine = metadataHomeDir
            ? Object.values(params.machines).filter((machine) =>
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
    serverId: string | null;
    sessionTargetState?: SessionMachineTargetState;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();
    const sessionTargetState = params.sessionTargetState;

    for (const session of params.sessions) {
        const sessionTargetDisplay = sessionTargetState
            ? resolveSessionTargetDisplayFromState({
                  state: sessionTargetState,
                  sessionId: session.id,
                  serverId: params.serverId,
                  machines: params.machines,
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
        const key = sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(
            params.serverId,
            groupingParts,
        ));

        const existing = groups.get(key);
        if (!existing) {
            const displayMachine = displayMachineId
                ? params.machines[displayMachineId] ?? makeUnknownMachine(displayMachineId)
                : makeUnknownMachine('unknown');
            groups.set(key, {
                key,
                displayPath: groupingParts.bucket === 'managed'
                    ? t('session.folderless.chats')
                    : groupingParts.pathKey ? formatPathRelativeToHome(groupingParts.pathKey, groupingParts.homeDir ?? undefined) : '',
                bucket: groupingParts.bucket,
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

function resolveFolderWorkspaceForProjectGroup(params: Parameters<typeof resolveWorkspaceScopeHintForGroup>[0]): SessionFolderWorkspaceRefV1 | null {
    if (params.group.bucket === 'managed') return normalizeSessionFolderWorkspaceRef({
        t: 'managedSessions', serverId: params.serverId, machineId: params.group.machine.id,
    });
    const hint = resolveWorkspaceScopeHintForGroup(params);
    return hint ? normalizeSessionFolderWorkspaceRef({ t: 'workspaceScope', ...hint }) : null;
}

function pushProjectGroupsToList(params: Readonly<{
    listData: SessionListViewItem[];
    groups: ReadonlyArray<ProjectGroup>;
    section: SessionListSectionScope;
    serverScopeMeta: ServerScopeMeta;
    machines: Record<string, MachineDisplayRenderable>;
    sessionTargetState?: WorkspaceTargetForSessionState;
}>): void {
    // Group subtitles are machine names shown together, so same-named machines are told apart.
    const machineNames = resolveMachineDisplayNames(Object.values(params.machines));
    for (const group of params.groups) {
        const hasGroupHeader = Boolean(group.displayPath);
        const groupKey = group.key;
        const workspaceKey = group.key;

        const variant: 'default' | 'no-path' = hasGroupHeader ? 'no-path' : 'default';
        const workspace = resolveFolderWorkspaceForProjectGroup({ group, machines: params.machines,
            serverId: params.serverScopeMeta.serverId, sessionTargetState: params.sessionTargetState });
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
                ...(workspace ? { workspace } : {}),
                // A machine missing from the inventory has no name to show; its id is the only identity.
                subtitle: params.machines[group.machine.id]
                    ? machineNames.get(group.machine.id) ?? getMachineDisplayName(group.machine)
                    : group.machine.id,
            },
            sessions: group.sessions,
            workspacesBySessionId: new Map(workspace ? group.sessions.map(session => [session.id, workspace]) : []),
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
    // Chats are not a workspace: a private folder never becomes a project or a scope.
    if (!serverId || params.group.bucket === 'managed') {
        return null;
    }

    if (params.sessionTargetState) {
        for (const session of params.group.sessions) {
            const target = resolveWorkspaceTargetForSessionFromState(
                params.sessionTargetState,
                { sessionId: session.id, serverId },
            );
            if (!target) {
                const displayTarget = resolveSessionTargetDisplayFromState({
                    state: params.sessionTargetState,
                    sessionId: session.id,
                    serverId,
                    machines: params.machines,
                    metadata: session.metadata ?? null,
                });
                if (!displayTarget.machineId || !displayTarget.path || !params.machines[displayTarget.machineId]) {
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
    workspacesBySessionId: ReadonlyMap<string, SessionFolderWorkspaceRefV1>;
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
            ...(params.workspacesBySessionId.has(session.id) ? { workspace: params.workspacesBySessionId.get(session.id) } : {}),
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

/**
 * Emits one section for the whole qualified corpus.
 *
 * Access source is not a layout axis: owned, direct-share, Team and Group rows all
 * enter the same project/date grouping here, and direct access stays visible through
 * the canonical row context projection instead of an ownership partition.
 */
function pushSessionSectionToList(params: Readonly<{
    listData: SessionListViewItem[];
    sessions: ReadonlyArray<SessionListRenderableSession>;
    section: SessionListSectionScope;
    grouping: 'project' | 'date';
    machines: Record<string, MachineDisplayRenderable>;
    serverKey: string;
    projectServerId: string | null;
    serverScopeMeta: ServerScopeMeta;
    sessionTargetState?: SessionMachineTargetState;
}>): void {
    if (params.sessions.length === 0) {
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

    const projectGroups = groupSessionsByProject({ sessions: params.sessions, machines: params.machines,
        serverId: params.projectServerId, sessionTargetState: params.sessionTargetState });
    if (params.grouping === 'project') {
        pushProjectGroupsToList({
            listData: params.listData,
            groups: projectGroups,
            section: params.section,
            serverScopeMeta: params.serverScopeMeta,
            machines: params.machines,
            sessionTargetState: params.sessionTargetState,
        });
        return;
    }

    const workspacesBySessionId = new Map<string, SessionFolderWorkspaceRefV1>();
    for (const group of projectGroups) {
        const workspace = resolveFolderWorkspaceForProjectGroup({ group, machines: params.machines,
            serverId: params.serverScopeMeta.serverId, sessionTargetState: params.sessionTargetState });
        if (workspace) for (const session of group.sessions) workspacesBySessionId.set(session.id, workspace);
    }
    const dateGroupedSessions = sortSessionListRenderableSessionsNewestUpdatedFirstIfNeeded([...params.sessions]);
    for (const group of buildSessionListDateGroups({
        items: dateGroupedSessions,
        readMeaningfulActivityAt: resolveSessionListRenderableMeaningfulActivityAt,
    })) {
        const groupKey = `server:${params.serverKey}:${params.section}:day:${group.dateKey}`;
        pushSessionGroupEntriesToList({
            listData: params.listData,
            section: params.section,
            groupKind: 'date',
            header: {
                title: group.title,
                headerKind: 'date',
                groupKey,
            },
            sessions: group.items,
            workspacesBySessionId,
            serverScopeMeta: params.serverScopeMeta,
        });
    }
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
    let activeSessions: SessionListRenderableSession[] | null = null;
    let inactiveSessions: SessionListRenderableSession[] | null = null;
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
        if (session.active) {
            activeSessions ??= [];
            activeSessions.push(session);
        } else {
            inactiveSessions ??= [];
            inactiveSessions.push(session);
        }
    }

    if (visibleSessionCount === 0) {
        return EMPTY_SESSION_LIST_VIEW_DATA;
    }

    activeSessions ??= [];
    inactiveSessions ??= [];

    sortSessionListRenderableSessionsNewestFirstIfNeeded(activeSessions);
    sortSessionListRenderableSessionsNewestFirstIfNeeded(inactiveSessions);

    const listData: SessionListViewItem[] = [];

    const serverKey = normalizeSessionListKeyParts(normalizedServerScope?.serverId).serverKey;
    const groupingModes = resolveSessionListGroupingModes({
        activeGroupingV1: options.activeGroupingV1,
        inactiveGroupingV1: options.inactiveGroupingV1,
        sectionModeV1: options.sectionModeV1,
    });

    if (groupingModes.sectionMode === 'single') {
        const sessions = [...activeSessions, ...inactiveSessions];
        sortSessionListRenderableSessionsNewestFirstIfNeeded(sessions);
        pushSessionSectionToList({
            listData,
            sessions,
            section: 'sessions',
            grouping: groupingModes.activeGrouping,
            machines,
            serverKey,
            projectServerId: normalizedServerScope?.serverId ?? null,
            serverScopeMeta,
            sessionTargetState: options.sessionTargetState,
        });
        return listData.length === 0 ? EMPTY_SESSION_LIST_VIEW_DATA : listData;
    }

    pushSessionSectionToList({
        listData,
        sessions: activeSessions,
        section: 'active',
        grouping: groupingModes.activeGrouping,
        machines,
        serverKey,
        projectServerId: normalizedServerScope?.serverId ?? null,
        serverScopeMeta,
        sessionTargetState: options.sessionTargetState,
    });

    pushSessionSectionToList({
        listData,
        sessions: inactiveSessions,
        section: 'inactive',
        grouping: groupingModes.inactiveGrouping,
        machines,
        serverKey,
        projectServerId: normalizedServerScope?.serverId ?? null,
        serverScopeMeta,
        sessionTargetState: options.sessionTargetState,
    });

    return listData.length === 0 ? EMPTY_SESSION_LIST_VIEW_DATA : listData;
}
