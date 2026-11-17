import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import {
    resolveMachineAdministrationTargetState,
    type MachineAdministrationCandidateAvailabilityV1,
    type MachineAdministrationCandidateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import type {
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';

/*
 * Static Machine Administration selections built from a plain machine list. Free of the test
 * runner so `/dev` specimens can hand the real selector a settled selection; the hook mock in
 * `mocks/machineAdministrationTargetSelection.ts` builds its live rows from the same helpers.
 */

/**
 * One machine the mocked Account-portable inventory can offer. `availability`
 * drives both selectability and the presented target state, so a suite can
 * exercise an offline or revoked selection without rebuilding the controller.
 */
export type MachineAdministrationTargetSelectionMockMachine = Readonly<{
    machineId: string;
    displayName?: string;
    homeDir?: string;
    /** Exact daemon lifetime used by operation-currentness and cache fences. */
    daemonStateVersion?: number;
    availability?: MachineAdministrationCandidateAvailabilityV1;
    observation?: 'live' | 'stale';
    /**
     * Server identity this machine was observed under. Defaults to the mock's
     * own identity, so a suite only names it to reproduce the Account-portable
     * case where two server profiles expose the same machine id.
     */
    serverIdentityId?: string;
    /** Device-local routing id of that identity's profile. */
    serverId?: string;
    /** Presented server label for that identity's profile. */
    serverLabel?: string;
}>;

export type MachineAdministrationTargetSelectionMockOptions = Readonly<{
    serverId?: string;
    serverIdentityId?: string;
    serverLabel?: string;
    machines?: readonly MachineAdministrationTargetSelectionMockMachine[];
    selectedMachineId?: string | null;
    /** Server identity of the selected target; defaults to the mock's identity. */
    selectedServerIdentityId?: string;
}>;

export type ResolvedExecutionTarget = ReturnType<MachineAdministrationTargetSelectionV1['resolveExecutionTarget']>;

export type MockInventoryRow = MachineAdministrationTargetSelectionV1['pickerRows'][number];

/**
 * Builds the canonical all-profile inventory rows. Each row keeps the full
 * `{ serverIdentityId, machineId }` tuple together with the device-local
 * routing id it was observed from, exactly like the real snapshot projection,
 * so a suite can reproduce one machine id claimed by two server profiles.
 */
export function buildInventoryRows(input: Readonly<{
    serverId: string;
    serverIdentityId: string;
    serverLabel: string;
    machines: readonly MachineAdministrationTargetSelectionMockMachine[];
}>): readonly MockInventoryRow[] {
    return input.machines.map((machine) => {
        const rowServerIdentityId = machine.serverIdentityId ?? input.serverIdentityId;
        const rowServerId = machine.serverId
            ?? (rowServerIdentityId === input.serverIdentityId ? input.serverId : rowServerIdentityId);
        const rowServerLabel = machine.serverLabel ?? input.serverLabel;
        const candidate: MachineAdministrationCandidateV1 = {
            target: { serverIdentityId: rowServerIdentityId, machineId: machine.machineId },
            displayName: machine.displayName ?? machine.machineId,
            serverLabel: rowServerLabel,
            availability: machine.availability ?? 'online',
            observation: machine.observation ?? 'live',
            observedAt: 1,
        };
        return {
            candidate,
            serverId: rowServerId,
            serverName: rowServerLabel,
            machine: {
                id: machine.machineId,
                daemonStateVersion: machine.daemonStateVersion ?? 1,
                metadata: {
                    ...(machine.displayName ? { displayName: machine.displayName } : {}),
                    ...(machine.homeDir ? { homeDir: machine.homeDir } : {}),
                },
            },
        } as unknown as MockInventoryRow;
    });
}

export function resolveExecutionTargetFrom(input: Readonly<{
    rows: readonly MockInventoryRow[];
    target: MachineAdministrationTargetV1 | null;
}>): ResolvedExecutionTarget {
    if (!input.target) return null;
    const row = input.rows.find((entry) => (
        entry.candidate.target.serverIdentityId === input.target!.serverIdentityId
        && entry.candidate.target.machineId === input.target!.machineId
    ));
    const candidate = row?.candidate;
    if (!row || !candidate || candidate.availability !== 'online' || candidate.observation !== 'live') return null;
    return {
        kind: 'resolved',
        target: candidate.target,
        serverId: row.serverId,
        profile: { id: row.serverId, serverIdentityId: candidate.target.serverIdentityId },
        machine: row.machine,
    } as unknown as NonNullable<ResolvedExecutionTarget>;
}

/**
 * Static selection snapshot for view-level tests that render a component
 * taking the canonical selection as a prop rather than reading the owner hook.
 */
export function createMachineAdministrationTargetSelectionFixture(
    options: MachineAdministrationTargetSelectionMockOptions = {},
): MachineAdministrationTargetSelectionV1 {
    const serverId = options.serverId ?? 'server-a';
    const serverIdentityId = options.serverIdentityId ?? 'srv_test';
    const machines = options.machines ?? [{ machineId: 'machine-a', displayName: 'Mac' }];
    const rows = buildInventoryRows({
        serverId,
        serverIdentityId,
        serverLabel: options.serverLabel ?? 'Test server',
        machines,
    });
    const candidates = rows.map((row) => row.candidate);
    const selectedMachineId = options.selectedMachineId === undefined
        ? machines[0]?.machineId ?? null
        : options.selectedMachineId;
    const selectedTarget = selectedMachineId === null
        ? null
        : {
            serverIdentityId: options.selectedServerIdentityId ?? serverIdentityId,
            machineId: selectedMachineId,
        };
    const resolve = () => resolveExecutionTargetFrom({ rows, target: selectedTarget });
    return {
        candidates,
        pickerRows: rows,
        state: resolveMachineAdministrationTargetState({
            storedTarget: selectedTarget,
            candidates,
            allowSoleCandidate: true,
            // A fixture's rows are a settled machine list.
            isInventoryKnown: () => true,
        }),
        selectedTarget,
        selectedTargetServerMatchesActiveAccount: selectedTarget?.serverIdentityId === serverIdentityId,
        canExecute: resolve() !== null,
        selectTarget: () => undefined,
        clearTarget: () => undefined,
        resolveExecutionTarget: resolve,
    };
}
