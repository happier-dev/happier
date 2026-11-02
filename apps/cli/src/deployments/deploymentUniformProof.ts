import type { DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import type { DeploymentContentV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';

/** Only final per-installation version facts attest the selected link revision. */
export function readDeploymentUniformTargetLinkRevisionV1(input: Readonly<{
    deploymentId: string;
    targetLink: DeploymentTargetLinkHeaderV1;
    content: DeploymentContentV1;
}>): NonNullable<DeploymentTransitionInputV1['expectedTargetLinkRevision']> | null {
    if (input.content.machines.length !== input.targetLink.machines.length
        || !input.content.machines.every((machineId, index) => machineId === input.targetLink.machines[index])) return null;
    const results = new Map(input.content.machineResults.map(result => [result.machineId, result]));
    if (results.size !== input.content.machineResults.length || !input.targetLink.members.every(member => {
        const result = results.get(member.machineId);
        return result?.installationId === member.installationId
            && result.currentDeploymentId === input.deploymentId
            && (result.restoration === 'succeeded' || (result.restoration === undefined && result.activation === 'succeeded'))
            && (result.health === 'healthy' || result.health === 'unverified');
    })) return null;
    return input.targetLink.revision;
}
