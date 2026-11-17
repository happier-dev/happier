import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { logger } from '@/ui/logger';

/** Machine metadata decoding and display-name precedence stay with the Machine owner. */
export async function readDeploymentNoticeMachineLabels(input: Parameters<typeof listCurrentAccountMachines>[0]): Promise<Map<string, string>> {
    try {
        const machines = await listCurrentAccountMachines(input);
        return new Map(machines.filter(machine => machine.label !== machine.id).map(machine => [machine.id, machine.label]));
    } catch (error) {
        if (!input.signal?.aborted) logger.warnLocalFile('[deploymentHealth] Machine names unavailable', {
            failureCause: projectActionFailureCauseV1(error, 'deployment.notice.machine_labels', { allowUnknownErrorCode: false }),
        });
        return new Map();
    }
}
