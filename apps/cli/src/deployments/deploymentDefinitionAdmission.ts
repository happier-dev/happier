import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentContentV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { resolveDeploymentSourceMethodV1 } from '@happier-dev/deployment-protocol';
import { isDeepStrictEqual } from 'node:util';
import { isHostRequesterUnrestrictedOwner } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { DeploymentSourceRequesterIdentityResolver } from './readDeploymentSourceIntentForHost';
import { readHostReviewedChildReceivingAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { normalizeAdmittedHomeServerIdV1 } from '@happier-dev/protocol/actions/executor/deploymentHomeAdmission';
import { refuseDeploymentAuthorization } from './deploymentAuthorizationFailure';

const refuse = (): never => { throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' }); };

export async function assertDeploymentHttpAuthorityForHost(context: ActionExecutorContext): Promise<void> {
    context.signal?.throwIfAborted();
    const authorization = context.externalActionExecutionAuthorization;
    if (authorization) {
        if (!authorization.requesterHttpProjection) return refuseDeploymentAuthorization('requester_http_projection_missing');
    } else if (context.externalActionCredential || context.rpcSessionAuthorization) return refuseDeploymentAuthorization('requester_authorization_missing');
    context.signal?.throwIfAborted();
}

/** Metadata spends the signed root; private content also needs its admitted Account custody. */
export async function assertDeploymentContentAuthorityForHost(context: ActionExecutorContext): Promise<void> {
    await assertDeploymentHttpAuthorityForHost(context);
    if (context.externalActionExecutionAuthorization && !context.externalActionExecutionAuthorization.requesterAccountProjection)
        return refuseDeploymentAuthorization('requester_account_projection_missing');
}

/** Consume Home's effective grant, never the role selected by an operation projection. */
export async function resolveDeploymentDefinitionRoleForHost(context: ActionExecutorContext, host: Readonly<{
    serverId: string; machineId: string; resolveRequesterIdentity: DeploymentSourceRequesterIdentityResolver;
}>): Promise<'use' | 'manage'> {
    const binding = context.externalActionExecutionAuthorization?.binding;
    if (binding) {
        if (normalizeAdmittedHomeServerIdV1(host.serverId, context) !== binding.serverIdentityId) return refuse();
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
        // grant through the existing private issuer; the routing root stays bound
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
    const linkRow = environment.targetLinks.find(row => row.targetLink.id === targetLinkId);
    if (!linkRow) return refuse();
    const link = linkRow.targetLink;
    // Platform candidates spend the link's recorded method through the same
    // resolver the target owner used; Use may not override it.
    const sourceMethod = retained?.sourceMethod ?? (!content.platform ? undefined : approved.kind === 'stored' ? 'upload'
        : resolveDeploymentSourceMethodV1({ recorded: linkRow.content?.sourceMethod }));
    if (!isDeepStrictEqual(content.sourceIntent, approved) || content.sourceMethod !== sourceMethod) return refuse();
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
