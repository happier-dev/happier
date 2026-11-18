import { MachineRolesMutationResultV1Schema, machineRolesMetadataFieldV1, resolveManagedMachineEnrollmentRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import type { MachineRolesSetInputV1 } from '@happier-dev/protocol/actions/specs/machineRoles';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';

/** Enrollment already succeeded: a refused optional seed warns without replacing the owner's roles or failing creation. */
export async function applyManagedMachineEnrollmentRoles(params: Readonly<{
    machine: ManagedMachineFullV1;
    signal?: AbortSignal;
    warn: (code: string) => void;
    dispatch: (input: MachineRolesSetInputV1) => Promise<unknown>;
}>): Promise<void> {
    const { machine } = params;
    const isolation = machine.resource?.origin === 'created'
        ? { environment: 'managed-guest' as const, provisionerId: buildQualifiedPluginContributionKey(machine.resource.contributionRef) }
        : undefined;
    const policy = resolveManagedMachineEnrollmentRolesV1(machine.enrollmentIdentity, machine.resource?.origin);
    if (!policy) return;
    try {
        if (!machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
        const result = MachineRolesMutationResultV1Schema.safeParse(await params.dispatch({ serverId: machine.homeId,
            machineId: machine.enrolledMachineId, expectedMetadataVersion: 0,
            expectedPolicy: machineRolesMetadataFieldV1.defaultValue(), policy, ...(isolation ? { isolation } : {}) }));
        if (!result.success || result.data.status === 'outcomeUnknown') throw new ManagedMachineControllerError('action_outcome_unknown');
        if (!['applied', 'satisfied', 'unchanged'].includes(result.data.status)
            || !('policy' in result.data) || !machineRolesMetadataFieldV1.equal(result.data.policy, policy)) {
            throw new ManagedMachineControllerError('machine_roles_unconfirmed');
        }
    } catch (error) {
        params.signal?.throwIfAborted();
        params.warn(error instanceof ManagedMachineControllerError ? error.code : 'internal_error');
    }
}
