import { getServerProfileById } from '../../domains/server/serverProfiles';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { normalizeTrimmedString } from '../../domains/session/listing/normalizeTrimmedString';
import { applyReachableTargetsToSessionListRenderables } from '../../domains/session/listing/applyReachableTargetsToSessionListRenderables';
import { buildSessionListViewData } from '../../domains/session/listing/sessionListViewData';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { buildSessionListIndexFromViewData } from '../../domains/sessionList/sessionListIndex';

import { buildMachineDisplaysByIdFromMachineList } from './buildMachineDisplaysByIdFromMachineList';

export { buildMachineDisplaysByIdFromMachineList } from './buildMachineDisplaysByIdFromMachineList';

type ProjectLookupResult = {
    key?: {
        machineId?: string | null;
        rootPath?: string | null;
    } | null;
} | null;

type SessionTargetProjectLookupResult = {
    key?: {
        machineId?: string;
        rootPath?: string;
    };
} | null;

function normalizeSessionTargetProjectLookupResult(
    result: ProjectLookupResult,
): SessionTargetProjectLookupResult {
    if (!result?.key) {
        return null;
    }

    const machineId = normalizeTrimmedString(result.key.machineId);
    const rootPath = normalizeTrimmedString(result.key.rootPath);
    if (!machineId && !rootPath) {
        return null;
    }

    return {
        key: {
            ...(machineId ? { machineId } : {}),
            ...(rootPath ? { rootPath } : {}),
        },
    };
}

type BuildSessionListIndexWithServerScopeParams = Readonly<{
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords?: Record<string, Session>;
    machines: Record<string, MachineDisplayRenderable>;
    machineRecords?: Record<string, Machine>;
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    sectionModeV1?: 'activity' | 'single';
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
    previousIndex?: ReadonlyArray<SessionListIndexItem> | null;
    serverScope: Readonly<{
        serverId?: string | null;
        serverName?: string | null;
    }>;
}>;

export function buildSessionListIndexWithServerScope(
    params: BuildSessionListIndexWithServerScopeParams,
): SessionListIndexItem[] {
    const reachableSessions = applyReachableTargetsToSessionListRenderables({
        sessions: params.sessions,
        sessionRecords: params.sessionRecords,
        machineRecords: params.machineRecords,
        getProjectForSession: params.getProjectForSession,
    });

    const normalizedServerId = normalizeTrimmedString(params.serverScope.serverId) ?? '';
    const normalizedServerName = normalizeTrimmedString(params.serverScope.serverName);
    const serverScope = normalizedServerId
        ? {
            serverId: normalizedServerId,
            ...(normalizedServerName ? { serverName: normalizedServerName } : {}),
        }
        : undefined;

    const viewData = buildSessionListViewData(
        reachableSessions,
        params.machines,
        {
            groupInactiveSessionsByProject: params.groupInactiveSessionsByProject,
            activeGroupingV1: params.activeGroupingV1,
            inactiveGroupingV1: params.inactiveGroupingV1,
            sectionModeV1: params.sectionModeV1,
            sessionTargetState: params.sessionRecords && params.machineRecords
                ? {
                    sessions: params.sessionRecords,
                    sessionListRenderables: reachableSessions,
                    machines: params.machineRecords,
                    getProjectForSession: params.getProjectForSession
                        ? (sessionId: string) =>
                            normalizeSessionTargetProjectLookupResult(params.getProjectForSession?.(sessionId) ?? null)
                        : undefined,
                }
                : undefined,
            serverScope,
        },
    );

    return buildSessionListIndexFromViewData(viewData, params.previousIndex ?? null) ?? [];
}

export function buildActiveServerSessionListIndex(
    params: Omit<BuildSessionListIndexWithServerScopeParams, 'serverScope'>,
): SessionListIndexItem[] {
    const snapshot = getActiveServerSnapshot();
    const profile = getServerProfileById(snapshot.serverId);
    return buildSessionListIndexWithServerScope({
        ...params,
        serverScope: {
            serverId: snapshot.serverId,
            serverName: profile?.name ?? null,
        },
    });
}
