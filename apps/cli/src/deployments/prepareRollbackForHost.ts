import { randomUUID } from 'node:crypto';
import { DeploymentRollbackInputV1Schema, type ActionExecutorContext,
    type DeploymentArtifactContentReferenceV1, type DeploymentRollbackInputV1, type DeploymentRollbackIntentInputV1 } from '@happier-dev/protocol';
import { DeploymentContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { readPromotionSelectionForHost } from './storedPromotionCandidate';
import { deploymentUnavailableError } from './deploymentFailure';

/** The native preparation owner derives a fresh candidate from the selected retained receipt. */
export async function prepareRollbackForHost(request: Readonly<{
    input: DeploymentRollbackIntentInputV1; context: ActionExecutorContext;
}>, host: Pick<Parameters<typeof readPromotionSelectionForHost>[1], 'readEnvironment' | 'readReceipt'> & Readonly<{
    createCandidate(environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1): Promise<DeploymentArtifactContentReferenceV1>;
}>): Promise<Readonly<{ environment: DeploymentEnvironmentDetailV1; input: DeploymentRollbackInputV1 }>> {
    const { input, context } = request;
    const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
    const link = environment.targetLinks.find(item => item.targetLink.id === environment.environment.runtimeTargetLinkId)?.targetLink;
    if (!link) throw deploymentUnavailableError('deployment.rollback.prepare.runtime_target_link', 'not_found');
    const retained = await host.readReceipt({ environmentId: input.environmentId, deploymentId: input.deploymentId, context });
    // Keep provenance, not the previous approval or observed outcomes. Native
    // review still proves this candidate against the selected retained content.
    const { ownServer: _priorReview, ...provenance } = retained.content;
    const content = DeploymentContentV1Schema.parse({ ...provenance, machines: link.machines,
        // Keep the selected provider identity, but start a new traffic change.
        // The retained deployment is supplied separately as priorDeployment.
        ...(provenance.platform ? { platform: { ...provenance.platform, targetLinkRevision: link.revision,
            observation: { v: 1, state: 'queued', observedAtMs: Date.now() } } } : {}),
        ...(link.source.kind === 'plugin' ? {} : { buildMachineId: environment.environment.buildMachineId ?? environment.environment.controllerMachineId }),
        machineResults: [], steps: [] });
    return { environment, input: DeploymentRollbackInputV1Schema.parse({ ...input,
        requestKey: input.requestKey ?? randomUUID(), expectedRevision: environment.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
        ...await host.createCandidate(environment, content) }) };
}
