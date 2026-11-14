import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationCompletionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { WaitActionResultV1Schema } from '@happier-dev/protocol/actions/specs/wait';
import { ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { DeploymentReceiptAcceptedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';
import { isDeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { OperationsRunProducedResults } from '@/sync/domains/workflows/operationsRunOutcome';
import { actionOperationAddressKey, type QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { isRecord, readHappierActionCallId, readHappierActionCallInput, readHappierActionToolResultCandidates } from './happierActionToolResult';

/** The loaded, addressed transcript is evidence of produced handles, never an authority on recovery.
 * Reuse the Action envelope reader and output schemas; prose and compose-only PR responses name none. */
export function readTranscriptOperationsProducedResults(messages: readonly Message[], sessionServerId: string): OperationsRunProducedResults {
    const pullRequests = new Map<string, OperationsRunProducedResults['pullRequests'][number]>();
    const approvals = new Map<string, OperationsRunProducedResults['approvals'][number]>();
    const operations = new Map<string, QualifiedActionOperation>();
    const pendingOperations = new Map<string, OperationsRunProducedResults['pendingOperations'][number]>();
    const receipts = new Map<string, OperationsRunProducedResults['receipts'][number]>();
    const putOperation = (operation: QualifiedActionOperation) => {
        const key = actionOperationAddressKey({ serverId: operation.serverId, operationId: operation.snapshot.operationId });
        const previous = operations.get(key);
        if (!previous || previous.snapshot.revision < operation.snapshot.revision) operations.set(key, operation);
        pendingOperations.delete(key);
    };
    const readTool = (tool: ToolCall) => {
        if (tool.state !== 'completed') return;
        const actionId = readHappierActionCallId(tool.name, tool.input);
        if (!actionId) return;
        const input = readHappierActionCallInput(tool.name, tool.input);
        const serverId = isRecord(input) && typeof input.serverId === 'string' && input.serverId.trim() ? input.serverId : sessionServerId;
        for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
            for (const value of [candidate, isRecord(candidate) && candidate.ok === true ? candidate.result : undefined]) {
                const approval = ActionApprovalRequestCreatedResultSchema.safeParse(value);
                if (approval.success) approvals.set(JSON.stringify([serverId, approval.data.artifactId]), { serverId, request: approval.data });
                if (actionId === 'scm.pullRequest.openOrReuse') {
                    const parsed = ScmPullRequestOpenOrReuseResponseSchema.safeParse(value);
                    if (parsed.success && parsed.data.success && parsed.data.pullRequest)
                        pullRequests.set(parsed.data.pullRequest.url, parsed.data.pullRequest);
                }
                if (isDeploymentActionIdV1(actionId)) {
                    const parsed = DeploymentReceiptAcceptedResultV1Schema.safeParse(value);
                    if (parsed.success && 'deploymentId' in parsed.data) {
                        const receipt = { serverId, environmentId: parsed.data.environmentId,
                            deploymentId: parsed.data.deploymentId, state: parsed.data.state };
                        receipts.set(JSON.stringify([serverId, receipt.environmentId, receipt.deploymentId]), receipt);
                    } else if (parsed.success && 'operation' in parsed.data && parsed.data.operation) {
                        const operation = parsed.data.operation;
                        const key = actionOperationAddressKey(operation);
                        if (!operations.has(key)) pendingOperations.set(key, operation);
                    }
                }
                const completion = ActionOperationCompletionOutputV1Schema.safeParse(value);
                if (completion.success) {
                    const snapshot = completion.data.operation;
                    const ref = snapshot.domainRef;
                    putOperation({ serverId: ref && 'serverId' in ref ? ref.serverId : serverId, snapshot });
                }
                if (actionId === 'wait') {
                    const wait = WaitActionResultV1Schema.safeParse(value);
                    if (!wait.success || wait.data.disposition !== 'matched' || wait.data.target.kind !== 'action_operation') continue;
                    const snapshot = ActionOperationSnapshotV1Schema.safeParse(wait.data.snapshot);
                    if (snapshot.success && snapshot.data.operationId === wait.data.target.operationId
                        && snapshot.data.scope.machineId === wait.data.target.machineId)
                        putOperation({ serverId: wait.data.target.serverId, snapshot: snapshot.data });
                }
            }
        }
    };
    const visit = (message: Message) => {
        if (message.kind !== 'tool-call') return;
        readTool(message.tool);
        for (const child of message.children) visit(child);
    };
    for (const message of messages) visit(message);
    return { pullRequests: [...pullRequests.values()], approvals: [...approvals.values()],
        operations: [...operations.values()], pendingOperations: [...pendingOperations.values()], receipts: [...receipts.values()] };
}
