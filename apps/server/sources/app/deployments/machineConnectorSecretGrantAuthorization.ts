import { MachineConnectorSecretGrantInputV1Schema } from '@happier-dev/deployment-protocol';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';

/** Purpose narrowing only; the installed route retains proof, access and exact grant admission. */
export function isMachineConnectorSecretGrantHttpPurpose(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown }>,
): boolean {
    const setup = binding.actionId === 'machines.setup.apply';
    const configure = binding.actionId === 'machines.reachability.configure';
    if ((!setup && !configure) || effectActionId !== binding.actionId
        || proof.method.toUpperCase() !== 'POST'
        || proof.path !== `/v1/deployments/machines/${encodeURIComponent(binding.machineId)}/connector-secret-grant`) return false;
    const parsed = MachineConnectorSecretGrantInputV1Schema.safeParse(proof.body);
    if (!parsed.success) return false;
    const request = parsed.data;
    return request.serverId === binding.serverIdentityId
        && request.hostMachineId === binding.machineId && request.subject.machineId === binding.machineId
        && request.hostInstallationId === binding.installationId && request.subject.installationId === binding.installationId;
}
