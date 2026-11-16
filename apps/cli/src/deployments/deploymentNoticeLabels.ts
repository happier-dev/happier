import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { logger } from '@/ui/logger';

/** Machine metadata decoding and display-name precedence stay with the Machine owner. */
export async function readDeploymentNoticeMachineLabels(input: Parameters<typeof listCurrentAccountMachines>[0]): Promise<Map<string, string>> {
    try {
        const machines = await listCurrentAccountMachines(input);
        return new Map(machines.filter(machine => machine.label !== machine.id).map(machine => [machine.id, machine.label]));
    } catch (error) {
        if (!input.signal?.aborted) logger.infoFile('[deploymentHealth] Machine names unavailable', {
            errorCode: error instanceof Error && 'code' in error ? error.code : 'machine_names_unavailable',
        });
        return new Map();
    }
}
