import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionTargetV1,
    ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isMachineSetupCombinedActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { deriveBackupReceiverSetupRunIdV1, deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import { isDeploymentBackupConfigureNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { db } from '@/storage/db';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH, type WorkflowRunStorageOperation } from '@happier-dev/protocol/workflows/workflowRunStorageV1';

const combinedSetupOperations = [
    'get', 'admit', 'wait', 'run-key.census', 'run-key.commit',
    'invocations.list', 'invocations.get', 'invocations.current',
] satisfies readonly WorkflowRunStorageOperation['operation'][];

/** The original Setup invocation spends storage authority only on its own combined Run. */
export function isMachineSetupCombinedRunHttpPurpose(verified: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    effectActionId: string;
    target: ExternalActionTargetV1;
    reviewedChildAdmission?: ReviewedActionChildHttpProofV1;
}>, proof: Readonly<{ method: string; path: string; body?: unknown }>): boolean {
    const { binding, reviewedChildAdmission } = verified;
    const rootActionId = reviewedChildAdmission?.actionId ?? binding.actionId;
    if (!isMachineSetupCombinedActionIdV1(verified.effectActionId)
        || !isMachineSetupCombinedActionIdV1(rootActionId) || rootActionId !== verified.effectActionId
        || verified.target.kind !== 'machine' || verified.target.machineId !== binding.machineId
        || proof.method.toUpperCase() !== 'POST' || proof.path !== WORKFLOW_RUN_STORAGE_HTTP_PATH
        || !proof.body || typeof proof.body !== 'object' || Array.isArray(proof.body)) return false;
    const body = proof.body as Readonly<Record<string, unknown>>;
    if (body.publisherMachineId !== binding.machineId
        || !combinedSetupOperations.some(operation => operation === body.operation)) return false;
    const runId = WorkflowRunIdV1Schema.safeParse(body.runId);
    // The storage route retains its full strict operation parser, publisher
    // signature, requester access and native admission after this purpose check.
    return runId.success && runId.data === deriveMachineSetupCombinedRunIdV1({
        actionId: rootActionId, homeId: binding.serverIdentityId, accountId: binding.accountId, requestId: binding.requestId,
        ...(reviewedChildAdmission ? { reviewedChild: reviewedChildAdmission } : {}),
    });
}


/** The receiver’s signed Setup Apply may open and observe its own Run on Home. */
export async function isBackupReceiverSetupRunHttpPurpose(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    child: ReviewedActionChildHttpProofV1,
    proof: Readonly<{ method: string; path: string; body?: unknown }>,
): Promise<boolean> {
    const admission = binding.deploymentNativeAdmission;
    if (!isDeploymentBackupConfigureNativeAdmissionV1(admission)
        || !admission.receiverMachineId || !admission.receiverInstallationId
        || proof.method !== 'POST' || proof.path !== WORKFLOW_RUN_STORAGE_HTTP_PATH
        || !proof.body || typeof proof.body !== 'object' || Array.isArray(proof.body)) return false;
    const body = proof.body as Readonly<Record<string, unknown>>;
    if (body.publisherMachineId !== admission.receiverMachineId) return false;
    const runId = deriveBackupReceiverSetupRunIdV1(binding, child);
    if (!runId || body.runId !== runId) return false;
    const hasExternalAudience = (value: object) =>
        ('sourceArtifactId' in value && value.sourceArtifactId != null) || ('visibleTeamId' in value && value.visibleTeamId != null);
    const originSessionId = binding.sessionActionOrigin?.caller.sessionId;
    let canOpenRun = false;
    switch (body.operation) {
        case 'admit': {
            const origin = body.origin;
            if (body.machineId !== admission.receiverMachineId || hasExternalAudience(body)
                || body.managedCreation !== undefined || body.discussionRoundPattern !== undefined || body.discussionTargetSessionIds !== undefined
                || !origin || typeof origin !== 'object' || !('kind' in origin) || origin.kind !== 'direct' || 'discussion' in origin
                || ('originSessionId' in origin && origin.originSessionId !== originSessionId)
                || (body.resultDelivery !== undefined && (!('originSessionId' in origin) || !originSessionId))) return false;
            canOpenRun = true;
            break;
        }
        case 'get':
            if (body.prepareAdmission && typeof body.prepareAdmission === 'object' && hasExternalAudience(body.prepareAdmission)) return false;
            canOpenRun = true;
            break;
        case 'run-key.census':
            if (hasExternalAudience(body)) return false;
            canOpenRun = true;
            break;
        case 'wait':
        case 'run-key.commit':
        case 'invocations.list':
            break;
        default:
            return false;
    }
    // This address is derived from the admitted root and exact child. Once
    // present, the Run must also retain that Account and installed assignment.
    const run = await db.automationRun.findUnique({ where: { id: runId }, select: {
        accountId: true, originKind: true, originSessionId: true, originDiscussionId: true, managedCreationId: true,
        sourceArtifactId: true, visibleTeamId: true, workflowCustodyState: true,
        assignments: { where: { machineId: admission.receiverMachineId }, select: { admittedMachineInstallationId: true } },
    } });
    if (!run) return canOpenRun;
    return run.accountId === binding.accountId && run.originKind === 'direct' && run.workflowCustodyState !== null
        && (run.originSessionId === null || run.originSessionId === originSessionId)
        && run.originDiscussionId === null && run.managedCreationId === null
        && run.sourceArtifactId === null && run.visibleTeamId === null
        && run.assignments[0]?.admittedMachineInstallationId === admission.receiverInstallationId;
}
