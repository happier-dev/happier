import { MachineRolesMutationResultV1Schema, machineRolesMetadataFieldV1, resolveManagedMachineEnrollmentRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import type { MachineRolesSetInputV1 } from '@happier-dev/protocol/actions/specs/machineRoles';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError } from './controllerErrors.js';

/** Both creation hosts seed the same install-type policy without replacing an owner's edited field. */
export async function applyManagedMachineEnrollmentRoles(params: Readonly<{
    machine: ManagedMachineFullV1;
    dispatch: (input: MachineRolesSetInputV1) => Promise<unknown>;
}>): Promise<void> {
    const { machine } = params;
    const policy = resolveManagedMachineEnrollmentRolesV1(machine.enrollmentIdentity);
    if (!policy) return;
    if (!machine.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
    const result = MachineRolesMutationResultV1Schema.safeParse(await params.dispatch({ serverId: machine.homeId,
        machineId: machine.enrolledMachineId, expectedMetadataVersion: 0,
        expectedPolicy: machineRolesMetadataFieldV1.defaultValue(), policy }));
    if (!result.success || result.data.status === 'outcomeUnknown') throw new ManagedMachineControllerError('action_outcome_unknown');
    if (!['applied', 'satisfied', 'unchanged'].includes(result.data.status)
        || !('policy' in result.data) || !machineRolesMetadataFieldV1.equal(result.data.policy, policy)) {
        throw new ManagedMachineControllerError('machine_roles_unconfirmed');
    }
}
