import { createDeploymentMoveWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/deploymentMoveV1';
import type { DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1, DeploymentOwnServerContentV1 } from '@happier-dev/deployment-protocol';

/** Author the same public starter with reviewed immutable source and installation references. */
export function buildMoveWorkflowDefinition(input: Readonly<{
    serverId: string;
    environment: DeploymentEnvironmentDetailV1;
    sourceLink: DeploymentTargetLinkHeaderV1 & { source: { kind: 'host'; id: string } };
    sourceDeploymentId: string;
    sourceIntent: Extract<DeploymentOwnServerContentV1['sourceIntent'], { kind: 'repository' }>;
    primaryService: string;
    sourceMachineId: string;
    destination: Readonly<{ machineId: string; installationId: string }>;
    requestId: string;
}>) {
    const { environment, sourceLink, destination, requestId } = input;
    return {
        definition: createDeploymentMoveWorkflowV1(),
        inputs: { noLocalData: true, move: {
            serverId: input.serverId, environmentId: environment.environment.id,
            expectedRevision: environment.environment.revision, targetId: sourceLink.source.id,
            sourceLinkId: sourceLink.id, sourceLinkRevision: sourceLink.revision,
            sourceDeploymentId: input.sourceDeploymentId, sourceMachineId: input.sourceMachineId,
            destinationMachineId: destination.machineId, destinationInstallationId: destination.installationId,
            machines: sourceLink.members.map(member => member.machineId === input.sourceMachineId
                ? destination : { machineId: member.machineId, installationId: member.installationId }),
            sourceIntent: input.sourceIntent, primaryService: input.primaryService,
            bindings: environment.content.bindings,
            linkRequestKey: `${requestId}:link`, deployRequestKey: `${requestId}:deploy`,
            teardownRequestKey: `${requestId}:teardown`, unlinkRequestKey: `${requestId}:unlink`,
        } },
    };
}
