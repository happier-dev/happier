import { randomUUID } from 'node:crypto';
import { DeploymentRollbackInputV1Schema, type ActionExecutorContext,
    type DeploymentArtifactContentReferenceV1, type DeploymentRollbackInputV1, type DeploymentRollbackIntentInputV1 } from '@happier-dev/protocol';
import { DeploymentContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';

/** The native preparation owner derives a fresh candidate from the selected retained receipt. */
export async function prepareRollbackForHost(request: Readonly<{
    input: DeploymentRollbackIntentInputV1; context: ActionExecutorContext;
}>, host: Pick<OwnServerDeploymentTargetHostInput, 'readEnvironment' | 'readReceipt'> & Readonly<{
    createCandidate(environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1): Promise<DeploymentArtifactContentReferenceV1>;
}>): Promise<Readonly<{ environment: DeploymentEnvironmentDetailV1; input: DeploymentRollbackInputV1 }>> {
    const { input, context } = request;
    const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
    const link = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
    if (!link) throw Object.assign(new Error('deployment_unavailable'), { code: 'deployment_unavailable' });
    const retained = await host.readReceipt({ environmentId: input.environmentId, deploymentId: input.deploymentId, context });
    // Keep provenance, not the previous approval or observed outcomes. Native
    // review still proves this candidate against the selected retained content.
    const { ownServer: _priorReview, ...provenance } = retained.content;
    const content = DeploymentContentV1Schema.parse({ ...provenance, machines: link.machines,
        buildMachineId: environment.environment.buildMachineId ?? environment.environment.controllerMachineId,
        machineResults: [], steps: [] });
    return { environment, input: DeploymentRollbackInputV1Schema.parse({ ...input,
        requestKey: input.requestKey ?? randomUUID(), expectedRevision: environment.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
        ...await host.createCandidate(environment, content) }) };
}
