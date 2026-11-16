import { projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';

/**
 * A deployment read's signed admission names the Machine Home mints it for, so
 * that Machine is the read's receiver. Undefined when the read names none (compact
 * platform logs) or the input is not a deployment read; its executor owns input errors.
 */
export function readDeploymentReadReceiverMachineId(
  actionId: string,
  input: unknown,
): string | undefined {
  try {
    const read = projectDeploymentReadAdmissionV1(actionId, input);
    return read && 'machineId' in read ? read.machineId : undefined;
  } catch {
    return undefined;
  }
}
