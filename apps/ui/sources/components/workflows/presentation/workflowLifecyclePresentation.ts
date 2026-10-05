import {
    WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1,
    type WorkflowInvocationLifecycleV1,
    type WorkflowRunStateV1,
    type WorkflowRunInvocationIndexV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { IconName } from '@/components/ui/icons/Icon';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import {
    isTerminalWorkflowInvocationLifecycle,
    isTerminalWorkflowRunState,
    resolveWorkStatusTone,
    WORK_STATUS_PILL_VARIANT,
} from '@/components/work/status/resolveWorkStatusTone';
import { t } from '@/text';

export { isTerminalWorkflowRunState };

/**
 * The one neutral presenter for the managed Workflow invocation lifecycle.
 *
 * Parent Run state and per-invocation lifecycle are two different closed
 * contracts (UX §3.4). This module owns the second one only, and it owns it
 * completely: label and visual marker live here, while semantic tone delegates
 * to the shared Work presenter so
 * Run detail, Flow and the Workflows collection cannot drift apart or render
 * every lifecycle identically.
 *
 * Two rules are structural rather than stylistic:
 *
 * 1. **Colour is never the sole carrier.** Every lifecycle pairs its semantic
 *    colour with a distinct marker, so the difference survives monochrome,
 *    increased contrast and colour-blind reading.
 * 2. **Nothing here decides a lifecycle.** The value always comes from the
 *    canonical server projection; this module only describes it.
 *
 * Observed native-agent activity keeps its own separate owners
 * (`workflowStatusIcon.tsx` / `workflowStatusLabel.ts`): those render
 * `SessionWorkflowRunStatusV1`, an observation contract that deliberately
 * cannot represent managed lifecycle. They are not a competing mapping for this
 * one, and merging them would be exactly the status guesser plan 04 §3.1
 * forbids.
 */

/** The lifecycles the server's `attention: 'required'` predicate treats as actionable. */
export const WORKFLOW_ATTENTION_LIFECYCLES: readonly WorkflowInvocationLifecycleV1[] = WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1;

/**
 * What leads the status.
 *
 * `activity` means the canonical spinner: work this Run owns is genuinely in
 * flight right now. Everything else is a static glyph, because a spinner beside
 * settled or queued work claims motion that is not happening.
 */
export type WorkflowLifecycleMarker =
    | Readonly<{ kind: 'activity' }>
    | Readonly<{ kind: 'icon'; icon: IconName }>;

export type WorkflowLifecyclePresentation = Readonly<{
    lifecycle: WorkflowInvocationLifecycleV1;
    label: string;
    variant: StatusPillVariant;
    marker: WorkflowLifecycleMarker;
    /** Mirrors the server predicate; it is not a second attention decision. */
    attention: boolean;
    /** Settled: this row will not change again without an explicit new attempt. */
    terminal: boolean;
}>;

type WorkflowLifecycleShape = Readonly<{
    marker: WorkflowLifecycleMarker;
}>;

const ACTIVITY: WorkflowLifecycleMarker = { kind: 'activity' };

function icon(name: IconName): WorkflowLifecycleMarker {
    return { kind: 'icon', icon: name };
}

/**
 * The complete marker table. It is a record rather than a switch so a
 * Protocol addition fails to compile here — at the one owner — instead of
 * silently falling through to a neutral circle in three screens.
 */
const WORKFLOW_LIFECYCLE_SHAPES: Readonly<Record<WorkflowInvocationLifecycleV1, WorkflowLifecycleShape>> = {
    pending: { marker: icon('clock') },
    waiting_for_capacity: { marker: icon('hourglass') },
    admitting: { marker: ACTIVITY },
    running: { marker: ACTIVITY },
    waiting_for_approval: { marker: icon('hand') },
    waiting_for_review: { marker: icon('hand') },
    needs_attention: { marker: icon('warning-circle') },
    completed: { marker: icon('check-circle') },
    failed: { marker: icon('x-circle') },
    skipped: { marker: icon('minus-circle') },
    // Stopping is not stopped: a durable stop request is not proof the work ended.
    cancel_requested: { marker: icon('stop-circle') },
    cancelled: { marker: icon('stop') },
    outcome_uncertain: { marker: icon('question') },
    superseded: { marker: icon('arrow-clockwise') },
};

/**
 * What the row is, when its authored block is known. A held **Wait for you**
 * step shares the review hold's lifecycle but not its word (07 §6.2): it reads
 * "Waiting for you", and "Waiting for your review" stays reserved for review
 * holds. Tone, marker and attention are the lifecycle's and do not change.
 */
export type WorkflowInvocationLifecycleContext = Readonly<{ blockKind?: string | null }>;

export function isWorkflowWaitForYouHold(
    lifecycle: WorkflowInvocationLifecycleV1,
    context?: WorkflowInvocationLifecycleContext,
): boolean {
    return lifecycle === 'waiting_for_review' && context?.blockKind === 'wait';
}

export function describeWorkflowInvocationLifecycle(
    lifecycle: WorkflowInvocationLifecycleV1,
    context?: WorkflowInvocationLifecycleContext,
): WorkflowLifecyclePresentation {
    const shape = WORKFLOW_LIFECYCLE_SHAPES[lifecycle];
    const label = isWorkflowWaitForYouHold(lifecycle, context)
        ? t('workflows.review.waitTitle')
        : t(`workflows.invocationState.${lifecycle}`);
    const attention = WORKFLOW_ATTENTION_LIFECYCLES.includes(lifecycle);
    const status = resolveWorkStatusTone({ kind: 'workflow_step', facts: { lifecycle, word: label, inAttentionWindow: attention } });
    return {
        lifecycle,
        label: status.word,
        variant: WORK_STATUS_PILL_VARIANT[status.tone],
        marker: shape.marker,
        attention,
        terminal: isTerminalWorkflowInvocationLifecycle(lifecycle),
    };
}

/**
 * The parent Run state — a different closed contract, mapped separately.
 *
 * It lives beside the invocation table rather than merged into it so both stay
 * exhaustive and neither can be used where the other belongs. Callers that
 * compose a terminal outcome sentence ("Completed with failures") pass their own
 * label; this owner never invents a terminal state the server did not report.
 */
export type WorkflowRunStatePresentation = Readonly<{
    state: WorkflowRunStateV1;
    label: string;
    variant: StatusPillVariant;
    marker: WorkflowLifecycleMarker;
    terminal: boolean;
}>;

const WORKFLOW_RUN_STATE_SHAPES: Readonly<Record<
    WorkflowRunStateV1,
    Readonly<{ marker: WorkflowLifecycleMarker }>
>> = {
    queued: { marker: icon('clock') },
    claimed: { marker: ACTIVITY },
    running: { marker: ACTIVITY },
    succeeded: { marker: icon('check-circle') },
    failed: { marker: icon('x-circle') },
    cancelled: { marker: icon('stop') },
    pause_requested: { marker: icon('pause-circle') },
    paused: { marker: icon('pause-circle') },
    interrupted: { marker: icon('warning-circle') },
    waiting_for_review: { marker: icon('hand') },
    expired: { marker: icon('hourglass') },
    dispatch_failed: { marker: icon('warning') },
    skipped: { marker: icon('minus-circle') },
    missed: { marker: icon('minus-circle') },
    outcome_uncertain: { marker: icon('question') },
};

export function describeWorkflowRunState(state: WorkflowRunStateV1): WorkflowRunStatePresentation {
    const shape = WORKFLOW_RUN_STATE_SHAPES[state];
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: { state, word: t(`workflows.runState.${state}`) } });
    return {
        state,
        label: status.word,
        variant: WORK_STATUS_PILL_VARIANT[status.tone],
        marker: shape.marker,
        terminal: isTerminalWorkflowRunState(state),
    };
}

/**
 * How a physical attempt counter reads to a person.
 *
 * The index counts attempts from zero as a canonical decimal string; people
 * count from one. Activity rows, Flow occurrences, the selected detail and
 * their accessible names all read this one owner, so a retried step is
 * "Attempt 2" everywhere. The counter is 64-bit on the server, so it is
 * incremented as a BigInt and never passed through a JS number.
 */
export function describeWorkflowInvocationAttempt(attempt: string): Readonly<{
    label: string;
    /** True for every attempt after the first, which is the only one worth calling out. */
    retried: boolean;
}> {
    const ordinal = /^\d+$/.test(attempt) ? (BigInt(attempt) + 1n).toString() : attempt;
    return {
        label: t('workflows.run.attempt', { attempt: ordinal }),
        retried: attempt !== '0',
    };
}

/** Classification comes from the frozen definition/opened runtime structure owner. */
export type WorkflowInvocationCoverageKind = 'executable' | 'structural' | 'unknown';

/** Observed leaf counts are not totals until the read and classification are complete. */
export type WorkflowRunCoverage = Readonly<{
    observedLeafCounts: Readonly<{ completed: number; failed: number; attention: number }>;
    coverage: 'partial' | 'complete';
    knownFailure: boolean;
}>;

export function summarizeWorkflowInvocationCoverage(
    invocations: readonly Pick<WorkflowRunInvocationIndexV1, 'id' | 'parentRecordId' | 'memberOrdinal' | 'attempt' | 'lifecycle'>[],
    evidence: Readonly<{
        kindsByInvocationId: ReadonlyMap<string, WorkflowInvocationCoverageKind>;
        historyComplete: boolean;
        runState?: WorkflowRunStateV1;
        knownFailure?: boolean;
    }>,
): WorkflowRunCoverage {
    const currentBySlot = new Map<string, (typeof invocations)[number]>();
    for (const invocation of invocations) {
        const slot = JSON.stringify([invocation.parentRecordId, invocation.memberOrdinal]);
        const current = currentBySlot.get(slot);
        if (current === undefined || BigInt(invocation.attempt) > BigInt(current.attempt)) {
            currentBySlot.set(slot, invocation);
        }
    }
    let completed = 0;
    let failed = 0;
    let attention = 0;
    let coverage: WorkflowRunCoverage['coverage'] = evidence.historyComplete ? 'complete' : 'partial';
    let knownFailure = evidence.knownFailure === true || evidence.runState === 'failed';
    for (const invocation of currentBySlot.values()) {
        if (invocation.lifecycle === 'superseded') continue;
        if (invocation.lifecycle === 'failed') knownFailure = true;
        const kind = evidence.kindsByInvocationId.get(invocation.id) ?? 'unknown';
        if (kind === 'unknown') coverage = 'partial';
        if (kind !== 'executable') continue;
        if (invocation.lifecycle === 'completed') completed += 1;
        if (invocation.lifecycle === 'failed') failed += 1;
        if (WORKFLOW_ATTENTION_LIFECYCLES.includes(invocation.lifecycle)) attention += 1;
    }
    return { observedLeafCounts: { completed, failed, attention }, coverage, knownFailure };
}
