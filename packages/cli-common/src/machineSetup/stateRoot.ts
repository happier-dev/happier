import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

/** Shared parent: services and isolated members traverse it without listing peers. */
export const machineStateRootStep = {
    id: 'machine-state-root', kind: 'directory', path: '/var/lib/happier',
    owner: 'root', group: 'root', mode: 0o711, preserveExistingOwnership: true,
} as const satisfies Extract<MachineRecipeStepV1, { kind: 'directory' }>;
