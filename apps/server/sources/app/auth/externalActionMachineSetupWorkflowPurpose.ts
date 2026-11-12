import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionTargetV1,
    ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isMachineSetupCombinedActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import type { WorkflowRunStorageOperation } from '@happier-dev/protocol/workflows/workflowRunStorageV1';

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
        || proof.method.toUpperCase() !== 'POST' || proof.path !== '/v3/automations/runs/workflow-storage'
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
