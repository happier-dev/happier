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
const noopSubscribe = () => () => {};
const getEmptyActiveServerSnapshot = () => emptyActiveServerSnapshot;

let lastActiveServerSnapshot: ActiveServerSnapshot | null = null;

function areActiveServerSnapshotsEqual(left: ActiveServerSnapshot, right: ActiveServerSnapshot): boolean {
    return left.serverId === right.serverId
        && left.serverUrl === right.serverUrl
        && (left.activeShareableServerUrl ?? null) === (right.activeShareableServerUrl ?? null)
        && (left.activeShareableServerUrlValidatedAgainstServerUrl ?? null) === (right.activeShareableServerUrlValidatedAgainstServerUrl ?? null)
        && (left.activeLocalRelayUrl ?? null) === (right.activeLocalRelayUrl ?? null)
        && (left.isSelectionExplicit ?? null) === (right.isSelectionExplicit ?? null)
        && left.generation === right.generation;
}

function getActiveServerSnapshotSafe(): ActiveServerSnapshot {
    let snapshot: ActiveServerSnapshot;
    try {
        snapshot = getActiveServerSnapshot();
    } catch {
        snapshot = emptyActiveServerSnapshot;
    }
    const nextSnapshot = { ...snapshot };
    if (lastActiveServerSnapshot && areActiveServerSnapshotsEqual(lastActiveServerSnapshot, nextSnapshot)) {
        return lastActiveServerSnapshot;
    }
    lastActiveServerSnapshot = nextSnapshot;
    return nextSnapshot;
}

export function useActiveServerSnapshot(enabled = true): ActiveServerSnapshot {
    return React.useSyncExternalStore(
        enabled ? subscribeActiveServer : noopSubscribe,
        enabled ? getActiveServerSnapshotSafe : getEmptyActiveServerSnapshot,
        enabled ? getActiveServerSnapshotSafe : getEmptyActiveServerSnapshot,
    );
}
