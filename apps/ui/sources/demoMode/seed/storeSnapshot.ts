import type { Settings } from '@/sync/domains/settings/settings';
import type { StorageState } from '@/sync/store/types';

const DEMO_SETTING_KEYS = [
    'featureToggles',
    'hideInactiveSessions',
    'sessionListDensity',
    'sessionListSectionModeV1',
    'sessionListAttentionPromotionModeV1',
    'sessionListWorkingPlacementModeV1',
    'serverSelectionActiveTargetKind',
    'serverSelectionActiveTargetId',
] as const satisfies readonly (keyof Settings)[];

export type DemoSettingKey = typeof DEMO_SETTING_KEYS[number];

export type StoreSnapshot = Readonly<{
    sessions: StorageState['sessions'];
    sessionListRenderables: StorageState['sessionListRenderables'];
    sessionListIndexByServerId: StorageState['sessionListIndexByServerId'];
    machines: StorageState['machines'];
    machineDisplayById: StorageState['machineDisplayById'];
    machineListByServerId: StorageState['machineListByServerId'];
    sessionMessages: StorageState['sessionMessages'];
    sessionPending: StorageState['sessionPending'];
    reviewCommentsDraftsBySessionId: StorageState['reviewCommentsDraftsBySessionId'];
    settings: Pick<Settings, DemoSettingKey>;
}>;

function cloneData<T>(value: T): T {
    return structuredClone(value);
}

export function takeStoreSnapshot(state: StorageState): StoreSnapshot {
    return {
        sessions: cloneData(state.sessions),
        sessionListRenderables: cloneData(state.sessionListRenderables),
        sessionListIndexByServerId: cloneData(state.sessionListIndexByServerId),
        machines: cloneData(state.machines),
        machineDisplayById: cloneData(state.machineDisplayById),
        machineListByServerId: cloneData(state.machineListByServerId),
        sessionMessages: cloneData(state.sessionMessages),
        sessionPending: cloneData(state.sessionPending),
        reviewCommentsDraftsBySessionId: cloneData(state.reviewCommentsDraftsBySessionId),
        settings: {
            featureToggles: cloneData(state.settings.featureToggles),
            hideInactiveSessions: state.settings.hideInactiveSessions,
            sessionListDensity: state.settings.sessionListDensity,
            sessionListSectionModeV1: state.settings.sessionListSectionModeV1,
            sessionListAttentionPromotionModeV1: state.settings.sessionListAttentionPromotionModeV1,
            sessionListWorkingPlacementModeV1: state.settings.sessionListWorkingPlacementModeV1,
            serverSelectionActiveTargetKind: state.settings.serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId: state.settings.serverSelectionActiveTargetId,
        },
    };
}

function restoreRecordByOwnedIds<T>(
    current: Readonly<Record<string, T>>,
    snapshot: Readonly<Record<string, T>>,
    ownedIds: ReadonlySet<string>,
): Record<string, T> {
    const next: Record<string, T> = { ...current };
    for (const id of ownedIds) {
        delete next[id];
    }
    for (const [id, value] of Object.entries(snapshot)) {
        if (ownedIds.has(id)) {
            next[id] = value;
        }
    }
    return next;
}

function restoreSessionListIndexes(
    current: StorageState['sessionListIndexByServerId'],
    snapshot: StorageState['sessionListIndexByServerId'],
    ownedSessionIds: ReadonlySet<string>,
): StorageState['sessionListIndexByServerId'] {
    const next: Record<string, StorageState['sessionListIndexByServerId'][string]> = { ...current };
    for (const [serverId, items] of Object.entries(current)) {
        if (!Array.isArray(items)) continue;
        const filtered = items.filter((item) => (
            item.type !== 'session'
                ? !ownedSessionIds.has(item.seedSessionId ?? '')
                : !ownedSessionIds.has(item.sessionId)
        ));
        if (
            !(serverId in snapshot)
            && !filtered.some((item) => item.type === 'session')
        ) {
            delete next[serverId];
            continue;
        }
        next[serverId] = filtered;
    }
    for (const [serverId, items] of Object.entries(snapshot)) {
        next[serverId] = items;
    }
    return next;
}

function restoreMachineListIndexes(
    current: StorageState['machineListByServerId'],
    snapshot: StorageState['machineListByServerId'],
    ownedMachineIds: ReadonlySet<string>,
): StorageState['machineListByServerId'] {
    const next: StorageState['machineListByServerId'] = { ...current };
    for (const [serverId, machines] of Object.entries(current)) {
        if (!Array.isArray(machines)) continue;
        const filtered = machines.filter((machine) => !ownedMachineIds.has(machine.id));
        if (filtered.length === 0 && !(serverId in snapshot)) {
            delete next[serverId];
            continue;
        }
        next[serverId] = filtered;
    }
    for (const [serverId, machines] of Object.entries(snapshot)) {
        if (serverId in next) continue;
        next[serverId] = machines;
    }
    return next;
}

export function buildStoreStateAfterDemoRestore(params: Readonly<{
    current: StorageState;
    snapshot: StoreSnapshot;
    sessionIds: ReadonlySet<string>;
    machineIds: ReadonlySet<string>;
}>): Partial<StorageState> {
    return {
        sessions: restoreRecordByOwnedIds(params.current.sessions, params.snapshot.sessions, params.sessionIds),
        sessionListRenderables: restoreRecordByOwnedIds(
            params.current.sessionListRenderables,
            params.snapshot.sessionListRenderables,
            params.sessionIds,
        ),
        sessionListIndexByServerId: restoreSessionListIndexes(
            params.current.sessionListIndexByServerId,
            params.snapshot.sessionListIndexByServerId,
            params.sessionIds,
        ),
        machines: restoreRecordByOwnedIds(params.current.machines, params.snapshot.machines, params.machineIds),
        machineDisplayById: restoreRecordByOwnedIds(
            params.current.machineDisplayById,
            params.snapshot.machineDisplayById,
            params.machineIds,
        ),
        machineListByServerId: restoreMachineListIndexes(
            params.current.machineListByServerId,
            params.snapshot.machineListByServerId,
            params.machineIds,
        ),
        sessionMessages: restoreRecordByOwnedIds(
            params.current.sessionMessages,
            params.snapshot.sessionMessages,
            params.sessionIds,
        ),
        sessionPending: restoreRecordByOwnedIds(
            params.current.sessionPending,
            params.snapshot.sessionPending,
            params.sessionIds,
        ),
        reviewCommentsDraftsBySessionId: restoreRecordByOwnedIds(
            params.current.reviewCommentsDraftsBySessionId,
            params.snapshot.reviewCommentsDraftsBySessionId,
            params.sessionIds,
        ),
        settings: {
            ...params.current.settings,
            ...params.snapshot.settings,
        },
    };
}
