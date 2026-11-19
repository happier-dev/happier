import type { DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import type { DeploymentContentV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';

/** Only final per-installation version facts attest the selected link revision. */
export function readDeploymentUniformTargetLinkRevisionV1(input: Readonly<{
    deploymentId: string;
    actionOperationId?: string;
    targetLink: DeploymentTargetLinkHeaderV1;
    content: DeploymentContentV1;
}>): Readonly<{ expectedTargetLinkRevision: NonNullable<DeploymentTransitionInputV1['expectedTargetLinkRevision']>;
    servingDeploymentId?: string }> | null {
    if (input.content.machines.length !== input.targetLink.machines.length
        || !input.content.machines.every((machineId, index) => machineId === input.targetLink.machines[index])) return null;
    const results = new Map(input.content.machineResults.map(result => [result.machineId, result]));
    const servingDeploymentId = input.targetLink.activeDeploymentId;
    const retainsServingRelease = servingDeploymentId !== undefined
        && 'ownServer' in input.content && input.content.ownServer?.rollbackTarget?.deploymentId === servingDeploymentId
        && input.targetLink.members.some(member => member.state === 'joining')
        && input.actionOperationId !== undefined
        && input.targetLink.members.every(member => {
            const result = results.get(member.machineId);
            return result?.currentDeploymentId === servingDeploymentId
                && result.actionOperationId === input.actionOperationId
                && (member.state !== 'joining' || result.restoration === 'succeeded');
        });
    if (results.size !== input.content.machineResults.length || !input.targetLink.members.every(member => {
        const result = results.get(member.machineId);
        return result?.installationId === member.installationId
            && result.currentDeploymentId === (retainsServingRelease ? servingDeploymentId : input.deploymentId)
            && (retainsServingRelease || result.restoration === 'succeeded' || (result.restoration === undefined && result.activation === 'succeeded'))
            && (result.health === 'healthy' || result.health === 'unverified');
    })) return null;
    return { expectedTargetLinkRevision: input.targetLink.revision,
        ...(retainsServingRelease ? { servingDeploymentId } : {}) };
}
