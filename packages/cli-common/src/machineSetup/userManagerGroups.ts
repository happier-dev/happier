import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

/** Only the system service owner can replace a user manager's kernel groups. */
export function buildUserManagerGroupRefreshStep(input: Readonly<{ uid: number; username: string }>): MachineRecipeStepV1 {
    if (!Number.isSafeInteger(input.uid) || input.uid <= 0) throw new Error('A non-root user manager is required');
    return { id: 'daemon-user-manager', kind: 'command', executable: 'systemctl',
        args: ['restart', '--', `user@${input.uid}.service`], check: { kind: 'userManagerGroups', username: input.username } };
}
