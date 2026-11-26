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
): Promise<boolean> {
    const child = readDeploymentReviewedChildV1(binding, proof.reviewedChild, effectActionId, proof);
    if (child?.row.action !== 'plugin') return false;

    if (child.row.role === DEPLOYMENT_PREVIEW_SETUP_CHILD_ROLE_V1) {
        // Receipt enrollment reads the template selected by this Update. The
        // existing preparation owner retains native admission and operand scope.
        return await readDeploymentEnvironmentContentPreparationHttpPurpose(tx, binding,
            DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, proof, isHttpOperation) === true;
    }
    if (child.row.role !== PLATFORM_FAILURE_SETUP_ROLE) {
        // A teardown preview reads only what its teardown root may read itself.
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
