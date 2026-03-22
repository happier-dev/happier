import { getServerProfileById } from '../domains/server/serverProfiles';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import { resolveSessionMachineRpcTarget } from '../domains/session/resolveSessionReachableMachineId';
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

    const peerSessions = Object.values(sessionRecords).map((session) => {
        const metadata = session.metadata ?? null;
        const project = params.getProjectForSession?.(session.id) ?? null;
        return {
            id: session.id,
            active: session.active,
            updatedAt: session.updatedAt,
            machineId: normalizeNonEmptyString(metadata?.machineId),
            hostHint: normalizeNonEmptyString(metadata?.host),
            path: normalizeNonEmptyString(metadata?.path),
            homeDir: normalizeNonEmptyString(metadata?.homeDir),
            projectMachineId: normalizeNonEmptyString(project?.key?.machineId),
            projectPath: normalizeNonEmptyString(project?.key?.path),
        };
    });

    let changed = false;
    const nextSessions = Object.fromEntries(
        Object.entries(params.sessions).map(([sessionId, session]) => {
            const sessionRecord = sessionRecords[sessionId];
            if (!sessionRecord) {
                return [sessionId, session];
            }

            const metadata = sessionRecord.metadata ?? null;
            const project = params.getProjectForSession?.(sessionId) ?? null;
            const target = resolveSessionMachineRpcTarget({
                sessionId,
                sessionMachineId: normalizeNonEmptyString(metadata?.machineId),
                sessionHostHint: normalizeNonEmptyString(metadata?.host),
                sessionPath: normalizeNonEmptyString(metadata?.path),
                sessionHomeDir: normalizeNonEmptyString(metadata?.homeDir),
                projectMachineId: normalizeNonEmptyString(project?.key?.machineId),
                projectPath: normalizeNonEmptyString(project?.key?.path),
                machines,
                peerSessions,
            });

            if (!target || !session.metadata) {
                return [sessionId, session];
            }

            const targetMachine = machineRecords[target.machineId];
            const nextMetadata = {
                ...session.metadata,
                machineId: target.machineId,
                path: target.basePath,
                homeDir: normalizeNonEmptyString(targetMachine?.metadata?.homeDir) ?? session.metadata.homeDir ?? null,
                host: normalizeNonEmptyString(targetMachine?.metadata?.host) ?? session.metadata.host ?? null,
            };

            const metadataChanged =
                nextMetadata.machineId !== session.metadata.machineId
                || nextMetadata.path !== session.metadata.path
                || (nextMetadata.homeDir ?? null) !== (session.metadata.homeDir ?? null)
                || (nextMetadata.host ?? null) !== (session.metadata.host ?? null);

            if (!metadataChanged) {
                return [sessionId, session];
            }

            changed = true;
            return [
                sessionId,
                {
                    ...session,
                    metadata: nextMetadata,
                },
            ];
        }),
    ) as Record<string, SessionListRenderableSession>;

    return changed ? nextSessions : params.sessions;
}

export function buildSessionListViewDataWithServerScope(params: {
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords?: Record<string, Session>;
    machines: Record<string, MachineDisplayRenderable>;
    machineRecords?: Record<string, Machine>;
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}): SessionListViewItem[] {
    const snapshot = getActiveServerSnapshot();
    const profile = getServerProfileById(snapshot.serverId);
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
            activeGroupingV1: params.activeGroupingV1,
            inactiveGroupingV1: params.inactiveGroupingV1,
            serverScope: {
                serverId: snapshot.serverId,
                serverName: profile?.name,
            },
        }
    );
}
