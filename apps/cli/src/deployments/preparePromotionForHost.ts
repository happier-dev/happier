import { randomUUID } from 'node:crypto';
import { buildDeploymentPromoteInputV1, type ActionExecutorContext,
    type DeploymentPromoteIntentInputV1, type DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol';
import type { DeploymentContentV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { readStoredPromotionCandidateForHost, createStoredPromotionReceiptContentForHost } from './storedPromotionCandidate';
import { DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE } from './targets/ownServer/prepareCandidate';

/** Compact requests join the existing stored-promotion review and publication path. */
export async function preparePromotionForHost(request: Readonly<{
    input: DeploymentPromoteIntentInputV1; context: ActionExecutorContext;
}>, host: Parameters<typeof readStoredPromotionCandidateForHost>[1] & Readonly<{
    createCandidate(environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1): Promise<DeploymentArtifactContentReferenceV1>;
}>) {
    const promotion = await readStoredPromotionCandidateForHost(request, host);
    const { environment } = promotion.destination;
    const candidate = await host.createCandidate(promotion.destination,
        createStoredPromotionReceiptContentForHost(promotion, DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE));
    return { promotion, input: buildDeploymentPromoteInputV1(request.input, {
        requestKey: request.input.requestKey ?? randomUUID(), expectedRevision: environment.revision,
        targetLinkId: promotion.link.id, expectedTargetLinkRevision: promotion.link.revision, candidate,
        // The existing review owner publishes the replacement before approval.
        destinationContent: { contentArtifactId: environment.contentArtifactId,
            contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion },
    }) };
}
