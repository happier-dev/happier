import { normalizeSessionFolderWorkspaceRef } from '@/sync/domains/session/folders/workspaceRefs';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders/types';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
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
import { resolveSessionListGroupingMode } from './resolveSessionListGroupingMode';
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
import type { SessionListOccurrenceRole } from '../../sessionList/sessionListIndex';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createSessionProjectKeyResolverV1, resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey, type SessionListFallbackGroupDisplay } from '@/sync/domains/workspaces/projectGroupDisplay';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { buildSessionWorkspaceFallbackOrderKey, readSessionWorkspaceFallbackIdentity } from './sessionWorkspaceOrderKeys';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';

export type SessionListViewItem =
    | {
        type: 'header';
        title: string;
        eligibleCount?: number;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'sessions' | 'project' | 'pinned' | 'loading' | 'folder';
        groupKey?: string;
        presentationAnchorGroupKey?: string;
        workspaceKey?: string;
        projectKey?: QualifiedProjectKeyV1;
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
        projectKey?: QualifiedProjectKeyV1;
        fallbackGroupDisplay?: SessionListFallbackGroupDisplay;
        occurrenceRole?: SessionListOccurrenceRole;
        supplementalAttention?: true;
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
    layoutV1?: 'projects' | 'recent_activity';
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceRefsServerId?: string;
    viewerAccountId?: string;
    sessionProjectKeyResolver?: ReturnType<typeof createSessionProjectKeyResolverV1>;
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
    projectKey?: QualifiedProjectKeyV1;
    baseline?: WorkspaceRefV1 | null;
    /** The group title: the folder, or "Chats" for the machine's no-folder sessions. */
    displayPath: string;
    bucket: 'path' | 'managed';
    machine: MachineDisplayRenderable;
    earliestCreatedAt: number;
    sessions: SessionListRenderableSession[];
    workspacesBySessionId: Map<string, SessionFolderWorkspaceRefV1>;
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
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceRefsServerId?: string;
    viewerAccountId?: string;
    sessionProjectKeyResolver?: ReturnType<typeof createSessionProjectKeyResolverV1>;
    sessionTargetState?: SessionMachineTargetState;
}>): ProjectGroup[] {
    const groups = new Map<string, ProjectGroup>();
    const sessionTargetState = params.sessionTargetState;
    const resolveProjectKey = params.sessionProjectKeyResolver
        ?? createSessionProjectKeyResolverV1(params.workspaceRefs, workspaceRefResolutionContextV1());

    const displayByProject = buildProjectGroupDisplayIndex(params.workspaceRefs ?? []);

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
        const census = admitProjectWorkspaceCensusForSubject({
            subject: { kind: 'session', ownerAccountId: session.ownerAccountId, access: session.access, accessLevel: session.accessLevel },
            rowServerId: params.serverId ?? '', censusServerId: params.workspaceRefsServerId,
            viewerAccountId: params.viewerAccountId, workspaceRefs: params.workspaceRefs, sessionProjectKeyResolver: resolveProjectKey,
        });
        const resolution = census.sessionProjectKeyResolver
            ? census.sessionProjectKeyResolver(session.metadata, params.serverId ?? '', session.projectKey)
            : resolveSessionProjectKeyV1(session.metadata, params.serverId ?? '', undefined,
                { ...workspaceRefResolutionContextV1(), projectKey: session.projectKey });
        const project = resolution.kind === 'resolved' ? resolution.projectKey : undefined;
        const key = project ? projectGroupIdentityKey(project) : sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(
            params.serverId,
            groupingParts,
        ));
        const projectDisplay = project ? displayByProject.get(key) : undefined;
        const workspace = normalizeSessionFolderWorkspaceRef(groupingParts.bucket === 'managed'
            ? { t: 'managedSessions', serverId: params.serverId, machineId: groupingParts.machineId }
            : { t: 'workspaceScope', serverId: params.serverId, machineId: groupingParts.machineId, rootPath: groupingParts.pathKey });

        const existing = groups.get(key);
        if (!existing) {
            const displayMachine = displayMachineId
                ? params.machines[displayMachineId] ?? makeUnknownMachine(displayMachineId)
                : makeUnknownMachine('unknown');
            groups.set(key, {
                key,
                ...(project ? { projectKey: project, baseline: projectDisplay?.baseline ?? null } : {}),
                displayPath: project ? projectDisplay?.title ?? t('common.loading') : groupingParts.bucket === 'managed'
                    ? t('session.folderless.chats')
                    : groupingParts.pathKey ? formatSessionPath(groupingParts.pathKey, groupingParts.homeDir ?? undefined) : '',
                bucket: project ? 'path' : groupingParts.bucket,
                machine: project ? projectDisplay?.baseline
                    ? params.machines[projectDisplay.baseline.machineId] ?? makeUnknownMachine(projectDisplay.baseline.machineId)
                    : makeUnknownMachine('unknown') : displayMachine,
                earliestCreatedAt: session.createdAt,
                sessions: [session],
                workspacesBySessionId: new Map(workspace ? [[session.id, workspace]] : []),
            });
        } else {
            existing.sessions.push(session);
            existing.earliestCreatedAt = Math.min(existing.earliestCreatedAt, session.createdAt);
            if (workspace) existing.workspacesBySessionId.set(session.id, workspace);
        }
    }

    const sortedGroups = Array.from(groups.values());
    if (sortedGroups.length > 1) {
        sortedGroups.sort((a, b) => {
            if (a.earliestCreatedAt !== b.earliestCreatedAt) return a.earliestCreatedAt - b.earliestCreatedAt;
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
    const unlistedMachines = new Map(params.groups
        .filter((group) => !params.machines[group.machine.id])
        .map((group) => [group.machine.id, { ...group.machine, absence: 'unlisted' as const }]));
    const machineNames = resolveMachineDisplayNames([...Object.values(params.machines), ...unlistedMachines.values()]);
    for (const group of params.groups) {
        const hasGroupHeader = Boolean(group.displayPath);
        const groupKey = group.key;
        const fallbackIdentity = readSessionWorkspaceFallbackIdentity(group.key);
        const workspaceKey = fallbackIdentity ? buildSessionWorkspaceFallbackOrderKey(fallbackIdentity) : group.key;

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
                ...(group.projectKey ? { projectKey: group.projectKey } : {}),
                seedSessionId: group.sessions[0]?.id ?? null,
                workspaceScopeHint: resolveWorkspaceScopeHintForGroup({
                    group,
                    machines: params.machines,
                    serverId: params.serverScopeMeta.serverId,
                    sessionTargetState: params.sessionTargetState,
                }),
                machine: group.machine,
                ...(workspace ? { workspace } : {}),
                // A machine missing from the inventory is named by the shared owner as unlisted, with its short id as the telling suffix.
                subtitle: machineNames.get(group.machine.id) ?? getMachineDisplayName(group.machine),
            },
            sessions: group.sessions,
            workspacesBySessionId: group.workspacesBySessionId,
            fallbackGroupDisplay: resolveFallbackGroupDisplay(group),
            variant,
            serverScopeMeta: params.serverScopeMeta,
        });
    }
}

function resolveFallbackGroupDisplay(group: ProjectGroup): SessionListFallbackGroupDisplay | undefined {
    if (group.projectKey || !group.displayPath) return undefined;
    return { groupKey: group.key, title: resolveWorkspaceDisplayPresentation({
        scope: null, workspaceRefs: [], fallbackPathLabel: group.displayPath,
    }).displayTitle };
}

function resolveWorkspaceScopeHintForGroup(params: Readonly<{
    group: ProjectGroup;
    machines: Record<string, MachineDisplayRenderable>;
    serverId?: string;
    sessionTargetState?: WorkspaceTargetForSessionState;
}>): SessionListHeaderItem['workspaceScopeHint'] {
    const serverId = normalizeTrimmedString(params.serverId);
    if (params.group.projectKey) {
        const baseline = params.group.baseline;
        return baseline ? { serverId: baseline.serverId, machineId: baseline.machineId, rootPath: baseline.rootPath } : null;
    }
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
    projectKeysBySessionId?: ReadonlyMap<string, QualifiedProjectKeyV1>;
    fallbackGroupDisplay?: SessionListFallbackGroupDisplay;
    fallbackGroupDisplaysBySessionId?: ReadonlyMap<string, SessionListFallbackGroupDisplay>;
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
            ...((params.fallbackGroupDisplay ?? params.fallbackGroupDisplaysBySessionId?.get(session.id))
                ? { fallbackGroupDisplay: params.fallbackGroupDisplay ?? params.fallbackGroupDisplaysBySessionId?.get(session.id) } : {}),
            ...((params.header.projectKey ?? params.projectKeysBySessionId?.get(session.id))
                ? { projectKey: params.header.projectKey ?? params.projectKeysBySessionId?.get(session.id) } : {}),
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
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceRefsServerId?: string;
    viewerAccountId?: string;
    sessionProjectKeyResolver?: ReturnType<typeof createSessionProjectKeyResolverV1>;
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
        serverId: params.projectServerId, sessionTargetState: params.sessionTargetState, workspaceRefs: params.workspaceRefs,
        workspaceRefsServerId: params.workspaceRefsServerId, viewerAccountId: params.viewerAccountId,
        sessionProjectKeyResolver: params.sessionProjectKeyResolver });
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
    const projectKeysBySessionId = new Map<string, QualifiedProjectKeyV1>();
    const fallbackGroupDisplaysBySessionId = new Map<string, SessionListFallbackGroupDisplay>();
    for (const group of projectGroups) {
        for (const [id, workspace] of group.workspacesBySessionId) workspacesBySessionId.set(id, workspace);
        if (group.projectKey) for (const session of group.sessions) projectKeysBySessionId.set(session.id, group.projectKey);
        const fallbackDisplay = resolveFallbackGroupDisplay(group);
        if (fallbackDisplay) for (const session of group.sessions) fallbackGroupDisplaysBySessionId.set(session.id, fallbackDisplay);
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
            projectKeysBySessionId,
            fallbackGroupDisplaysBySessionId,
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
    const visibleSessions: SessionListRenderableSession[] = [];

    for (const sessionIdRaw in sessions) {
        if (!Object.prototype.hasOwnProperty.call(sessions, sessionIdRaw)) {
            continue;
        }

        const session = sessions[sessionIdRaw];
        // Hide system sessions from user-facing lists by default.
        if (!isUserFacingSession(session)) {
            continue;
        }
        visibleSessions.push(session);
    }

    if (visibleSessions.length === 0) {
        return EMPTY_SESSION_LIST_VIEW_DATA;
    }

    const listData: SessionListViewItem[] = [];

    const serverKey = normalizeSessionListKeyParts(normalizedServerScope?.serverId).serverKey;
    const grouping = resolveSessionListGroupingMode({ layoutV1: options.layoutV1 });
    sortSessionListRenderableSessionsNewestFirstIfNeeded(visibleSessions);
    pushSessionSectionToList({
        listData,
        sessions: visibleSessions,
        section: 'sessions',
        grouping,
        machines,
        serverKey,
        projectServerId: normalizedServerScope?.serverId ?? null,
        serverScopeMeta,
        sessionTargetState: options.sessionTargetState,
        workspaceRefs: options.workspaceRefs,
        workspaceRefsServerId: options.workspaceRefsServerId,
        viewerAccountId: options.viewerAccountId,
        sessionProjectKeyResolver: options.sessionProjectKeyResolver,
    });

    return listData.length === 0 ? EMPTY_SESSION_LIST_VIEW_DATA : listData;
}
