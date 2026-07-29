import * as React from 'react';

import { useAllMachines, useMachineListByServerId } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

export type AwaitedMachineArrivalInput = Readonly<{
    serverUrl?: string | null;
    since?: number | null;
}>;

export type AwaitedMachineArrivalSnapshot =
    | Readonly<{ status: 'waiting'; machine?: undefined; isOnline: false }>
    | Readonly<{ status: 'arrived'; machine: Machine; isOnline: true }>;

type Snapshot = Readonly<{
    scopeKey: string;
    knownIds: ReadonlySet<string>;
    wasOnlineById: ReadonlyMap<string, boolean>;
    since: number | null;
}>;

function normalizeServerScope(raw: string | null | undefined): string {
    return String(raw ?? '').trim();
}

function normalizeSince(raw: number | null | undefined): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function selectMachinesForScope(params: Readonly<{
    allMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, Machine[] | null>>;
    serverUrl: string;
}>): readonly Machine[] {
    if (!params.serverUrl) return params.allMachines;
    const scoped = params.machineListByServerId[params.serverUrl];
    if (Array.isArray(scoped)) return scoped;
    return params.allMachines;
}

function readMachineActivitySortValue(machine: Machine): number {
    const activeAt = typeof machine.activeAt === 'number' && Number.isFinite(machine.activeAt) ? machine.activeAt : 0;
    if (activeAt > 0) return activeAt;
    const updatedAt = typeof machine.updatedAt === 'number' && Number.isFinite(machine.updatedAt) ? machine.updatedAt : 0;
    if (updatedAt > 0) return updatedAt;
    return typeof machine.createdAt === 'number' && Number.isFinite(machine.createdAt) ? machine.createdAt : 0;
}

function createSnapshot(scopeKey: string, machines: readonly Machine[], since: number | null): Snapshot {
    const knownIds = new Set<string>();
    const wasOnlineById = new Map<string, boolean>();
    for (const machine of machines) {
        const activeAt = readMachineActivitySortValue(machine);
        if (since !== null && activeAt >= since) continue;
        knownIds.add(machine.id);
        wasOnlineById.set(machine.id, isMachineOnline(machine));
    }
    return { scopeKey, knownIds, wasOnlineById, since };
}

function resolveArrival(machines: readonly Machine[], snapshot: Snapshot): Machine | null {
    let arrived: Machine | null = null;
    let arrivedSortValue = Number.NEGATIVE_INFINITY;

    for (const machine of machines) {
        if (!isMachineOnline(machine)) continue;
        const sortValue = readMachineActivitySortValue(machine);
        const existedAtSnapshot = snapshot.knownIds.has(machine.id);
        const arrivedAfterSince = snapshot.since !== null && sortValue >= snapshot.since;
        const transitionedOnline = existedAtSnapshot && snapshot.wasOnlineById.get(machine.id) === false;
        if (existedAtSnapshot && !transitionedOnline && !arrivedAfterSince) continue;
        if (sortValue >= arrivedSortValue) {
            arrived = machine;
            arrivedSortValue = sortValue;
        }
    }

    return arrived;
}

export function useAwaitedMachineArrival(input: AwaitedMachineArrivalInput = {}): AwaitedMachineArrivalSnapshot {
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const serverUrl = normalizeServerScope(input.serverUrl);
    const since = normalizeSince(input.since);
    const machines = selectMachinesForScope({ allMachines, machineListByServerId, serverUrl });
    const scopeKey = `${serverUrl}\u0000${since ?? ''}`;
    const snapshotRef = React.useRef<Snapshot | null>(null);

    if (!snapshotRef.current || snapshotRef.current.scopeKey !== scopeKey) {
        snapshotRef.current = createSnapshot(scopeKey, machines, since);
    }

    const arrived = resolveArrival(machines, snapshotRef.current);
    if (!arrived) {
        return { status: 'waiting', machine: undefined, isOnline: false };
    }
    return { status: 'arrived', machine: arrived, isOnline: true };
}
