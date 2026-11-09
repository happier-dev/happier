import { z } from 'zod/mini';
import { MachineAdministrationTargetV1Schema, type MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { serverAccountScopeKeySuffix, serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

// Navigation observations share the device KV lifecycle and keyed subscriptions;
// they are neither preferences nor Account-synchronized policy.
export const machineAdministrationTargetObservationsState = createPersistentUiState('machine-target-observations-v1',
    value => MachineAdministrationTargetV1Schema.parse(value));

export const MachinesRailSeenSchema = z.object({
    look: z.catch(z.record(z.string(), z.array(z.string())), {}),
    guardSeenAt: z.catch(z.number(), 0),
});
export type MachinesRailSeen = z.infer<typeof MachinesRailSeenSchema>;
export const EMPTY_MACHINES_RAIL_SEEN: MachinesRailSeen = { look: {}, guardSeenAt: 0 };
export const machinesRailSeenState = createPersistentUiState('machines-rail-seen-v1',
    value => z.catch(MachinesRailSeenSchema, EMPTY_MACHINES_RAIL_SEEN).parse(value));

export function readMachineAdministrationTargetObservation(scope: ServerAccountScope | null, key: string): MachineAdministrationTargetV1 | null {
    return scope ? machineAdministrationTargetObservationsState.read(serverAccountScopedResourceKey(scope, key)) ?? null : null;
}

export function useMachineAdministrationTargetObservation(scope: ServerAccountScope | null, key: string): MachineAdministrationTargetV1 | null {
    return usePersistentUiStateValue(machineAdministrationTargetObservationsState, scope ? serverAccountScopedResourceKey(scope, key) : null) ?? null;
}

export function rememberMachineAdministrationTargetObservation(scope: ServerAccountScope, key: string, target: MachineAdministrationTargetV1): void {
    try { machineAdministrationTargetObservationsState.set(serverAccountScopedResourceKey(scope, key), target); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[machines] Last-used target could not be persisted.');
    }
}

export function clearMachineAdministrationTargetObservation(scope: ServerAccountScope, key: string): void {
    try { machineAdministrationTargetObservationsState.remove(serverAccountScopedResourceKey(scope, key)); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[machines] Automatic target could not be cleared.');
    }
}

export function useMachinesRailSeen(scope: ServerAccountScope | null): MachinesRailSeen {
    return usePersistentUiStateValue(machinesRailSeenState, scope ? serverAccountScopeKeySuffix(scope) : null) ?? EMPTY_MACHINES_RAIL_SEEN;
}

export function writeMachinesRailSeen(scope: ServerAccountScope | null, seen: MachinesRailSeen): void {
    if (!scope) return;
    try { machinesRailSeenState.set(serverAccountScopeKeySuffix(scope), seen); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[machines] Seen attention could not be persisted.');
    }
}
