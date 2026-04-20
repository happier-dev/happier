import { readSettings } from '@/persistence';

const DEFAULT_MISSING_MACHINE_ID_MESSAGE =
    '[START] No machine ID found in settings. Please report this issue on https://github.com/happier-dev/happier/issues';

export async function readRequiredStartupMachineId(
    missingMachineIdMessage?: string,
): Promise<string> {
    const settings = await readSettings();
    const machineId = typeof settings?.machineId === 'string' ? settings.machineId.trim() : '';
    if (machineId.length > 0) {
        return machineId;
    }

    console.error(missingMachineIdMessage ?? DEFAULT_MISSING_MACHINE_ID_MESSAGE);
    process.exit(1);
}
