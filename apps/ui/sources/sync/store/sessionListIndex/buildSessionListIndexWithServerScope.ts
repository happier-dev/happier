import { getServerProfileById } from '../../domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
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
    layoutV1?: 'projects' | 'recent_activity';
    getProjectForSession?: (sessionId: string, serverId?: string | null) => ProjectLookupResult;
    previousIndex?: ReadonlyArray<SessionListIndexItem> | null;
    serverScope: Readonly<{
        serverId?: string | null;
        serverName?: string | null;
    }>;
}>;

export function buildSessionListIndexWithServerScope(
    params: BuildSessionListIndexWithServerScopeParams,
): SessionListIndexItem[] {
    const normalizedServerId = normalizeTrimmedString(params.serverScope.serverId) ?? '';
    const reachableSessions = applyReachableTargetsToSessionListRenderables({
        sessions: params.sessions,
        sessionRecords: params.sessionRecords,
        machineRecords: params.machineRecords,
        getProjectForSession: params.getProjectForSession && normalizedServerId
            ? (sessionId) => params.getProjectForSession?.(sessionId, normalizedServerId) ?? null
            : params.getProjectForSession,
    });

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
            layoutV1: params.layoutV1,
            sessionTargetState: params.sessionRecords && params.machineRecords
                ? {
                    sessions: params.sessionRecords,
                    sessionListRowsByServerId: normalizedServerId
                        ? { [normalizedServerId]: reachableSessions }
                        : {},
                    ordinarySessionListMembershipByServerId: normalizedServerId
                        ? { [normalizedServerId]: Object.keys(reachableSessions) }
                        : {},
                    machines: params.machineRecords,
                    machineListByServerId: normalizedServerId
                        ? { [normalizedServerId]: Object.values(params.machineRecords) }
                        : {},
                    getProjectForSession: params.getProjectForSession
                        ? (sessionId: string, serverId?: string | null) =>
                            normalizeSessionTargetProjectLookupResult(params.getProjectForSession?.(sessionId, serverId) ?? null)
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
            serverName: resolveHomeDisplayLabel(profile, snapshot.serverId),
        },
    });
}
