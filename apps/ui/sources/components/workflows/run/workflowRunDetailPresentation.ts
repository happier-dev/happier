import type {
    WorkflowAuthoredInputV1,
    WorkflowDefinitionV1,
    WorkflowInvocationRecoveryV1,
    WorkflowProgressEnvelopeV1,
    WorkflowInvocationLifecycleV1,
    WorkflowInvocationRecoveryAvailabilityV1,
    WorkflowRunInvocationIndexV1,
    WorkflowRunStateV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol';

import type { TranslationKeyNoParams } from '@/text/i18n';
import { t } from '@/text';
import { formatWorkflowConversationProblem } from '@/components/workflows/presentation/workflowProblemPresentation';
import type { WorkflowInvocationStructureEntry } from './workflowInvocationStructure';
import { findWorkflowBlock, findWorkflowBlockListRef, getWorkflowBlockList } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { presentSessionRuntimeIssue } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { WorkflowFlowProjection } from '../flow/workflowFlowProjection';
import {
    describeWorkflowRunState,
    isTerminalWorkflowRunState,
    isWorkflowRunStopPending,
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
    /** Opened owner evidence, without attributing a workspace/admission refusal to the Agent. */
    failureCause?: Readonly<{
        kind: 'reported_failure';
        blockKind: WorkflowProgressEnvelopeV1['blockKind'];
        code: string;
        /** The message as its producer recorded it; step detail keeps it under Technical details. */
        message: string | null;
        /** What the cause line and the recovery card say: a known transport code in words, else the message. */
        headline: string | null;
        /** Source-owned sanitized issue, including the reported usage-limit resetAtMs. */
        runtimeIssue?: SessionRuntimeIssueV1 | null;
        reset?: string | null;
        at: string | null;
    }> | Readonly<{ kind: 'cause_not_recorded' }> | null;
    /** Connectivity is separate from the recorded failure and exact recovery eligibility. */
    unavailableMachine?: Readonly<{ name: string; lastSeenAt: number | null }> | null;
    canInspectExecution: boolean;
    canReattach: boolean;
    canRetrySameConversation: boolean;
    canRetryFreshAgent: boolean;
    /**
     * Repeat an Action or a structural frame (root, If, loop, parallel, workflow) with its original input.
     * Only an Agent step has a conversation to continue, so it keeps the two choices above instead.
     */
    canRetry: boolean;
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
    machine?: Readonly<{ name: string; reachable: boolean; lastSeenAt?: number | null }>;
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
    const lastSeenAt = params.machine?.lastSeenAt;
    const unavailableMachine = params.machine?.reachable === false
        ? { name: params.machine.name, lastSeenAt: typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) && lastSeenAt > 0
            ? lastSeenAt : null } : null;
    const failed = invocation?.lifecycle === 'failed' || invocation?.lifecycle === 'needs_attention'
        || invocation?.lifecycle === 'outcome_uncertain';
    const issue = presentSessionRuntimeIssue(failed ? params.progress?.reason?.runtimeIssueV1 : undefined);
    const reportedMessage = issue.message ?? params.progress?.reason?.message ?? null;
    const failureCause: WorkflowInvocationRecoveryPresentation['failureCause'] = failed && params.progress?.reason
        ? { kind: 'reported_failure', blockKind: params.progress.blockKind, code: params.progress.reason.code,
            message: reportedMessage,
            headline: issue.message ?? describeRecordedTransportFailure(params.progress.reason.code) ?? reportedMessage,
            reset: issue.reset,
            runtimeIssue: params.progress.reason.runtimeIssueV1 ?? null,
            at: params.progress.timing?.finishedAt ?? null }
        : invocation?.lifecycle === 'failed'
            ? { kind: 'cause_not_recorded' }
            : null;

    return {
        failureCause,
        unavailableMachine,
        canInspectExecution: params.run.availability.inspectExecution
            && params.progress?.execution !== undefined,
        canReattach: canOfferWorkflowInvocationReattach(params),
        // Retry and the selected conversation must both be eligible. The
        // authoring composer consumes these same exact choices for replacement input.
        canRetrySameConversation: retryable
            && params.recoveryAvailability?.continueSameConversation.kind === 'available',
        canRetryFreshAgent: retryable
            && params.recoveryAvailability?.continueFreshAgent.kind === 'available',
        canRetry: retryable && params.progress != null && params.progress.blockKind !== 'step',
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
            && invocation?.lifecycle === 'failed'
            && params.run.workflowCustodyState === 'settled',
        preparedRecovery: params.progress?.recovery ?? null,
        requiresUncertaintyAcknowledgement: requiresUncertainPriorEffectsAcknowledgement(params),
        waitingForStop,
        remainingNotStartedSiblingCount,
        workspaceUnavailable,
        workspace,
    };
}

/**
 * A step's execution can fail on a transport error whose only record is the Node/HTTP client code and its
 * raw sentence ("timeout of 30000ms exceeded"). These codes are a closed, well-known set, so the person
 * reads what happened between the step and its Agent; the raw text stays in Technical details.
 */
const RECORDED_TRANSPORT_FAILURE_KEYS = {
    ECONNABORTED: 'workflows.recovery.agentTimedOut',
    ETIMEDOUT: 'workflows.recovery.agentTimedOut',
    ECONNREFUSED: 'workflows.recovery.agentUnreachable',
    ENOTFOUND: 'workflows.recovery.agentUnreachable',
    EAI_AGAIN: 'workflows.recovery.agentUnreachable',
    EHOSTUNREACH: 'workflows.recovery.agentUnreachable',
    ECONNRESET: 'workflows.recovery.agentConnectionLost',
    EPIPE: 'workflows.recovery.agentConnectionLost',
} as const satisfies Readonly<Record<string, TranslationKeyNoParams>>;

function describeRecordedTransportFailure(code: string): string | null {
    const key = Object.hasOwn(RECORDED_TRANSPORT_FAILURE_KEYS, code)
        ? RECORDED_TRANSPORT_FAILURE_KEYS[code as keyof typeof RECORDED_TRANSPORT_FAILURE_KEYS] : undefined;
    return key === undefined ? null : t(key);
}

/** The page and its exact failure inspector consume one cause/recovery projection. */
export type WorkflowRunFailurePresentation = Readonly<{
    invocationId: string;
    /** A structural Run failure does not turn a completed child into a failed step. */
    step: Readonly<{ name: string; ordinal: string | null }> | null;
    recovery: WorkflowInvocationRecoveryPresentation;
}>;

/**
 * Why a Run failed, as the one quiet line under its outcome: the failed step's ordinal (the number
 * its Map row carries), the recorded failure and any reported usage-limit reset.
 * Current connectivity never supplies historical cause, even when its timestamp precedes failure.
 */
export function formatWorkflowRunFailureCauseLine(
    failure: WorkflowRunFailurePresentation,
): string | null {
    const cause = failure.recovery.failureCause ?? null;
    const headline = cause?.kind === 'reported_failure' ? cause.headline
        : cause?.kind === 'cause_not_recorded' ? t('workflows.recovery.causeNotRecorded') : null;
    if (headline === null || headline === undefined || headline === '') return null;
    const reset = cause?.kind === 'reported_failure' ? cause.reset ?? null : null;
    const ordinal = failure.step?.ordinal ?? null;
    return [ordinal === null ? null : t('workflows.run.stepNumber', { ordinal }), headline, reset]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · ');
}

/** Prefer the known failed work to its aggregate frame; never blame a completed child. */
export function selectWorkflowRunFailureInvocation(params: Readonly<{
    invocations: readonly WorkflowRunInvocationIndexV1[];
    firstFailedInvocationId: string | null;
    structure: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
}>): WorkflowRunInvocationIndexV1 | null {
    const first = params.invocations.find(row => row.id === params.firstFailedInvocationId && row.lifecycle === 'failed');
    // Empty or off-page discovery is not permission to substitute an unrelated loaded failure.
    if (!first) return null;
    if (params.structure.get(first.id)?.isFrame !== true) return first;
    return params.invocations.find(row => row.lifecycle === 'failed' && params.structure.get(row.id)?.coverageKind === 'executable')
        ?? first;
}

export function projectWorkflowRunFailure(params: Parameters<typeof projectWorkflowInvocationRecovery>[0] & Readonly<{
    structure: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
    projection: WorkflowFlowProjection | null;
}>): WorkflowRunFailurePresentation | null {
    const invocation = params.invocation;
    if (invocation === null || invocation.runId !== params.run.id
        || (invocation.lifecycle !== 'failed' && invocation.lifecycle !== 'needs_attention'
            && invocation.lifecycle !== 'outcome_uncertain' && invocation.lifecycle !== 'waiting_for_review'
            && invocation.lifecycle !== 'waiting_for_approval')) return null;
    const entry = params.structure.get(invocation.id);
    const node = entry?.nodeId == null ? null : params.projection?.nodesById.get(entry.nodeId);
    return {
        invocationId: invocation.id,
        step: !entry?.isFrame && node ? { name: node.label, ordinal: node.stepOrdinal ?? null } : null,
        recovery: projectWorkflowInvocationRecovery(params),
    };
}

export function formatWorkflowRunStateLabel(state: WorkflowRunStateV1): string {
    return describeWorkflowRunState(state).label;
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

/** The quiet second outcome line, derived from frozen structure and exact live rows. */
export function formatWorkflowRunConsequenceSentence(params: Readonly<{
    run: WorkflowRunSummaryV1;
    definition: WorkflowDefinitionV1 | null;
    frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
    invocations: readonly WorkflowRunInvocationIndexV1[];
    structure: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
    historyComplete?: boolean;
    machineReachable?: boolean;
}>): string | null {
    if (!params.definition || params.machineReachable === false
        || (params.run.state !== 'running' && params.run.state !== 'claimed')) return null;
    // Select current physical attempts before looking at lane states. A prior held/failed attempt
    // is history, and cannot make a successfully retried lane appear blocked again.
    const currentBySlot = new Map<string, WorkflowRunInvocationIndexV1>();
    for (const row of params.invocations) {
        const slot = `${row.parentRecordId}:${row.memberOrdinal}`;
        const prior = currentBySlot.get(slot);
        if (!prior || BigInt(row.attempt) > BigInt(prior.attempt)) currentBySlot.set(slot, row);
    }
    const rows = [...currentBySlot.values()].filter(row => row.lifecycle !== 'superseded');
    const children = new Map<string, WorkflowRunInvocationIndexV1[]>();
    for (const row of rows) {
        if (row.parentRecordId === null) continue;
        const siblings = children.get(row.parentRecordId) ?? [];
        siblings.push(row);
        children.set(row.parentRecordId, siblings);
    }
    for (const row of rows) {
        const entry = params.structure.get(row.id);
        if (!entry?.blockId || entry.isFrame || row.lifecycle !== 'running') continue;
        let definition: WorkflowDefinitionV1 | undefined = params.definition;
        for (const coordinate of entry.occurrence) {
            if (coordinate.kind !== 'workflow' || !definition) continue;
            const call = findWorkflowBlock({ ...definition, name: '' }, coordinate.blockId);
            definition = call?.kind === 'workflow' ? params.frozenChildren?.[call.workflowRef] : undefined;
        }
        if (!definition) continue;
        const draft = { ...definition, name: '' };
        const block = findWorkflowBlock(draft, entry.blockId);
        if (block?.kind !== 'parallel') continue;
        const branchFrames = children.get(row.id) ?? [];
        const runningLanes: string[] = [];
        let intervention = false;
        let failure = false;
        let unresolved = false;
        for (const [ordinal, branch] of block.branches.entries()) {
            const frame = branchFrames.find(candidate => candidate.memberOrdinal === String(ordinal));
            if (!frame) continue;
            const descendants = [frame];
            let live = false;
            for (let index = 0; index < descendants.length; index += 1) {
                const descendant = descendants[index]!;
                const lifecycle = descendant.lifecycle;
                intervention ||= lifecycle === 'waiting_for_review' || lifecycle === 'waiting_for_approval' || lifecycle === 'needs_attention';
                failure ||= lifecycle === 'failed';
                unresolved ||= lifecycle === 'cancel_requested' || lifecycle === 'cancelled' || lifecycle === 'outcome_uncertain';
                live ||= params.structure.get(descendant.id)?.coverageKind === 'executable'
                    && (lifecycle === 'running' || lifecycle === 'admitting');
                descendants.push(...(children.get(descendant.id) ?? []));
            }
            if (live) runningLanes.push(branch.name?.trim() || t('workflows.page.inspector.lane', { position: ordinal + 1 }));
        }
        // A fail-stop join will not release its successor after a failed lane. Unknown effects and
        // stop requests also do not support a promise about what will run next.
        if (!runningLanes.length || (!intervention && !failure) || unresolved
            || (failure && block.failurePolicy === 'fail_stop')) continue;
        const listRef = findWorkflowBlockListRef(draft, block.id);
        const siblings = listRef ? getWorkflowBlockList(draft, listRef) : null;
        const next = siblings?.[siblings.findIndex(candidate => candidate.id === block.id) + 1];
        const nextRow = row.parentRecordId === null ? undefined : children.get(row.parentRecordId)?.find(candidate =>
            candidate.memberOrdinal === (BigInt(row.memberOrdinal) + 1n).toString());
        return [t('workflows.run.consequenceLanes', { lanes: runningLanes }),
            params.historyComplete === true && branchFrames.length === block.branches.length && next
                && (!nextRow || nextRow.lifecycle === 'pending' || nextRow.lifecycle === 'waiting_for_capacity')
                ? t('workflows.run.consequenceJoin', { step: workflowBlockReferenceLabel(next), count: block.branches.length }) : null,
        ].filter(Boolean).join(' ');
    }
    return null;
}

export function formatWorkflowRunOutcomeSentence(params: Readonly<{
    run: WorkflowRunSummaryV1;
    coverage: WorkflowRunCoverage;
    historyComplete?: boolean;
    attention?: WorkflowRunAttentionLead | null;
    cancelRequested?: boolean;
    /** Exact failed occurrence, named from the frozen definition rather than selection. */
    failure?: Readonly<{ step: string }> | null;
    /**
     * The exact Machine observation qualifies pending Stop custody only.
     * Contact and recovery details never replace the persisted Run outcome.
     */
    machine?: Readonly<{ name: string; reachable: boolean; status?: WorkStatusPresentation }>;
}>): string {
    const { run, coverage } = params;
    if (isWorkflowRunStopPending({ ...run, cancelRequested: params.cancelRequested })) {
        return describeWorkflowRunState(run.state, { workflowCustodyState: run.workflowCustodyState,
            cancelRequested: params.cancelRequested, machineReachable: params.machine?.reachable,
            machineName: params.machine?.name }).label;
    }
    // The accepted Run and its opened result own outcomes. A live Machine
    // observation owns contact/recovery, never a replacement outcome sentence.
    if (run.state === 'failed') {
        return params.failure
            ? t('workflows.run.failedStepSentence', { step: params.failure.step })
            : t('workflows.run.failedSentence');
    }
    // An interrupted Run says what stopped and that finished work is kept (07 §6.1), never the bare word.
    if (run.state === 'interrupted') {
        return params.failure
            ? t('workflows.run.interruptedStepSentence', { step: params.failure.step })
            : t('workflows.run.interruptedSentence');
    }
    if (run.state === 'succeeded') {
        // A loaded page is not necessarily complete history. Until the cursor is
        // exhausted, neither the success count nor the absence of failures is
        // authoritative, so keep terminal copy deliberately neutral.
        if (params.historyComplete === false || coverage.coverage === 'partial') {
            return coverage.knownFailure ? t('workflows.runState.completed_with_failures') : formatWorkflowRunStateLabel(run.state);
        }
        if (coverage.knownFailure) return t('workflows.runState.completed_with_failures');
        // Runtime rows count occurrences (including repeated steps). The root's
        // authored progress is the same projection read by the Run row and map.
        const progress = run.stepProgress;
        return progress
            ? progress.completed === progress.total
                ? t('workflows.run.completedCount', { count: progress.total })
                : t('workflows.list.stepsProgress', progress)
            : formatWorkflowRunStateLabel(run.state);
    }
    // A parked Run whose held step is not known yet says only that it waits; the word already says it.
    if (!params.attention && (run.state === 'waiting_for_review'
        || run.attentionRequired === true && (run.state === 'queued' || run.state === 'claimed'))) {
        return t('workflows.review.waitTitle');
    }
    if (params.attention && (run.state === 'queued' || run.state === 'claimed' || run.state === 'running' || run.state === 'waiting_for_review')) {
        if (params.attention.waitForYou && params.attention.step === t('workflows.page.blocks.waitTitle')) {
            return t('workflows.review.waitBody');
        }
        // A parked Run leads with the word that already says it waits; the sentence then only names the step.
        if (run.state === 'waiting_for_review' || run.state === 'queued' || run.state === 'claimed') {
            return t('workflows.run.attentionParkedSentence', { step: params.attention.step });
        }
        return params.attention.waitForYou
            ? t('workflows.run.attentionWaitSentence', { step: params.attention.step })
            : t('workflows.run.attentionReviewSentence', { step: params.attention.step });
    }
    // A stopped Run says how far it got, from the server's authored progress the Run row also reads
    // (DESIGN-15 R9); unlike a success count it does not depend on the loaded history pages.
    if (run.state === 'cancelled' && run.stepProgress) {
        return t('workflows.run.stoppedCount', run.stepProgress);
    }
    if (run.state === 'pause_requested') return t('workflows.run.pausePending');
    if (run.state === 'paused') return t('workflows.run.paused');
    if (run.state === 'claimed' && coverage.observedLeafCounts.completed > 0) return formatWorkflowRunStateLabel('running');
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
    reasonDetails?: NonNullable<WorkflowProgressEnvelopeV1['reason']>['details'];
    /** The invocation's authored block label, resolved against the frozen definition. */
    blockLabel: string | null;
    /** An uncertain step is said by its kind: an Agent step or an Action (07 §6.2). */
    blockKind?: WorkflowProgressEnvelopeV1['blockKind'] | undefined;
}>): string | null {
    if (params.lifecycle === 'waiting_for_capacity') return t('workflows.run.capacityOccupied');
    if (params.lifecycle === 'outcome_uncertain' && params.blockLabel !== null) {
        if (params.blockKind === 'action') return t('workflows.recovery.uncertainAction', { action: params.blockLabel });
        if (params.blockKind === 'step') return t('workflows.recovery.uncertainEffects', { block: params.blockLabel });
    }
    if (params.reasonDetails && (params.reasonDetails.code === params.reasonCode || params.reasonCode === 'conversation_workspace_mismatch')) {
        return formatWorkflowConversationProblem(params.reasonDetails);
    }
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
    cancelRequested?: boolean;
    workflowCustodyState?: WorkflowRunSummaryV1['workflowCustodyState'];
    machineReachable?: boolean;
    machineName?: string | null;
    /** Membership in the canonical attention window, independent of its step kinds. */
    inAttentionWindow?: boolean;
    /**
     * True when every loaded item the parked Run waits on is a Wait-for-you
     * step: the Run is then waiting for you, not for your review.
     */
    waitingOnlyForYou?: boolean;
}>): string {
    if (isWorkflowRunStopPending(params)) return describeWorkflowRunState(params.state, params).label;
    if (params.state === 'succeeded' && params.coverage.knownFailure) {
        return t('workflows.runState.completed_with_failures');
    }
    if (params.state === 'waiting_for_review'
        || ((params.state === 'queued' || params.state === 'claimed') && params.inAttentionWindow === true)) {
        return describeWorkflowRunState(params.state, {
            // Until the held items are known, the Run only waits; "your review" would name a kind of hold
            // nothing has read yet (DESIGN-16 D10).
            word: params.waitingOnlyForYou !== false || params.inAttentionWindow !== true
                ? t('workflows.review.waitTitle')
                : t('workflows.runState.waiting_for_review'),
            inAttentionWindow: params.inAttentionWindow,
        }).label;
    }
    return formatWorkflowRunStateLabel(params.state === 'claimed' && params.coverage.observedLeafCounts.completed > 0
        ? 'running' : params.state);
}

/**
 * Run detail says its status once, as the first words of the outcome line
 * (07 §3, §6.1): "{word} — {sentence}". A sentence that already opens with the
 * word is the line on its own.
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
