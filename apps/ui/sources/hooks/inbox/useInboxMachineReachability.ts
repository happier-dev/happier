import * as React from 'react';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useMachineRebootActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import type { SessionMachineReachability } from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { readMachineInventoryRowReadiness, resolveServerScopedMachines, selectMachineInventoryRowsById } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

export type InboxMachineReachabilityEntry = Readonly<{
    key: string;
    serverId: string;
    accountId: string;
    machineId: string;
    installationId: string | null;
    view: 'updates';
    name: string | null;
    reachability: SessionMachineReachability;
    lastSeenAt: number | null;
    expectedDuring: 'reboot' | null;
    /** Operation custody stays visible independently of the presence explanation. */
    operation: ActionOperationProjection;
}>;

const EMPTY_ENTRIES: readonly InboxMachineReachabilityEntry[] = Object.freeze([]);

/** Readable reboot subjects; presence, grace and settlement retain their existing owners. */
export function useInboxMachineReachability(lifetime: ServerAccountScopeLifetime | null): readonly InboxMachineReachabilityEntry[] {
    const store = getStorage();
    const subscribeCurrent = React.useCallback((notify: () => void) => {
        const retirement = lifetime?.onRetire(notify);
        return () => retirement?.dispose();
    }, [lifetime]);
    const readCurrent = React.useCallback(() => lifetime?.isCurrent() === true, [lifetime]);
    const current = React.useSyncExternalStore(subscribeCurrent, readCurrent, readCurrent);
    const scope = current ? lifetime?.scope ?? null : null;
    const reboots = useMachineRebootActionOperations(scope);
    const operations = React.useMemo(() => {
        const latest = new Map<string, ActionOperationProjection>();
        if (scope) for (const operation of reboots) {
            const snapshot = operation.snapshot;
            const previous = latest.get(snapshot.scope.machineId);
            if (!previous || previous.snapshot.createdAt < snapshot.createdAt) latest.set(snapshot.scope.machineId, operation);
        }
        return [...latest.values()];
    }, [scope, reboots]);
    const machineIds = React.useMemo(() => operations.map(operation => operation.snapshot.scope.machineId), [operations]);
    const readMachines = React.useCallback(() => {
        if (!scope || machineIds.length === 0) return [];
        const state = store.getState();
        const inventory = resolveServerScopedMachines({ serverId: scope.serverId,
            activeServerId: getActiveServerSnapshot().serverId,
            get activeMachines() { return Object.values(state.machines); },
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        });
        return selectMachineInventoryRowsById(inventory, machineIds);
    }, [scope, store, machineIds]);
    const cached = React.useRef(EMPTY_ENTRIES);
    const readSnapshot = React.useCallback((nowMs: number): readonly InboxMachineReachabilityEntry[] => {
        if (!scope || !lifetime?.isCurrent()) return EMPTY_ENTRIES;
        const machines = readMachines();
        const next = operations.map((operation, index): InboxMachineReachabilityEntry => {
            const machine = machines[index];
            const snapshot = operation.snapshot;
            const subject = snapshot.domainRef;
            const installationId = machine?.installationId ?? null;
            const name = machine ? getMachineDisplayName(machine).trim() || null : null;
            const reachability = machine ? resolveMachineReachability(scope, machine, nowMs) : 'unknown';
            const activeAt = machine ? readMachineActivity(machine).activeAt : null;
            const lastSeenAt = reachability === 'unreachable' && typeof activeAt === 'number' && activeAt > 0 ? activeAt : null;
            // Transport loss preserves readable dispatch. Explicit owner uncertainty
            // or a withdrawn receipt cannot authorize an expected interruption.
            const expectedDuring = reachability === 'unreachable' && machine
                && readMachineInventoryRowReadiness(machine) === 'available' && !machine.revokedAt
                && snapshot.state === 'running' && !snapshot.observation && !operation.isUnavailableProjection
                && subject?.kind === 'machineReboot' && subject.basis?.dispatchStarted === true
                && areServerProfileIdentifiersEquivalent(subject.serverId, scope.serverId)
                && subject.machineId === snapshot.scope.machineId && subject.installationId === installationId ? 'reboot' : null;
            const previous = cached.current[index];
            if (previous && previous.operation === operation && previous.serverId === scope.serverId
                && previous.accountId === scope.accountId && previous.installationId === installationId
                && previous.name === name && previous.reachability === reachability && previous.lastSeenAt === lastSeenAt
                && previous.expectedDuring === expectedDuring) return previous;
            return Object.freeze({ key: JSON.stringify([scope.serverId, scope.accountId, snapshot.scope.machineId]),
                serverId: scope.serverId, accountId: scope.accountId, machineId: snapshot.scope.machineId,
                installationId, view: 'updates', name, reachability, lastSeenAt, expectedDuring, operation });
        });
        if (next.length !== cached.current.length || next.some((entry, index) => entry !== cached.current[index])) cached.current = Object.freeze(next);
        return cached.current;
    }, [scope, lifetime, readMachines, operations]);
    const targets = React.useMemo(() => [{ serverId: scope?.serverId, machineIds }], [scope, machineIds]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
}
