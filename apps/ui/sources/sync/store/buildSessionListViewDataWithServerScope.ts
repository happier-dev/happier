import { getServerProfileById } from '../domains/server/serverProfiles';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { WorkspacePathDisplayModeV1 } from '../domains/session/listing/sessionWorkspacePresentation';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import { resolveSessionDisplayTarget } from '../domains/machines/identity/resolveSessionMachineTargets';
import { resolveSessionMachineId } from '../domains/session/directSessions/resolveSessionMachineId';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../domains/state/storageTypes';

type ProjectLookupResult = {
    key?: {
        machineId?: string | null;
        path?: string | null;
    } | null;
} | null;

type ReachableSessionProjectionParams = Readonly<{
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords?: Record<string, Session>;
    machines: Record<string, MachineDisplayRenderable>;
    machineRecords?: Record<string, Machine>;
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function applyReachableTargetsToSessionListRenderables(
    params: ReachableSessionProjectionParams,
): Record<string, SessionListRenderableSession> {
    const sessionRecords = params.sessionRecords;
    const machineRecords = params.machineRecords;
    if (!sessionRecords || !machineRecords) {
        return params.sessions;
    }

    const machines = Object.values(machineRecords);
    if (machines.length === 0) {
        return params.sessions;
    }

    let nextSessions: Record<string, SessionListRenderableSession> | null = null;
    for (const sessionId in params.sessions) {
        if (!Object.prototype.hasOwnProperty.call(params.sessions, sessionId)) continue;
        const session = params.sessions[sessionId];
        const sessionRecord = sessionRecords[sessionId];
        if (!sessionRecord) continue;

        const metadata = sessionRecord.metadata ?? null;
        const project = params.getProjectForSession?.(sessionId) ?? null;
        const target = resolveSessionDisplayTarget({
            sessionActive: sessionRecord.active === true,
            sessionMachineId: resolveSessionMachineId(metadata),
            sessionPath: normalizeNonEmptyString(metadata?.path),
            projectMachineId: normalizeNonEmptyString(project?.key?.machineId),
            projectPath: normalizeNonEmptyString(project?.key?.path),
            machines,
        });

        if (!target || !session.metadata) continue;

        const targetMachine = machineRecords[target.machineId];
        const nextHomeDir = normalizeNonEmptyString(targetMachine?.metadata?.homeDir) ?? session.metadata.homeDir ?? null;
        const nextHost = normalizeNonEmptyString(targetMachine?.metadata?.host) ?? session.metadata.host ?? null;

        const metadataChanged =
            target.machineId !== session.metadata.machineId
            || target.basePath !== session.metadata.path
            || nextHomeDir !== (session.metadata.homeDir ?? null)
            || nextHost !== (session.metadata.host ?? null);

        if (!metadataChanged) continue;

        nextSessions ??= { ...params.sessions };
        nextSessions[sessionId] = {
            ...session,
            metadata: {
                ...session.metadata,
                machineId: target.machineId,
                path: target.basePath,
                homeDir: nextHomeDir,
                host: nextHost,
            },
        };
    }

    return nextSessions ?? params.sessions;
}

export function buildSessionListViewDataWithServerScope(params: {
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords?: Record<string, Session>;
    machines: Record<string, MachineDisplayRenderable>;
    machineRecords?: Record<string, Machine>;
    serverId?: string | null;
    groupInactiveSessionsByProject: boolean;
    groupGitWorktreesByRepository?: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    sectionModeV1?: 'activity' | 'single';
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}): SessionListViewItem[] {
    const snapshot = getActiveServerSnapshot();
    const serverId = normalizeNonEmptyString(params.serverId) ?? snapshot.serverId;
    const profile = getServerProfileById(serverId);
    const reachableSessions = applyReachableTargetsToSessionListRenderables({
        sessions: params.sessions,
        sessionRecords: params.sessionRecords,
        machines: params.machines,
        machineRecords: params.machineRecords,
        getProjectForSession: params.getProjectForSession,
    });

    return buildSessionListViewData(
        reachableSessions,
        params.machines,
        {
            groupInactiveSessionsByProject: params.groupInactiveSessionsByProject,
            groupGitWorktreesByRepository: params.groupGitWorktreesByRepository,
            activeGroupingV1: params.activeGroupingV1,
            inactiveGroupingV1: params.inactiveGroupingV1,
            sectionModeV1: params.sectionModeV1,
            workspacePathDisplayModeV1: params.workspacePathDisplayModeV1,
            serverScope: {
                serverId,
                serverName: profile?.name,
            },
        }
    );
}
