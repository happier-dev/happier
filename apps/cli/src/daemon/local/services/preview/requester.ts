import type { RpcHandlerContext } from '@/api/rpc/types';
import type { LocalServicePreviewResourceV1, LocalServicePreviewServiceTargetV1 } from '@happier-dev/protocol/local/services/preview/v1';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { assertLocalServiceCredentialAdmission, assertLocalServiceReadCustody } from '../credentialAdmission';
import { selectVisibleMachineProjectServices } from '../launch/machineServiceDisclosure';
import { createLocalServicePreviewServerRoutes, type LocalServicePreviewServerInput } from './serverRoutes';

/** Select credentials and disclosure together at the preview lifecycle owner. Native
 * registration remains the daemon's job; an Open's viewer admission belongs to its actor. */
export async function admitLocalServicePreviewRequest(input: Readonly<{
    machineId: string;
    serverId?: string;
    accountId?: string;
    server?: LocalServicePreviewServerInput;
    projectManagedServices?: Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectService'>;
    context?: RpcHandlerContext;
    effect: boolean;
}>) {
    const scope = { accountId: input.accountId, machineId: input.machineId, context: input.context };
    const requesterAccountId = await assertLocalServiceReadCustody(scope, 'requester_managed_services');
    const authorization = input.context?.callerInputAuthorization;
    const admission = input.context?.machineAdmission;
    const requester = readRequesterAccountActionContext(authorization);
    if (requesterAccountId && (input.effect && !authorization || !input.serverId && !authorization
        || authorization && (authorization.binding.accountId !== requesterAccountId
            || authorization.binding.machineId !== input.machineId
            || authorization.binding.custodianAccountId !== input.accountId
            || authorization.binding.installationId !== admission?.installationId))) {
        throw new Error('requester_credentials_unavailable');
    }
    if (input.effect) {
        if (requesterAccountId && (!requester || !await requester.isCurrent())) throw new Error('requester_credentials_unavailable');
        await assertLocalServiceCredentialAdmission({ ...scope, accountId: requesterAccountId ?? input.accountId });
    }
    const serverInput = requesterAccountId && requester && input.server
        ? { ...input.server, token: requester.credentials.token, serverBaseUrl: requester.serverHttpBaseUrl }
        : input.server;
    const selectTargets = async (targets: readonly LocalServicePreviewServiceTargetV1[]) => {
        const handles = targets.flatMap(target => {
            const resolved = input.projectManagedServices?.resolveProjectService(target);
            return resolved?.status === 'found' ? [resolved.handle] : [];
        });
        const serverId = input.serverId ?? authorization?.binding.serverIdentityId;
        return serverId ? await selectVisibleMachineProjectServices({ serverId,
            machineId: input.machineId }, handles, { requesterAccountId,
            context: { externalActionExecutionAuthorization: authorization } }) : [];
    };
    return {
        requesterOnly: requesterAccountId !== undefined,
        server: serverInput ? createLocalServicePreviewServerRoutes(serverInput) : null,
        async canAccess(target: LocalServicePreviewServiceTargetV1 | undefined) {
            return !requesterAccountId || !!target && (await selectTargets([target])).length > 0;
        },
        async selectResources(resources: readonly LocalServicePreviewResourceV1[]) {
            if (!requesterAccountId) return resources;
            const visible = new Set((await selectTargets(resources.flatMap(resource => resource.serviceTarget ? [resource.serviceTarget] : [])))
                .map(handle => handle.instanceId));
            return resources.filter(resource => resource.serviceTarget && visible.has(resource.serviceTarget.managedServiceId));
        },
    };
}
