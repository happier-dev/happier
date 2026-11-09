import type { TriageFailureSubjectV1, TriageSessionHandoffInputV1 } from '@happier-dev/triage-protocol/v1';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { WorkflowFinalResultV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { InboxReadySessionResult } from '@/activity/presentation/buildInboxReadySessionResult';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';
import type { DeploymentReceiptHeaderV1, DeploymentEnvironmentHealthAggregateV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentEnvironmentHealthFeedV1 } from '@happier-dev/deployments';
import type { QualifiedActionOperation } from '../actionOperations/qualifiedActionOperation';
import type { DeploymentReceiptAcceptedResultV1 } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';

export type OperationsRunReceiptReference = Readonly<{
    serverId: string; environmentId: string; deploymentId: string; state: DeploymentReceiptHeaderV1['state'];
}>;

/** Historical, typed tool acknowledgements, never inferred from an agent's report. */
export type OperationsRunProducedResults = Readonly<{
    pullRequests: readonly ScmPullRequestSummary[];
    /** `status` is the request's own lifecycle when its Artifact is loaded; a transcript handle alone has none. */
    approvals: readonly Readonly<{ serverId: string; request: ActionApprovalRequestCreatedResult; status?: string }>[];
    operations: readonly QualifiedActionOperation[];
    pendingOperations: readonly NonNullable<Extract<DeploymentReceiptAcceptedResultV1, { kind: 'pending' }>['operation']>[];
    receipts: readonly OperationsRunReceiptReference[];
}>;

export const EMPTY_OPERATIONS_RUN_PRODUCED_RESULTS: OperationsRunProducedResults = Object.freeze({
    pullRequests: Object.freeze([]), approvals: Object.freeze([]), operations: Object.freeze([]), pendingOperations: Object.freeze([]), receipts: Object.freeze([]),
});

export type OperationsFailureSubject = TriageFailureSubjectV1
    | Extract<TriageSessionHandoffInputV1['context'], { kind: 'healthAlert' | 'entry' }>;

export type OperationsRunFinding =
    | Readonly<{
        kind: 'investigate'; session: ActionSessionAddressV1 | null; result: InboxReadySessionResult | null;
        messageRef?: SessionMessageRefV1 | null;
        evidence?: Readonly<{ subject: TriageFailureSubjectV1; message: SessionMessageRefV1 | null }>;
        nextAction?: Readonly<{ kind: 'continueSession'; session: ActionSessionAddressV1 }>;
    }>
    | Readonly<{ kind: 'workflow'; runId: string; result: WorkflowFinalResultV1 | null }>;

/** Already-opened result owners. No scan of Session text guesses a PR, effect or recovery. */
export type OperationsRunOutcomeInput = Readonly<{
    subject: OperationsFailureSubject;
    finding: OperationsRunFinding;
    produced?: OperationsRunProducedResults | null;
    pullRequest?: ScmPullRequestSummary | null;
    approval?: ActionApprovalRequestCreatedResult | null;
    operation?: QualifiedActionOperation | null;
    receipt?: DeploymentReceiptHeaderV1 | null;
    /** Original investigated receipt; appliedEffect.receipt may be a later remediation. */
    subjectReceipt?: DeploymentReceiptHeaderV1 | null;
    /** The already-mounted deployment controller's scope.serverId. */
    healthServerId?: string | null;
    health?: DeploymentEnvironmentHealthFeedV1 | null;
}>;

export type OperationsRunOutcome = Readonly<{
    finding: OperationsRunFinding;
    produced: OperationsRunProducedResults;
    proposal: Readonly<{
        pullRequest: ScmPullRequestSummary | null;
        approval: ActionApprovalRequestCreatedResult | null;
    }>;
    appliedEffect: Readonly<{
        operation: QualifiedActionOperation | null;
        receipt: DeploymentReceiptHeaderV1 | null;
        receiptReference: OperationsRunReceiptReference | null;
    }>;
    recovery: Readonly<{ kind: 'observed'; health: DeploymentEnvironmentHealthAggregateV1; coverage: DeploymentEnvironmentHealthFeedV1['status'] }>
        | Readonly<{ kind: 'service'; health: DeploymentEnvironmentHealthFeedV1['members'][number]['services'][number]; coverage: DeploymentEnvironmentHealthFeedV1['status'] }>
        | Readonly<{ kind: 'unavailable'; reason: 'health_unavailable' | 'subject_mismatch' }>;
}>;

export function projectOperationsRunOutcome(input: OperationsRunOutcomeInput): OperationsRunOutcome {
    const produced = input.produced ?? EMPTY_OPERATIONS_RUN_PRODUCED_RESULTS;
    return {
        finding: input.finding,
        produced,
        proposal: { pullRequest: input.pullRequest ?? produced.pullRequests.at(-1) ?? null,
            approval: input.approval ?? produced.approvals.at(-1)?.request ?? null },
        appliedEffect: {
            // Command execution is validation evidence, not a deployed effect.
            operation: input.operation ?? produced.operations.filter(operation => operation.snapshot.domainRef?.kind !== 'projectCommand').at(-1) ?? null,
            receipt: input.receipt ?? null,
            receiptReference: produced.receipts.at(-1) ?? null,
        },
        recovery: readRecovery(input),
    };
}

/** Correlate addresses only. The live health owner alone decides health/recovery. */
function readRecovery(input: OperationsRunOutcomeInput): OperationsRunOutcome['recovery'] {
    const feed = input.health;
    if (!feed || !input.healthServerId) return { kind: 'unavailable', reason: 'health_unavailable' };
    const subject = input.subject;
    const target = subject.kind === 'service' || subject.kind === 'healthAlert' ? subject.target : null;
    const serverId = subject.kind === 'managedMachineOperation' || subject.kind === 'backupRun' ? subject.operation.serverId
        : target ? 'page' in target && target.page === 'environment' ? target.environment.serverId : target.machine.serverId
            : subject.kind === 'deploymentReceipt' || subject.kind === 'domain' ? subject.serverId : null;
    if (input.healthServerId !== serverId) return { kind: 'unavailable', reason: 'subject_mismatch' };
    const environmentId = subject.kind === 'deploymentReceipt' ? subject.environmentId
        : target && 'page' in target && target.page === 'environment' ? target.environment.environmentId
        : target && 'page' in target && target.page === 'machine_service' && target.service.kind === 'deployment'
            ? target.service.environmentId : null;
    if (!environmentId) return { kind: 'unavailable', reason: 'health_unavailable' };
    if (feed.environmentId !== environmentId || feed.aggregate && feed.aggregate.environmentId !== environmentId)
        return { kind: 'unavailable', reason: 'subject_mismatch' };
    if (target && 'page' in target && target.page === 'machine_service') {
        const member = feed.members.find(member => member.machineId === target.machine.machineId);
        const service = member?.status === 'ready' ? member.services.find(service => service.serviceId === target.service.serviceId) : null;
        return service ? { kind: 'service', health: service, coverage: feed.status }
            : { kind: 'unavailable', reason: 'health_unavailable' };
    }
    const targetLinkId = target && 'page' in target && target.page === 'environment' ? target.targetLinkId
        : subject.kind === 'deploymentReceipt' && input.subjectReceipt?.id === subject.deploymentId
            && input.subjectReceipt.environmentId === subject.environmentId ? input.subjectReceipt.targetLinkId : null;
    if (!feed.aggregate || !targetLinkId) return { kind: 'unavailable', reason: 'health_unavailable' };
    if (feed.aggregate.targetLinkId !== targetLinkId) return { kind: 'unavailable', reason: 'subject_mismatch' };
    return { kind: 'observed', health: feed.aggregate, coverage: feed.status };
}
