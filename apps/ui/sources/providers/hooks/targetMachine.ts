import * as React from 'react';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import {
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1,
} from '@/sync/domains/machines/administration/selectionPreferences';
import {
    isMachineAdministrationCandidateSelectable,
    machineAdministrationTargetsEqual,
} from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';

/**
 * One machine a Provider route may address, carrying the full Administration
 * identity rather than a bare machine id. Two server profiles can expose the
 * same machine id, so `target` is what identifies the row and `serverId` is the
 * device-local routing id every request for that row must use.
 */
export type ProviderSettingsMachineRowV1 = Readonly<{
    target: MachineAdministrationTargetV1;
    serverId: string;
    displayName: string;
    /** Only a live, online candidate can be serviced by a daemon request. */
    online: boolean;
}>;

export type ProviderSettingsTargetV1 = Readonly<{
    /** Canonical Machine Administration controller, for the shared selector. */
    selection: MachineAdministrationTargetSelectionV1;
    /** Exact machine the user selected, once it currently resolves. */
    machineId: string | null;
    serverId: string | null;
    /**
     * Every Administration candidate observed under the selected target's
     * server identity. A Provider connection is Account-scoped to one server,
     * so a candidate from another server profile is never a peer of it and is
     * excluded here rather than collapsed onto the selected server's routing.
     */
    machineRows: readonly ProviderSettingsMachineRowV1[];
    /**
     * Re-resolves the selected target immediately before an effect, so a
     * rendered snapshot can never authorize work against a different machine.
     * Returns `null` once the selection has moved away from the target the
     * calling render was built for.
     */
    resolveCurrentTarget: () => Readonly<{ machineId: string; serverId: string }> | null;
}>;

const NO_MACHINE_ROWS: readonly ProviderSettingsMachineRowV1[] = Object.freeze([]);

/**
 * Stable row key for a Provider machine. Machine ids are only unique within one
 * server identity, so every projection, request map, and rendered row keys on
 * the whole tuple.
 */
export function providerSettingsMachineRowKey(target: MachineAdministrationTargetV1): string {
    return `${target.serverIdentityId}\u0000${target.machineId}`;
}

/**
 * One Provider Settings target owner. Every Provider route reads the same
 * Account-portable Machine Administration selection, so index, detail,
 * authoring, model management, writes, and refresh all address the exact
 * machine the user chose rather than each screen re-deriving its own.
 */
export function useProviderSettingsTarget(): ProviderSettingsTargetV1 {
    const selection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.providers,
    );
    const executionTarget = React.useMemo(() => {
        const selectedTarget = selection.selectedTarget;
        const resolvedTarget = selection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [selection]);
    const selectedServerIdentityId = executionTarget?.target.serverIdentityId ?? null;
    const pickerRows = selection.pickerRows;
    const machineRows = React.useMemo<readonly ProviderSettingsMachineRowV1[]>(() => {
        if (!selectedServerIdentityId) return NO_MACHINE_ROWS;
        const rows = (pickerRows ?? [])
            .filter((row) => row.candidate.target.serverIdentityId === selectedServerIdentityId)
            .map((row) => Object.freeze({
                target: row.candidate.target,
                serverId: row.serverId,
                displayName: row.candidate.displayName,
                online: isMachineAdministrationCandidateSelectable(row.candidate),
            }));
        return rows.length === 0 ? NO_MACHINE_ROWS : Object.freeze(rows);
    }, [pickerRows, selectedServerIdentityId]);
    // Identity, not object identity: the candidate projection rebuilds on every
    // machine heartbeat, and a resolver that churned with it would restart the
    // mutation scope — discarding the result of a write already in flight.
    const expectedMachineId = executionTarget?.machine.id ?? null;
    const resolveExecutionTarget = selection.resolveExecutionTarget;
    const resolveCurrentTarget = React.useCallback(() => {
        const resolvedTarget = resolveExecutionTarget();
        if (
            !selectedServerIdentityId
            || !expectedMachineId
            || !resolvedTarget
            || resolvedTarget.target.serverIdentityId !== selectedServerIdentityId
            || resolvedTarget.target.machineId !== expectedMachineId
        ) {
            return null;
        }
        return {
            machineId: resolvedTarget.machine.id,
            serverId: resolvedTarget.serverId,
        };
    }, [expectedMachineId, resolveExecutionTarget, selectedServerIdentityId]);

    return React.useMemo(() => ({
        selection,
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        machineRows,
        resolveCurrentTarget,
    }), [executionTarget, machineRows, resolveCurrentTarget, selection]);
}
