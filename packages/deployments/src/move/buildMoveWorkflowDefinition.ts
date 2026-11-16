import { createDeploymentMoveWorkflowV1, createDeploymentDataMoveWorkflowV1,
    type StatefulDeploymentMoveWorkflowInputV1 } from '@happier-dev/protocol/workflows/builtins/deploymentMoveV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1, DeploymentOwnServerContentV1 } from '@happier-dev/deployment-protocol';

export type StatelessDeploymentMoveWorkflowInput = Readonly<{
    kind?: 'stateless';
    serverId: string;
    environment: DeploymentEnvironmentDetailV1;
    sourceLink: DeploymentTargetLinkHeaderV1 & { source: { kind: 'host'; id: string } };
    sourceDeploymentId: string;
    sourceIntent: Extract<DeploymentOwnServerContentV1['sourceIntent'], { kind: 'repository' }>;
    primaryService: string;
    sourceMachineId: string;
    destination: Readonly<{ machineId: string; installationId: string }>;
    requestId: string;
}>;
export type { StatefulDeploymentMoveWorkflowInputV1 };
export type DeploymentMoveWorkflowInput = StatelessDeploymentMoveWorkflowInput | StatefulDeploymentMoveWorkflowInputV1;

function buildStatefulMove(input: StatefulDeploymentMoveWorkflowInputV1) {
    const reviewed = { ...input, deploy: { ...input.deploy, requestKey: input.deploy.requestKey ?? `${input.requestId}:deploy` },
        ...(input.teardown ? { teardown: { ...input.teardown, requestKey: input.teardown.requestKey ?? `${input.requestId}:teardown` } } : {}) };
    return { definition: createDeploymentDataMoveWorkflowV1(reviewed),
        inputs: { dataMove: projectNativeJsonValueForTransport(reviewed) } };
}

/** Author the public Move starter; all effects and continuation stay Workflow-owned. */
export function buildMoveWorkflowDefinition(input: StatelessDeploymentMoveWorkflowInput): ReturnType<typeof buildStatelessMove>;
export function buildMoveWorkflowDefinition(input: StatefulDeploymentMoveWorkflowInputV1): ReturnType<typeof buildStatefulMove>;
export function buildMoveWorkflowDefinition(input: DeploymentMoveWorkflowInput): ReturnType<typeof buildStatelessMove> | ReturnType<typeof buildStatefulMove>;
export function buildMoveWorkflowDefinition(input: DeploymentMoveWorkflowInput) {
    return input.kind === 'stateful' ? buildStatefulMove(input) : buildStatelessMove(input);
}

function buildStatelessMove(input: StatelessDeploymentMoveWorkflowInput) {
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
