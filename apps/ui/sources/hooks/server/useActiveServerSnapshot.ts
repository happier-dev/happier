import * as React from 'react';

import {
    getActiveServerSnapshot,
    subscribeActiveServer,
    type ActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';

const emptyActiveServerSnapshot: ActiveServerSnapshot = {
    serverId: '',
    serverUrl: '',
    generation: 0,
};

let lastActiveServerSnapshot: ActiveServerSnapshot | null = null;

function areActiveServerSnapshotsEqual(left: ActiveServerSnapshot, right: ActiveServerSnapshot): boolean {
    return left.serverId === right.serverId
        && left.serverUrl === right.serverUrl
        && (left.activeShareableServerUrl ?? null) === (right.activeShareableServerUrl ?? null)
        && (left.activeLocalRelayUrl ?? null) === (right.activeLocalRelayUrl ?? null)
        && left.generation === right.generation;
}

function getActiveServerSnapshotSafe(): ActiveServerSnapshot {
    let snapshot: ActiveServerSnapshot;
    try {
        snapshot = getActiveServerSnapshot();
    } catch {
        snapshot = emptyActiveServerSnapshot;
    }
    if (lastActiveServerSnapshot && areActiveServerSnapshotsEqual(lastActiveServerSnapshot, snapshot)) {
        return lastActiveServerSnapshot;
    }
    lastActiveServerSnapshot = snapshot;
    return snapshot;
}

export function useActiveServerSnapshot(): ActiveServerSnapshot {
    return React.useSyncExternalStore(
        subscribeActiveServer,
        getActiveServerSnapshotSafe,
        getActiveServerSnapshotSafe,
    );
}
