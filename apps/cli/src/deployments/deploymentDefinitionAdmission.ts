import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentContentV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { isDeepStrictEqual } from 'node:util';
import { isHostRequesterUnrestrictedOwner } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { DeploymentSourceRequesterIdentityResolver } from './readDeploymentSourceIntentForHost';
import { readHostReviewedChildReceivingAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

const refuse = (): never => { throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' }); };

/** Consume Home's effective grant, never the role selected by an operation projection. */
export async function resolveDeploymentDefinitionRoleForHost(context: ActionExecutorContext, host: Readonly<{
    serverId: string; machineId: string; resolveRequesterIdentity: DeploymentSourceRequesterIdentityResolver;
}>): Promise<'use' | 'manage'> {
    const binding = context.externalActionExecutionAuthorization?.binding;
    if (binding) {
        if (!await isServerProfileHomeIdentity(host.serverId, binding.serverIdentityId)) return refuse();
        const ingress = context as RpcActionExecutorContext;
        const packet = ingress.workspaceSyncSourceExecution;
        const admission = ingress.machineAdmission;
        // Setup's receiving RPC owner already admitted this exact target with
        // Manage, after opening and reviewing the child input. Consume that
        // admission; packet.params still contains transport ciphertext in E2EE.
        // Its parent remains routing-host-bound, not target authority.
        if (packet && admission
            && packet.method === `${host.machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`
            && admission.machineId === host.machineId
            && admission.actorAccountId === binding.accountId && admission.role === 'manage'
            && ingress.verifyMachineAdmissionCurrent) return 'manage';
        // The native child receiver lends only its independently admitted target
        // grant through the existing private issuer; the Publish root stays bound
        // to its original routing host.
        const receiving = readHostReviewedChildReceivingAdmissionV1(context);
        if (receiving?.machineId === host.machineId) return receiving.role;
        if (binding.machineId !== host.machineId) return refuse();
        if (binding.admittedMachineRole !== undefined) return binding.admittedMachineRole;
        // Older signed roots carry no grant. In particular, their synthesized
        // operation machineAdmission must not turn a foreign requester into Use
        // or Manage through the native execution identity's broader full-control tag.
        if (binding.accountId !== binding.custodianAccountId) return refuse();
    } else {
        const ingress = context as RpcActionExecutorContext;
        if (ingress.machineAdmission) {
            if (ingress.machineAdmission.machineId !== host.machineId || !ingress.verifyMachineAdmissionCurrent) return refuse();
            return ingress.machineAdmission.role;
        }
    }
    return isHostRequesterUnrestrictedOwner(await host.resolveRequesterIdentity(context)) ? 'manage' : refuse();
}

/** Stored Compose includes environment, ports and service definitions in one exact document. */
export function admitUseDeploymentDefinition(environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1,
    targetLinkId: string, retained?: DeploymentContentV1): void {
    const approved = retained?.sourceIntent ?? environment.content.definition;
    const sourceMethod = retained?.sourceMethod ?? (content.platform && approved.kind === 'stored' ? 'upload' : undefined);
    if (!isDeepStrictEqual(content.sourceIntent, approved) || content.sourceMethod !== sourceMethod) return refuse();
    const link = environment.targetLinks.find(row => row.targetLink.id === targetLinkId)?.targetLink;
    if (!link) return refuse();
    // The contributed target owner already proves its retained provider/config
    // identity. Stored upload is its native source method, not a caller override.
    if (content.platform) {
        if (link.source.kind !== 'plugin') return refuse();
        return;
    }
    if (!isDeepStrictEqual(content.machines, link.machines)
        || content.buildMachineId !== (environment.environment.buildMachineId ?? environment.environment.controllerMachineId)
        || !isDeepStrictEqual(content.ingress, retained
            ? ('ingress' in retained ? retained.ingress : undefined) : environment.content.ingress)) return refuse();
}
