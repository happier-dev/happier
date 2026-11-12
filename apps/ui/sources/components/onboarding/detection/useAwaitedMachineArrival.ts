import * as React from 'react';

import { useActiveMachineFacts, useMachineListByServerId } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { listServerProfiles, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachinePresence } from '@/sync/store/domains/machines';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useHasMachineForGettingStartedGuidance } from '@/components/sessions/guidance/useHasMachineForGettingStartedGuidance';

/**
 * The computers already on the list when a wait began. It is the only arrival boundary: a
 * registration or activity time is stamped by the server and can never be compared with this
 * client's clock. The owner of the wait keeps it so a remounted card resumes the same wait.
 */
export type AwaitedMachineArrivalBaseline = Readonly<{
    serverUrl: string;
    serverId?: string;
    knownIds: ReadonlySet<string>;
    wasOnlineById: ReadonlyMap<string, boolean | null>;
}>;

export type AwaitedMachineArrivalInput = Readonly<{
    serverUrl?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    baseline?: AwaitedMachineArrivalBaseline | null;
    onBaselineCaptured?: (baseline: AwaitedMachineArrivalBaseline) => void;
}>;

export type AwaitedMachineArrivalSnapshot =
    | Readonly<{ status: 'waiting'; machine?: undefined; isOnline: false }>
    | Readonly<{ status: 'arrived'; machine: Machine; isOnline: true }>;

const WAITING_SNAPSHOT: AwaitedMachineArrivalSnapshot = { status: 'waiting', machine: undefined, isOnline: false };
const EMPTY_MACHINES: readonly Machine[] = [];

function normalizeServerScope(raw: string | null | undefined): string {
    return String(raw ?? '').trim();
}

/**
 * Machine lists are keyed by server profile id; the wait is given the server's URL. Only a URL
 * that names exactly one saved profile selects a list — two profiles sharing one endpoint are
 * distinct Homes, and guessing between them would watch the wrong one.
 */
function resolveServerProfileIdForUrl(serverUrl: string): string | null {
    const key = createServerUrlComparableKey(serverUrl);
    if (!key) return null;
    const matches = listServerProfiles().filter((profile) => createServerUrlComparableKey(profile.serverUrl) === key);
    return matches.length === 1 ? matches[0]!.id : null;
}

function selectMachinesForScope(params: Readonly<{
    allMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, Machine[] | null>>;
    serverId: string | null;
}>): readonly Machine[] {
    if (!params.serverId) return params.allMachines;
    const scoped = params.machineListByServerId[params.serverId];
    if (Array.isArray(scoped)) return scoped;
    return EMPTY_MACHINES;
}

function readMachineActivitySortValue(machine: Machine): number {
    const activity = readMachineActivity(machine);
    const activeAt = typeof activity.activeAt === 'number' && Number.isFinite(activity.activeAt) ? activity.activeAt : 0;
    if (activeAt > 0) return activeAt;
    const updatedAt = typeof machine.updatedAt === 'number' && Number.isFinite(machine.updatedAt) ? machine.updatedAt : 0;
    if (updatedAt > 0) return updatedAt;
    return typeof machine.createdAt === 'number' && Number.isFinite(machine.createdAt) ? machine.createdAt : 0;
}

export function createAwaitedMachineArrivalBaseline(
    serverUrl: string,
    machines: readonly Machine[],
    serverId?: string,
    presenceById?: Readonly<Record<string, MachinePresence>>,
): AwaitedMachineArrivalBaseline {
    const knownIds = new Set<string>();
    const wasOnlineById = new Map<string, boolean | null>();
    for (const machine of machines) {
        knownIds.add(machine.id);
        wasOnlineById.set(machine.id, isMachineOnline(presenceById?.[machine.id] ?? machine));
    }
    return { serverUrl, ...(serverId ? { serverId } : {}), knownIds, wasOnlineById };
}

/**
 * Arrival is a computer that is new to this wait — absent from the list when the wait began — or
 * one that went from offline to online while waiting. A heartbeat of a computer that was already
 * there is never an arrival (another computer on the account keeps heartbeating the whole time).
 */
function resolveArrival(
    machines: readonly Machine[],
    snapshot: AwaitedMachineArrivalBaseline,
    presenceById: Readonly<Record<string, MachinePresence>> | undefined,
): Machine | null {
    let arrived: Machine | null = null;
    let arrivedSortValue = Number.NEGATIVE_INFINITY;

    for (const machine of machines) {
        if (machine.revokedAt || !isMachineOnline(presenceById?.[machine.id] ?? machine)) continue;
        const existedAtSnapshot = snapshot.knownIds.has(machine.id);
        const isNew = !existedAtSnapshot;
        const transitionedOnline = existedAtSnapshot && snapshot.wasOnlineById.get(machine.id) === false;
        if (!isNew && !transitionedOnline) continue;
        const sortValue = readMachineActivitySortValue(machine);
        if (sortValue >= arrivedSortValue) {
            arrived = machine;
            arrivedSortValue = sortValue;
        }
    }

    return arrived;
}

export function useAwaitedMachineArrival(input: AwaitedMachineArrivalInput = {}): AwaitedMachineArrivalSnapshot {
    const enabled = input.enabled !== false;
    const allMachines = useActiveMachineFacts(enabled);
    const machineListByServerId = useMachineListByServerId(true, 'facts', enabled);
    const serverUrl = normalizeServerScope(input.serverUrl);
    // The wait starts from the loaded list: a snapshot of a list still loading would make every
    // existing computer look new the moment it loads.
    const activeMachineListKnown = useHasMachineForGettingStartedGuidance(enabled) !== null;
    const explicitId = normalizeServerScope(input.serverId);
    const serverId = React.useMemo(() => explicitId || resolveServerProfileIdForUrl(serverUrl), [explicitId, serverUrl]);
    const presenceScopeId = serverId ? resolveServerProfileScopeIdForIdentifier(serverId) : null;
    // Retained presence rows read current activity through the Machine activity owner.
    const presenceById = storage(state => !enabled ? undefined : presenceScopeId
        ? state.machinePresenceByServerId[presenceScopeId]
        : !serverUrl ? state.machinePresenceById : undefined);
    const machineListKnown = serverId !== null ? Array.isArray(machineListByServerId[serverId]) : !serverUrl && activeMachineListKnown;
    // A named but unresolved/loading Home never borrows the active Home's computers.
    const machines = serverId || !serverUrl ? selectMachinesForScope({ allMachines, machineListByServerId, serverId }) : EMPTY_MACHINES;
    const scope = serverId ?? serverUrl;
    const snapshotRef = React.useRef<Readonly<{ scope: string; baseline: AwaitedMachineArrivalBaseline }> | null>(null);
    const provided = input.baseline;
    const providedMatches = provided && (serverId && provided.serverId
        ? provided.serverId === serverId : provided.serverUrl === serverUrl);
    if (!enabled) {
        snapshotRef.current = null;
    } else if (providedMatches && provided) {
        // A new externally supplied baseline also starts a new wait while mounted.
        snapshotRef.current = { scope, baseline: provided };
    } else if (!snapshotRef.current || snapshotRef.current.scope !== scope) {
        snapshotRef.current = machineListKnown ? { scope, baseline: createAwaitedMachineArrivalBaseline(serverUrl, machines, serverId ?? undefined, presenceById) } : null;
    }
    const snapshot = enabled && snapshotRef.current?.scope === scope ? snapshotRef.current.baseline : null;
    const persistedBaseline = input.baseline ?? null;
    const onBaselineCaptured = input.onBaselineCaptured;
    React.useEffect(() => {
        if (snapshot && snapshot !== persistedBaseline) onBaselineCaptured?.(snapshot);
    }, [onBaselineCaptured, persistedBaseline, snapshot]);

    const readMachines = React.useCallback(() => snapshot ? machines : EMPTY_MACHINES, [machines, snapshot]);
    const readArrival = React.useCallback(() => snapshot ? resolveArrival(machines, snapshot, presenceById) : null,
        [machines, snapshot, presenceById]);
    const targets = React.useMemo(() => snapshot && (serverId || !serverUrl) ? [{ serverId }] : [],
        [snapshot, serverId, serverUrl]);
    const arrived = useMachinePresenceSnapshot(readMachines, readArrival, targets);
    // Equal answers keep one identity so a change in an unrelated Home's list does not
    // re-render the wait's consumers.
    return React.useMemo<AwaitedMachineArrivalSnapshot>(
        () => arrived ? { status: 'arrived', machine: arrived, isOnline: true } : WAITING_SNAPSHOT,
        [arrived],
    );
}
