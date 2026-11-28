import {
    createDeploymentLinkContentArtifactIdV1,
    type ExternalActionExecutionAuthorizationBindingV1,
    type ReviewedActionChildHttpProofV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, PLATFORM_FAILURE_SETUP_ROLE } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DEPLOYMENT_PREVIEW_SETUP_CHILD_ROLE_V1, readDeploymentReviewedChildV1 } from '@happier-dev/protocol/actions/specs/deploymentPreparationScope';
import type { Tx } from '@/storage/inTx';
import { readDeclaredDeploymentPreparationHttpRead, readDeploymentEnvironmentContentPreparationHttpPurpose,
    readDeploymentLinkPreparationHttpPurpose, readDeploymentPreparationHttpReadPurpose } from './deploymentPreparationAuthorization';

/** A signed provider child declared read-only by its root spends only that root's existing resource scope. */
export async function readDeploymentReviewedSetupHttpPurpose(
    tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown;
        reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    isHttpOperation: (actionId: string) => boolean,
    /** The canonical body-less exact `GET /v1/artifacts/<id>` parser; null for any other request. */
    readArtifactId: () => string | null,
): Promise<boolean> {
    const child = readDeploymentReviewedChildV1(binding, proof.reviewedChild, effectActionId, proof);
    if (child?.entry.action !== 'plugin') return false;

    if (child.entry.role === DEPLOYMENT_PREVIEW_SETUP_CHILD_ROLE_V1) {
        // Receipt enrollment reads the template selected by this Update. The
        // existing preparation owner retains native admission and operand scope.
        return await readDeploymentEnvironmentContentPreparationHttpPurpose(tx, binding,
            DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, proof, isHttpOperation) === true;
    }
    if (child.entry.role !== PLATFORM_FAILURE_SETUP_ROLE) {
        // A teardown preview reads only what its teardown root may read itself.
        const artifactId = readArtifactId();
        if (artifactId !== null) return await isTeardownPreviewContentArtifactInTx(tx, binding, artifactId);
        return Boolean(await readDeploymentPreparationHttpReadPurpose(tx, binding,
            readDeclaredDeploymentPreparationHttpRead(binding, binding.actionId, proof, isHttpOperation)));
    }
    const admission = binding.deploymentLinkAdmission;
    if (!admission) return false;

    const artifactId = createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: admission });
    // Setup may open this job's Link, never another inventory member or the
    // Artifact grant/key-envelope transports available to Link preparation.
    const effect = proof.path === `/v1/artifacts/${encodeURIComponent(artifactId)}`
        ? binding.actionId : DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1;
    return await readDeploymentLinkPreparationHttpPurpose(tx, binding, effect, proof, isHttpOperation) === true;
}

/**
 * The preview opens the teardown root's admitted Environment content and the content of
 * the Link it removes. Home signs only the root's Environment, so the Link is bounded to
 * that Environment's own current Links; receipts, Domains and every other Artifact stay refused.
 * The Artifact route still applies the requester's own per-record access.
 */
async function isTeardownPreviewContentArtifactInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, artifactId: string): Promise<boolean> {
    const environmentId = binding.environmentId;
    if (environmentId === undefined) return false;
    // A deleted Environment or removed Link stops being readable by a preview signed earlier.
    const environment = await tx.deploymentEnvironment.findFirst({ where: { id: environmentId, deletedAt: null },
        select: { contentArtifactId: true } });
    if (!environment) return false;
    if (environment.contentArtifactId === artifactId) return true;
    return await tx.deploymentTargetLink.findFirst({ where: { environmentId, contentArtifactId: artifactId, deletedAt: null },
        select: { id: true } }) !== null;
}
