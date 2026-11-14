import { randomUUID } from 'node:crypto';
import { buildDeploymentPromoteInputV1, type ActionExecutorContext,
    type DeploymentPromoteIntentInputV1, type DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol';
import { DeploymentPlatformContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { readPromotionSelectionForHost, prepareStoredPromotionForHost, createStoredPromotionReceiptContentForHost } from './storedPromotionCandidate';
import { DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE } from './targets/ownServer/prepareCandidate';

/** Compact requests join the existing stored-promotion review and publication path. */
export async function preparePromotionForHost(request: Readonly<{
    input: DeploymentPromoteIntentInputV1; context: ActionExecutorContext;
}>, host: Parameters<typeof readPromotionSelectionForHost>[1] & Readonly<{
    createCandidate(environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1): Promise<DeploymentArtifactContentReferenceV1>;
}>) {
    const selected = await readPromotionSelectionForHost(request, host);
    const { destination, link } = selected;
    const { environment } = destination;
    const promotion = link.source.kind === 'plugin' ? undefined : prepareStoredPromotionForHost(selected);
    let content: DeploymentContentV1;
    if (promotion) content = createStoredPromotionReceiptContentForHost(promotion, DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE);
    else {
        const { failure: _previousFailure, ...retained } = DeploymentPlatformContentV1Schema.parse(selected.sourceReceipt.content);
        content = DeploymentPlatformContentV1Schema.parse({ ...retained, machineResults: [], steps: [],
            platform: { ...selected.target.content, targetLinkRevision: link.revision, observation: retained.platform.observation } });
    }
    const candidate = await host.createCandidate(destination, content);
    return { promotion, environment: destination, input: buildDeploymentPromoteInputV1(request.input, {
        requestKey: request.input.requestKey ?? randomUUID(), expectedRevision: environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, candidate,
        // The existing review owner publishes the replacement before approval.
        destinationContent: { contentArtifactId: environment.contentArtifactId,
            contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion },
    }) };
}
