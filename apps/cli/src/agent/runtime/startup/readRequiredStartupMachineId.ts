import { readActiveMachineId } from '@/daemon/machineIdentity/machineRegistrationStore';

const DEFAULT_MISSING_MACHINE_ID_MESSAGE =
    '[START] No machine ID found in the local registration. Please report this issue on https://github.com/happier-dev/happier/issues';

export async function readRequiredStartupMachineId(
    missingMachineIdMessage?: string,
): Promise<string> {
    const machineId = await readActiveMachineId();
    if (machineId) {
        return machineId;
    }

    console.error(missingMachineIdMessage ?? DEFAULT_MISSING_MACHINE_ID_MESSAGE);
    process.exit(1);
}
