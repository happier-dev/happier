import type { ActionExecutorContext, ActionOperationDomainRefV1 } from '@happier-dev/protocol';
import type { MachineDeploymentDomainReferenceV1 } from '@happier-dev/protocol/machines/machineDeploymentDomainReferenceV1';

/** The admitted native owner publishes intent; observations retain their own truth. */
export function createOwnServerExpectedDownPublisher(input: Readonly<{
    serverId: string; environmentId: string; targetLinkId: string; deploymentId: string;
    machineId: string; installationId: string; environmentInstanceId: string;
    operation: 'deploy' | 'backup'; context: ActionExecutorContext;
    readDomains(services: readonly string[]): Promise<readonly MachineDeploymentDomainReferenceV1[] | null>;
}>): (services: readonly string[]) => Promise<void> {
    return async services => {
        const owner = input.context.operationOwnerUpdate;
        if (!owner) return;
        const domainRef = { kind: 'deployment' as const, serverId: input.serverId,
            environmentId: input.environmentId, deploymentId: input.deploymentId };
        if (!services.length) { owner.update({ domainRef }); return; }
        // Unreadable Domain custody supplies no Domain explanation. It does not
        // block native work or turn an unrelated Domain into expected downtime.
        const domains = await input.readDomains(services).catch(() => null) ?? [];
        owner.update({ domainRef: { ...domainRef, expectedDown: {
            operation: input.operation, targetLinkId: input.targetLinkId,
            machineId: input.machineId, installationId: input.installationId,
            serviceIds: services.map(service => `${input.environmentInstanceId}/${service}`), domains,
        } } satisfies ActionOperationDomainRefV1 });
    };
}
