import {
    createDeploymentLinkContentArtifactIdV1,
    type ExternalActionExecutionAuthorizationBindingV1,
    type ReviewedActionChildHttpProofV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
    isDeploymentTargetLinkActionIdV1, PLATFORM_FAILURE_SETUP_ROLE } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { Tx } from '@/storage/inTx';
import { readDeploymentEnvironmentContentPreparationHttpPurpose,
    readDeploymentLinkPreparationHttpPurpose } from './deploymentPreparationAuthorization';

/** A signed setup child spends only its root owner's existing resource scope. */
export async function readDeploymentReviewedSetupHttpPurpose(
    tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown;
        reviewedChild?: ReviewedActionChildHttpProofV1 }>,
    isHttpOperation: (actionId: string) => boolean,
): Promise<boolean> {
    if (proof.reviewedChild?.actionId !== effectActionId
        || !parseQualifiedPluginActionId(effectActionId)
        || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;

    if (binding.actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 && proof.reviewedChild.role === 'preview.setup') {
        // Receipt enrollment reads the template selected by this Update. The
        // existing preparation owner retains native admission and operand scope.
        return await readDeploymentEnvironmentContentPreparationHttpPurpose(tx, binding,
            DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, proof, isHttpOperation) === true;
    }
    const admission = binding.deploymentLinkAdmission;
    if (!isDeploymentTargetLinkActionIdV1(binding.actionId) || !admission
        || proof.reviewedChild.role !== PLATFORM_FAILURE_SETUP_ROLE) return false;

    const artifactId = createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: admission });
    // Setup may open this job's Link, never another inventory member or the
    // Artifact grant/key-envelope transports available to Link preparation.
    const effect = proof.path === `/v1/artifacts/${encodeURIComponent(artifactId)}`
        ? binding.actionId : DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1;
    return await readDeploymentLinkPreparationHttpPurpose(tx, binding, effect, proof, isHttpOperation) === true;
}
