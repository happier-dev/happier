import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

/** Empty setup is absent; retained lists and every script byte survive editing. */
export function normalizeMachineSetup(setup: MachineSetupV1): MachineSetupV1 | undefined {
    const secretRefs = setup.secretRefs && Object.keys(setup.secretRefs.bindings).length
        ? setup.secretRefs : undefined;
    const next: MachineSetupV1 = {
        ...(setup.toolchain ? { toolchain: setup.toolchain } : {}),
        ...(setup.items === undefined ? {} : { items: setup.items }),
        ...(setup.scripts === undefined ? {} : { scripts: setup.scripts }),
        ...(secretRefs ? { secretRefs } : {}),
    };
    return next.toolchain || next.items !== undefined || next.scripts !== undefined || next.secretRefs
        ? next : undefined;
}
