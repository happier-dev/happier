import * as React from 'react';
import { areSnapshotProjectionsEquivalent, retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { MACHINE_UPDATE_FACTS_CACHE_SALT } from './machineUpdateFacts';

import {
    getMachineCapabilitiesSnapshot,
    subscribeMachineCapabilitiesCacheState,
    type MachineCapabilitiesSnapshot,
} from '@/hooks/server/useMachineCapabilitiesCache';

/**
 * A detect result without the instants it was checked at: the result's own, the cache's
 * `latestVersionCheckedAt` freshness stamp, and a helper's latest-version check.
 */
function withoutCheckTimes(result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const { checkedAt: _checkedAt, data, ...rest } = result as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data === undefined ? rest : { ...rest, data };
    const { latestVersionCheckedAt: _latestVersionCheckedAt, latestVersionCheck, ...facts } = data as Record<string, unknown>;
    if (!latestVersionCheck || typeof latestVersionCheck !== 'object' || Array.isArray(latestVersionCheck)) {
        return { ...rest, data: latestVersionCheck === undefined ? facts : { ...facts, latestVersionCheck } };
    }
    const { checkedAt: _checkCheckedAt, ...checkFacts } = latestVersionCheck as Record<string, unknown>;
    return { ...rest, data: { ...facts, latestVersionCheck: checkFacts } };
}

function areSnapshotFactsEqual(previous: MachineCapabilitiesSnapshot, next: MachineCapabilitiesSnapshot): boolean {
    const project = (snapshot: MachineCapabilitiesSnapshot) => ({ ...snapshot.response,
        results: Object.fromEntries(Object.entries(snapshot.response.results).map(([id, result]) => [id, withoutCheckTimes(result)])) });
    return areSnapshotProjectionsEquivalent(project(previous), project(next));
}

/**
 * Observes the capability cache of several machines of one server at once, without fetching. The
 * server scope is explicit so a server switch re-subscribes to that server's entries.
 * `ignoreCheckTimes` is for a reader that shows no check time (the always-mounted Updates summary):
 * a re-detect that only moved those instants is not news to it.
 */
export function useMachinesCapabilitySnapshots(
    serverId: string,
    machineIds: readonly string[],
    accountId?: string | null,
    options?: Readonly<{ ignoreCheckTimes?: boolean }>,
): ReadonlyMap<string, MachineCapabilitiesSnapshot | null> {
    const ignoreCheckTimes = options?.ignoreCheckTimes === true;
    const key = [...new Set(machineIds)].join('\u0000');
    const active = useActiveServerSnapshot(!serverId);
    const effectiveServerId = serverId || active.serverId;
    const machineIdsToRead = React.useMemo(() => key ? key.split('\u0000') : [], [key]);
    const lastRef = React.useRef<ReadonlyMap<string, MachineCapabilitiesSnapshot | null>>(new Map());
    const scopeKey = JSON.stringify([effectiveServerId, accountId ?? null]);
    const lastScopeRef = React.useRef(scopeKey);
    // The cache's own objects last compared, so an unchanged read never walks its facts again.
    const comparedRef = React.useRef(new Map<string, MachineCapabilitiesSnapshot>());
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribes = machineIdsToRead.map(machineId => subscribeMachineCapabilitiesCacheState(machineId, effectiveServerId,
            MACHINE_UPDATE_FACTS_CACHE_SALT, listener, accountId));
        return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    }, [accountId, effectiveServerId, machineIdsToRead]);
    const getSnapshot = React.useCallback(() => {
        const previous = lastRef.current;
        let changed = previous.size !== machineIdsToRead.length;
        const next = new Map<string, MachineCapabilitiesSnapshot | null>();
        for (const id of machineIdsToRead) {
            const read = getMachineCapabilitiesSnapshot(id, effectiveServerId,
                MACHINE_UPDATE_FACTS_CACHE_SALT, accountId);
            const retained = lastScopeRef.current === scopeKey ? previous.get(id) ?? null : null;
            // A fresh detect that answers with the same facts is not news to the Updates summary.
            let snapshot = read === null ? retained : read;
            if (read !== null && retained !== null && read !== retained && comparedRef.current.get(id) !== read) {
                snapshot = ignoreCheckTimes ? (areSnapshotFactsEqual(retained, read) ? retained : read) : retainIfEqual(retained, read);
                comparedRef.current.set(id, read);
            } else if (read !== null && retained !== null && comparedRef.current.get(id) === read) {
                snapshot = retained;
            }
            next.set(id, snapshot);
            if (previous.get(id) !== snapshot) changed = true;
        }
        if (!changed) return previous;
        lastScopeRef.current = scopeKey;
        lastRef.current = next;
        return next;
    }, [accountId, effectiveServerId, ignoreCheckTimes, machineIdsToRead, scopeKey]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function readCapabilityResultData(snapshot: MachineCapabilitiesSnapshot | null, capabilityId: string): Record<string, unknown> | null {
    const result = snapshot?.response.results[capabilityId as keyof typeof snapshot.response.results];
    if (!result || !result.ok || !result.data || typeof result.data !== 'object') return null;
    return result.data as Record<string, unknown>;
}


/**
 * K5 — the daemon lists `cli.update.v1` among its `tool.systemTasks` kinds (presence = capability).
 * `null` while no detect of that machine is cached: unknown, not absent.
 */
export function readRemoteCliUpdateAdvertised(snapshot: MachineCapabilitiesSnapshot | null): boolean | null {
    const data = readCapabilityResultData(snapshot, 'tool.systemTasks');
    if (!data) return null;
    return Array.isArray(data.kinds) && data.kinds.includes('cli.update.v1');
}
