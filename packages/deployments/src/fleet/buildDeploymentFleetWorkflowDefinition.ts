import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeploymentFleetWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/deploymentFleetV1';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { DeploymentEnvironmentDetailV1, DeploymentOwnServerContentV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentIngressV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentCreateV1';

export type DeploymentFleetWorkflowInput = Readonly<{
    serverId: string;
    environment: DeploymentEnvironmentDetailV1;
    runtimeLink: DeploymentTargetLinkHeaderV1 & { source: { kind: 'host'; id: string } };
    change: Readonly<{ kind: 'add'; member: Readonly<{ machineId: string; installationId: string }>;
        sourceIntent?: DeploymentOwnServerContentV1['sourceIntent']; ingress?: DeploymentIngressV1 } | { kind: 'remove'; machineId: string }>;
    requestId: string;
}>;

/** One public authoring owner for UI and agents; admission remains with the Actions. */
export function buildDeploymentFleetWorkflowDefinition(input: DeploymentFleetWorkflowInput) {
    const { environment, runtimeLink, change, requestId } = input;
    const deployCurrentRelease = change.kind === 'add' && runtimeLink.activeDeploymentId !== undefined;
    if (deployCurrentRelease && change.kind === 'add' && change.sourceIntent === undefined) {
        throw new TypeError('Adding a server to an active fleet requires the selected serving receipt source.');
    }
    const members = runtimeLink.members.map(({ machineId, installationId }) => ({ machineId, installationId }));
    // Refuse an invalid replacement before authoring a preceding destructive teardown.
    const machines = DeploymentOwnServerTargetMachinesV1Schema.parse(change.kind === 'add' ? [...members, change.member]
        : members.filter(member => member.machineId !== change.machineId));
    return {
        definition: createDeploymentFleetWorkflowV1(change.kind, { deployCurrentRelease,
            configureIngress: change.kind === 'add' && change.ingress !== undefined }),
        inputs: { fleet: projectNativeJsonValueForTransport({
            serverId: input.serverId, environmentId: environment.environment.id,
            expectedRevision: environment.environment.revision, targetId: runtimeLink.source.id,
            sourceLinkId: runtimeLink.id, sourceLinkRevision: runtimeLink.revision,
            machines,
            ...(change.kind === 'add' ? { bindings: environment.content.bindings,
                ...(deployCurrentRelease && change.sourceIntent !== undefined ? { sourceIntent: change.sourceIntent } : {}),
                ...(change.ingress === undefined ? {} : { ingress: change.ingress,
                    contentArtifactId: environment.environment.contentArtifactId,
                    contentHeaderVersion: environment.environment.contentHeaderVersion,
                    contentBodyVersion: environment.environment.contentBodyVersion }) }
                : { removedMachineId: change.machineId }),
            linkRequestKey: `${requestId}:link`, deployRequestKey: `${requestId}:deploy`,
            teardownRequestKey: `${requestId}:teardown`,
        }) } satisfies NonNullable<WorkflowRunStartRequestV1['inputs']>,
    };
}
