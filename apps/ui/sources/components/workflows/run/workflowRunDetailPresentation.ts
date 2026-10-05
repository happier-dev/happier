import type {
    WorkflowAuthoredInputV1,
    WorkflowInvocationRecoveryV1,
    WorkflowProgressEnvelopeV1,
    WorkflowInvocationLifecycleV1,
    WorkflowInvocationRecoveryAvailabilityV1,
    WorkflowRunInvocationIndexV1,
    WorkflowRunStateV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol';

import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import {
    isTerminalWorkflowRunState,
    type WorkflowRunCoverage,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';

/**
 * Managed Run-detail presentation.
 *
 * Parent Run state and per-invocation lifecycle are two different closed
 * contracts and are mapped separately here; they are never flattened into one
 * guessed enum. Nothing in this module decides a lifecycle: every value comes
 * from the canonical server projection, and the only composition performed is
 * the outcome sentence, which reads real child coverage.
 */

/**
 * Whether Run detail may expose the exact-input Reattach operation.
 *
 * The authorized Action already opened the private row and owns this decision;
 * presentation consumes its typed answer and never re-derives eligibility.
 */
export function canOfferWorkflowInvocationReattach(params: Readonly<{
    run: WorkflowRunSummaryV1;
    invocation: WorkflowRunInvocationIndexV1 | null;
    progress: WorkflowProgressEnvelopeV1 | null;
    recoveryAvailability?: WorkflowInvocationRecoveryAvailabilityV1 | null;
}>): boolean {
    return params.recoveryAvailability?.reattach.kind === 'available';
}

const POSSIBLY_ACTIVE_INVOCATION_LIFECYCLES: ReadonlySet<WorkflowInvocationLifecycleV1> = new Set([
    'admitting',
    'running',
    'waiting_for_approval',
    'needs_attention',
    'cancel_requested',
    'outcome_uncertain',
]);

const WORKSPACE_UNAVAILABLE_REASON_CODES: ReadonlySet<string> = new Set([
    'conversation_workspace_mismatch',
    'source_workspace_unavailable',
    'committed_revision_unavailable',
    'workspace_unavailable',
    'workspace_conflict',
    'scm_unavailable',
]);

/**
 * Every reason code that means the recorded workspace cannot be used as it
 * stands. They differ in cause, not in what the person can do next, so they all
 * reach the same offer instead of five of them dead-ending in a warning.
 */
export function isWorkflowWorkspaceUnavailableReason(code: string | undefined): code is string {
    return code !== undefined && WORKSPACE_UNAVAILABLE_REASON_CODES.has(code);
}

/**
 * One reviewed continuation: which conversation it uses and the complete
 * authored input the person accepted. `document` is the prepared objective
 * unless they edited it; resolved context remains the exact recorded values.
 */
export type WorkflowRecoveryContinuation = Readonly<{
    conversation: 'same_conversation' | 'fresh_agent';
    document: WorkflowAuthoredInputV1['document'];
    input: WorkflowAuthoredInputV1['input'];
}>;

/**
 * Whether this exact attempt's prior effects are unknown.
 *
 * `outcome_uncertain` means the input stopped before reporting, so the
 * workspace may already have changed. Continuation and retry are refused until
 * the person acknowledges that for this attempt; the acknowledgement is never
 * implied, inherited from a sibling, or remembered across selections.
 */
export function requiresUncertainPriorEffectsAcknowledgement(params: Readonly<{
    invocation: WorkflowRunInvocationIndexV1 | null;
    progress: WorkflowProgressEnvelopeV1 | null;
}>): boolean {
    return params.invocation?.lifecycle === 'outcome_uncertain'
        || params.progress?.reason?.code === 'outcome_uncertain'
        || params.progress?.uncertainPriorEffects?.activity === 'stopped';
}

export type WorkflowInvocationWorkspacePresentation = Readonly<{
    directory: string;
    displayDirectory: string;
    checkoutRootPath: string;
    displayCheckoutRootPath: string;
    workspaceRefId: string | null;
    branchName: string | null;
    sourceBlockId: string | null;
    sourceInvocationRecordId: string | null;
}>;

export type WorkflowInvocationRecoveryPresentation = Readonly<{
    canInspectExecution: boolean;
    canReattach: boolean;
    canRetrySameConversation: boolean;
    canRetryFreshAgent: boolean;
    /** Exact parent-before-child causal closure reviewed for the retry mutation. */
    retryCausalInvocationIds: readonly string[];
    /** Typed owner reasons retained for non-visual consumers and future copy projection. */
    unavailableReasons: Readonly<{
        reattach: Exclude<WorkflowInvocationRecoveryAvailabilityV1['reattach'], { kind: 'available' }>['reason'] | null;
        retry: Exclude<WorkflowInvocationRecoveryAvailabilityV1['retry'], { kind: 'available' }>['reason'] | null;
        continueSameConversation: Exclude<WorkflowInvocationRecoveryAvailabilityV1['continueSameConversation'], { kind: 'available' }>['reason'] | null;
        continueFreshAgent: Exclude<WorkflowInvocationRecoveryAvailabilityV1['continueFreshAgent'], { kind: 'available' }>['reason'] | null;
    }>;
    /** The execution owner prepared a continuation this attempt can accept. */
    canContinuePrepared: boolean;
    canRestoreWorkspace: boolean;
    /**
     * D4's second arm, and only its second arm.
     *
     * Restoring resumes this Run and keeps every completed result; a reviewed
     * new whole Run repeats them. They are therefore mutually exclusive by
     * construction here rather than by each screen remembering to hide one:
     * offering both asked the person to choose between recovering and
     * repeating without saying one was strictly better.
     */
    canStartReviewedNewRun: boolean;
    /** A reviewed new Run, never a retry of the sealed step. */
    canRunWithAnotherAgent: boolean;
    preparedRecovery: WorkflowInvocationRecoveryV1 | null;
    /** Continuation and retry stay refused until this exact attempt is acknowledged. */
    requiresUncertaintyAcknowledgement: boolean;
    waitingForStop: boolean;
    remainingNotStartedSiblingCount: number | null;
    workspaceUnavailable: boolean;
    workspace: WorkflowInvocationWorkspacePresentation | null;
}>;

export function formatWorkflowWorkspaceSourceLabel(
    blockLabel: string,
    invocationRecordId: string | null,
): string {
    return invocationRecordId === null
        ? blockLabel
        : `${blockLabel} · ${invocationRecordId}`;
}

/**
 * Fail-closed Run-detail recovery projection for one exact selected row.
 *
 * The exact Action response is the only availability decision. This projector
 * formats its answer with workspace/custody evidence but does not override it;
 * mutations still revalidate on submission.
 */
export function projectWorkflowInvocationRecovery(params: Readonly<{
    run: WorkflowRunSummaryV1;
    invocation: WorkflowRunInvocationIndexV1 | null;
    progress: WorkflowProgressEnvelopeV1 | null;
    machineHomeDirectory: string | null;
    invocations?: readonly WorkflowRunInvocationIndexV1[];
    invocationHistoryComplete?: boolean;
    recoveryAvailability?: WorkflowInvocationRecoveryAvailabilityV1 | null;
}>): WorkflowInvocationRecoveryPresentation {
    const workspaceUnavailable = params.progress?.reason?.code !== undefined
        && WORKSPACE_UNAVAILABLE_REASON_CODES.has(params.progress.reason.code);
    const descriptor = params.progress?.workspace?.descriptor;
    const workspace = descriptor === undefined
        ? null
        : {
            directory: descriptor.directory,
            displayDirectory: formatPathRelativeToHome(
                descriptor.directory,
                params.machineHomeDirectory ?? undefined,
            ),
            checkoutRootPath: descriptor.checkoutRootPath,
            displayCheckoutRootPath: formatPathRelativeToHome(
                descriptor.checkoutRootPath,
                params.machineHomeDirectory ?? undefined,
            ),
            workspaceRefId: descriptor.workspaceRefId ?? null,
            branchName: descriptor.checkout?.branchName ?? null,
            sourceBlockId: descriptor.sourceInvocation?.producer.blockId ?? null,
            sourceInvocationRecordId: descriptor.sourceInvocation?.invocationRecordId ?? null,
        } satisfies WorkflowInvocationWorkspacePresentation;
    const invocation = params.invocation;
    const retryable = params.recoveryAvailability?.retry.kind === 'available';
    const retryCausalInvocationIds = params.recoveryAvailability?.retry.kind === 'available'
        ? params.recoveryAvailability.retry.causalInvocationIds
        : [];
    const waitingForStop = params.run.workflowCustodyState === 'pending'
        && (
            workspaceUnavailable
            || (invocation !== null
                && POSSIBLY_ACTIVE_INVOCATION_LIFECYCLES.has(invocation.lifecycle)
                && (invocation.lifecycle === 'cancel_requested' || invocation.lifecycle === 'outcome_uncertain'))
        );
    const remainingNotStartedSiblingCount = invocation === null
        || params.invocationHistoryComplete !== true
        ? null
        : (params.invocations ?? []).filter((candidate) => (
            candidate.id !== invocation.id
            && candidate.parentRecordId === invocation.parentRecordId
            && (candidate.lifecycle === 'pending' || candidate.lifecycle === 'waiting_for_capacity')
        )).length;

    const preparedConversation = params.progress?.recovery?.conversation;
    const canContinuePrepared = preparedConversation === 'same_conversation'
        ? params.recoveryAvailability?.continueSameConversation.kind === 'available'
        : preparedConversation === 'fresh_agent'
            && params.recoveryAvailability?.continueFreshAgent.kind === 'available';

    const canRestoreWorkspace = params.recoveryAvailability?.restoreWorkspace.kind === 'available';

    return {
        canInspectExecution: params.run.availability.inspectExecution
            && params.progress?.execution !== undefined,
        canReattach: canOfferWorkflowInvocationReattach(params),
        // Retry and the selected conversation must both be eligible. The
        // authoring composer consumes these same exact choices for replacement input.
        canRetrySameConversation: retryable
            && params.recoveryAvailability?.continueSameConversation.kind === 'available',
        canRetryFreshAgent: retryable
            && params.recoveryAvailability?.continueFreshAgent.kind === 'available',
        retryCausalInvocationIds,
        unavailableReasons: {
            reattach: params.recoveryAvailability?.reattach.kind === 'unavailable'
                ? params.recoveryAvailability.reattach.reason : null,
            retry: params.recoveryAvailability?.retry.kind === 'unavailable'
                ? params.recoveryAvailability.retry.reason : null,
            continueSameConversation: params.recoveryAvailability?.continueSameConversation.kind === 'unavailable'
                ? params.recoveryAvailability.continueSameConversation.reason : null,
            continueFreshAgent: params.recoveryAvailability?.continueFreshAgent.kind === 'unavailable'
                ? params.recoveryAvailability.continueFreshAgent.reason : null,
        },
        canContinuePrepared,
        canRestoreWorkspace,
        // Every workspace-unavailable cause reaches the same pair of offers, and
        // the reviewed new Run is the strictly worse one: it is offered only
        // when this Run cannot be restored at all, and never while the previous
        // input may still be running — no acknowledgement starts replacement
        // work while `workflow_outcome_unresolved` stands.
        canStartReviewedNewRun: workspaceUnavailable && !canRestoreWorkspace && !waitingForStop,
        canRunWithAnotherAgent: params.progress?.reason?.code === 'target_unavailable'
            && params.progress.blockKind === 'step'
            && (invocation?.lifecycle === 'failed' || invocation?.lifecycle === 'blocked')
            && params.run.workflowCustodyState === 'settled',
        preparedRecovery: params.progress?.recovery ?? null,
        requiresUncertaintyAcknowledgement: requiresUncertainPriorEffectsAcknowledgement(params),
        waitingForStop,
        remainingNotStartedSiblingCount,
        workspaceUnavailable,
        workspace,
    };
}

export function formatWorkflowRunStateLabel(state: WorkflowRunStateV1): string {
    return t(`workflows.runState.${state}`);
}

/**
 * Where a Run came from. A direct Run's originating Session is provenance only:
 * its absence never makes the Run unavailable.
 */
export function formatWorkflowRunOriginLabel(origin: WorkflowRunSummaryV1['origin']): string {
    if (origin.kind === 'automation') return t('workflows.run.origin.automation');
    return origin.originSessionId
        ? t('workflows.run.origin.fromSession')
        : t('workflows.run.origin.direct');
}

/**
 * The outcome sentence.
 *
 * A `succeeded` Run whose loaded children include failures reads **Done with
 * failures**, which is a composition of real children rather than a second
 * terminal state. A nonterminal Run states what it is waiting on instead of
 * claiming a result.
 */
/**
 * The first loaded item that needs the person, named by its authored step. A
 * Wait-for-you step is waiting for *you*; every other hold is waiting for your
 * review (07 §6.1, §6.2).
 */
export type WorkflowRunAttentionLead = Readonly<{ step: string; waitForYou: boolean }>;

export function formatWorkflowRunOutcomeSentence(params: Readonly<{
    run: WorkflowRunSummaryV1;
    coverage: WorkflowRunCoverage;
    historyComplete?: boolean;
    attention?: WorkflowRunAttentionLead | null;
    /**
     * The Run's exact Machine as the machine owner currently sees it. An active
     * Run whose Machine is known unreachable says it lost contact — no more:
     * whether its work survived is the recovery owner's fact, not this one's.
     */
    machine?: Readonly<{ name: string; reachable: boolean }>;
}>): string {
    const { run, coverage } = params;
    if (params.machine?.reachable === false && !isTerminalWorkflowRunState(run.state)) {
        return t('workflows.run.machineUnavailable', { machine: params.machine.name });
    }
    if (run.state === 'succeeded') {
        // A loaded page is not necessarily complete history. Until the cursor is
        // exhausted, neither the success count nor the absence of failures is
        // authoritative, so keep terminal copy deliberately neutral.
        if (params.historyComplete === false || coverage.coverage === 'partial') {
            return coverage.knownFailure ? t('workflows.runState.completed_with_failures') : formatWorkflowRunStateLabel(run.state);
        }
        const counts = coverage.observedLeafCounts;
        if (coverage.knownFailure && counts.failed === 0) return t('workflows.runState.completed_with_failures');
        return counts.failed > 0
            ? t('workflows.run.completedWithFailures', {
                completed: counts.completed,
                failed: counts.failed,
            })
            : t('workflows.run.completedCount', { count: counts.completed });
    }
    if (params.attention && (run.state === 'running' || run.state === 'waiting_for_review')) {
        return params.attention.waitForYou
            ? t('workflows.run.attentionWaitSentence', { step: params.attention.step })
            : t('workflows.run.attentionReviewSentence', { step: params.attention.step });
    }
    if (run.state === 'pause_requested') return t('workflows.run.pausePending');
    if (run.state === 'paused') return t('workflows.run.paused');
    return formatWorkflowRunStateLabel(run.state);
}

/**
 * Why a selected invocation is waiting or was skipped, stated from its
 * canonical facts only — its public lifecycle and the coordinator's closed
 * reason code. A cause those facts do not establish is not stated, so a row
 * never reads as waiting on something the runtime did not report.
 */
export function describeWorkflowInvocationCause(params: Readonly<{
    lifecycle: WorkflowInvocationLifecycleV1 | null;
    reasonCode: string | null;
    /** The invocation's authored block label, resolved against the frozen definition. */
    blockLabel: string | null;
}>): string | null {
    if (params.lifecycle === 'waiting_for_capacity') return t('workflows.run.capacityOccupied');
    if (params.lifecycle === 'skipped' && params.reasonCode === 'condition_false' && params.blockLabel !== null) {
        return t('workflows.condition.skippedReason', { block: params.blockLabel });
    }
    return null;
}

/**
 * The label shown on the Run's status pill: the terminal composition when the
 * children warrant it, otherwise the canonical state label.
 */
export function formatWorkflowRunOutcomeLabel(params: Readonly<{
    state: WorkflowRunStateV1;
    coverage: WorkflowRunCoverage;
    historyComplete?: boolean;
    /**
     * True when every loaded item the parked Run waits on is a Wait-for-you
     * step: the Run is then waiting for you, not for your review.
     */
    waitingOnlyForYou?: boolean;
}>): string {
    if (params.state === 'succeeded' && params.coverage.knownFailure) {
        return t('workflows.runState.completed_with_failures');
    }
    if (params.state === 'waiting_for_review' && params.waitingOnlyForYou === true) {
        return t('workflows.review.waitTitle');
    }
    return formatWorkflowRunStateLabel(params.state);
}

/**
 * Run detail says its status once, as the first words of the outcome line
 * (07 §3, §6.1): "{word} — {sentence}". A sentence that already opens with the
 * word ("Completed. 3 items completed.") is the line on its own.
 */
export function formatWorkflowRunOutcomeLine(params: Readonly<{ word: string; sentence: string }>): string {
    return params.sentence.startsWith(params.word)
        ? params.sentence
        : t('workflows.run.outcomeLine', { word: params.word, sentence: params.sentence });
}

/**
 * Whether this mounted detail instance just watched the Run transition from a
 * nonterminal state to authoritative success.
 *
 * The completion moment is keyed to that observed transition, not to a refresh
 * or a remount, so re-entering a finished Run never replays it and no "already
 * played" state has to be persisted.
 */
export function isObservedCompletionTransition(params: Readonly<{
    previousState: WorkflowRunStateV1 | null;
    nextState: WorkflowRunStateV1;
}>): boolean {
    if (params.previousState === null) return false;
    if (isTerminalWorkflowRunState(params.previousState)) return false;
    return params.nextState === 'succeeded';
}
