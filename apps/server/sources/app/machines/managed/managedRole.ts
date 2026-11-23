import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';

/** Host Manage reaches its guests; host Use never supplies guest authority. */
export function inheritManagedControllerRole(controllerRole: MachineAccessRoleV1 | null,
    guestRole: MachineAccessRoleV1 | null): MachineAccessRoleV1 | null {
    return controllerRole === 'manage' ? 'manage' : guestRole;
}

export type ManagedMachineRoles = Readonly<{
    /** Native control, credential selectors and every managed target: the custodian and controller Manage. */
    resourceRole: MachineAccessRoleV1 | null;
    /** Guest activity and Exec, where a direct guest Manage grant also counts. */
    guestActivityRole: MachineAccessRoleV1 | null;
}>;

/**
 * The one managed-row role decision (owner rulings 2026-10-31 Machine Manage, 2026-11-10 managed guests).
 * Admission binds a controlled row's custodian to its controller's owner, so custody is Manage on every row.
 * Controller Manage reaches the row; a guest grant alone gives Use; controller Use gives nothing.
 */
export function resolveManagedMachineRoles(row: Readonly<{ custodianAccountId: string }>, actorAccountId: string,
    controllerRole: MachineAccessRoleV1 | null = null, guestRole: MachineAccessRoleV1 | null = null): ManagedMachineRoles {
    if (row.custodianAccountId === actorAccountId) return { resourceRole: 'manage', guestActivityRole: 'manage' };
    const resourceRole = inheritManagedControllerRole(controllerRole, guestRole ? 'use' : null);
    return { resourceRole, guestActivityRole: inheritManagedControllerRole(resourceRole, guestRole) };
}

export function resolveManagedMachineRole(row: Readonly<{ custodianAccountId: string }>, actorAccountId: string,
    controllerRole: MachineAccessRoleV1 | null = null, guestRole: MachineAccessRoleV1 | null = null): MachineAccessRoleV1 | null {
    return resolveManagedMachineRoles(row, actorAccountId, controllerRole, guestRole).resourceRole;
}
