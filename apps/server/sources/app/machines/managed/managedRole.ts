import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';

/** Host Manage reaches its guests; host Use never supplies guest authority. */
export function inheritManagedControllerRole(controllerRole: MachineAccessRoleV1 | null,
    guestRole: MachineAccessRoleV1 | null): MachineAccessRoleV1 | null {
    return controllerRole === 'manage' ? 'manage' : guestRole;
}

/** Native custody before enrollment and the enrolled guest consume the same role rule. */
export function resolveManagedMachineRole(row: Readonly<{ custodianAccountId: string; controllerMachineId: string | null }>,
    actorAccountId: string, controllerRole: MachineAccessRoleV1 | null = null,
    guestRole: MachineAccessRoleV1 | null = null): MachineAccessRoleV1 | null {
    return inheritManagedControllerRole(controllerRole,
        row.controllerMachineId === null && row.custodianAccountId === actorAccountId ? 'manage' : guestRole);
}
