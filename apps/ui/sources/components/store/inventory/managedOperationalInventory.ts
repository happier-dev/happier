import * as React from 'react';
import type { Machine, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { useMachineListForServerSelection } from '@/sync/store/hooks';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useInstalledMachines } from '../catalog/storeInstalled';
import type { InstalledScopeAdmission } from '../catalog/storeAccountAdmission';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from '../catalog/storeKinds';

export type ManagedWatchedServiceRow = Readonly<{
    kind: 'watchedService'; key: string; scope: ServerAccountScope; machineId: string;
    native: NonNullable<MachineMetadata['serviceWatchesV1']>['watches'][number];
}>;
type NativeReason = NonNullable<InstalledScopeAdmission['failure']>
    | NonNullable<ReturnType<typeof useInstalledMachines>['failure']>
    | NonNullable<ReturnType<typeof useInstalledMachines>['snapshot']>;
type WatchedServiceResult = InstalledFamilyResult<ManagedWatchedServiceRow, NativeReason, never>;
const EMPTY_ROWS: readonly ManagedWatchedServiceRow[] = Object.freeze([]);

/** P30 records only adopted Machine watches here; Environment services stay with their App. */
export function useManagedWatchedServices(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): WatchedServiceResult {
    const held = useInstalledMachines(input, demand, admitted.scope);
    const projectRows = React.useMemo(() => {
        let previous: readonly ManagedWatchedServiceRow[] = EMPTY_ROWS;
        return (records: readonly Machine[], machines: ReturnType<typeof useInstalledMachines>['machines'], enabled: boolean): readonly ManagedWatchedServiceRow[] => {
            if (!admitted.scope || !enabled) return EMPTY_ROWS;
            const visible = new Set(machines.map(machine => machine.id));
            const byKey = new Map(previous.map(row => [row.key, row]));
            const next = records.flatMap(machine => !visible.has(machine.id)
                || machine.availability?.kind !== 'available' || machine.access && machine.access.accessState !== 'ready'
                ? [] : (machine.metadata?.serviceWatchesV1?.watches ?? []).map(native => {
                    const scope = admitted.scope!;
                    const key = serverAccountScopedResourceKey(scope, 'watched-service', machine.id, native.watchId);
                    const retained = byKey.get(key);
                    return retained?.native === native ? retained : {
                        kind: 'watchedService' as const, key, scope, machineId: machine.id, native,
                    };
                }));
            if (next.length !== previous.length || next.some((row, index) => row !== previous[index])) previous = next;
            return previous;
        };
    // The projection retains native watch identities across Machine metadata/liveness carriers.
    }, [admitted.scope]);
    const projecting = demand.presented && !input.projectKey && !held.failure;
    // Selected from the Home's list: another Machine's daemon publication that changes no watch keeps the rows.
    const rows = useMachineListForServerSelection(admitted.scope?.serverId ?? '', React.useCallback(
        (records: readonly Machine[]) => projectRows(records, held.machines, projecting), [projectRows, held.machines, projecting]));
    return React.useMemo<WatchedServiceResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        const snapshot = held.snapshot;
        if (!demand.presented || !snapshot) return { rows: EMPTY_ROWS, coverage: 'loading' };
        if (input.projectKey) return { rows: EMPTY_ROWS, coverage: 'available' };
        return { rows, coverage: snapshot.kind === 'resolved' && snapshot.settled && snapshot.observation === 'live'
            ? 'available' : { partial: snapshot } };
    }, [admitted.scope, admitted.coverage, held.failure, held.snapshot, demand.presented, input.projectKey, rows]);
}
