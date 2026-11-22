import type { BuiltinWorkflowIdV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowTriggerAddRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import type { AutomationEventFilterV1 } from '@happier-dev/protocol/automations/automationEventFilterV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

import type { AccountTriggerRow } from '@/components/workflows/triggers/accountTriggerRows';
import { buildTriggerDefinition } from '@/components/workflows/triggers/sessionTriggerForm';

/**
 * The review habit is not a store of its own: it is one ordinary trigger that links the built-in review workflow
 * (lab `session-habit`: "It writes the one session trigger that runs the built-in review workflow"). Its reviewers
 * are chosen and saved with it at setup; admission never picks them (ORCH ruling 2026-11-22).
 */
export const REVIEW_HABIT_WORKFLOW_ID =
  'builtin:review-and-converge' satisfies BuiltinWorkflowIdV1;

const TURN_COMPLETED = 'parentTurnCompleted' as const;

/** "A turn ends with changes": the lifecycle producer's changed-files fact (P03 U7), never recomputed here. */
const CHANGED_FILES: AutomationEventFilterV1 = Object.freeze({
  v: 1,
  all: [{ op: 'eq', field: '/changedFiles', value: true }],
});

export type ReviewHabitScope =
  | Readonly<{ kind: 'session'; homeId: string; sessionId: string }>
  /** Every session of the Account; it runs where its reviewer was set up. */
  | Readonly<{ kind: 'account'; project: WorkflowProjectTargetV1 }>;

type ExecutableAddRequest = Exclude<WorkflowTriggerAddRequestV1, Readonly<{ observationOnly: unknown }>>;

export function buildReviewHabitTriggerRequest(scope: ReviewHabitScope,
    reviewers: readonly ReviewReviewerSelectionV1[]): ExecutableAddRequest | null {
    const session = scope.kind === 'session' ? scope : null;
    const trigger = buildTriggerDefinition({
        when: { kind: 'turnEnds', events: [TURN_COMPLETED], filter: CHANGED_FILES,
            ...(session ? { subject: { kind: 'session' as const, serverId: session.homeId, sessionId: session.sessionId } } : {}) },
        enabled: true,
        sessionId: session?.sessionId ?? null,
    });
    if (!trigger || trigger.kind !== 'sessionLifecycle' || reviewers.length === 0) return null;
    return {
        workflow: REVIEW_HABIT_WORKFLOW_ID,
        ...(scope.kind === 'session' ? { lifetimeSession: { sessionId: scope.sessionId } } : { project: scope.project }),
        inputs: { reviewers: projectNativeJsonValueForTransport(reviewers) },
        trigger,
    };
}

/** The habit among a subject's trigger rows: the built-in review, run when a turn completes. */
export function findReviewHabitRow(
  rows: readonly AccountTriggerRow[],
): AccountTriggerRow | null {
  return (
    rows.find(
      (row) =>
        row.attachment?.workflowDefinitionId === REVIEW_HABIT_WORKFLOW_ID &&
        row.attachment.summary.kind === 'sessionLifecycle' &&
        row.attachment.summary.events.includes(TURN_COMPLETED),
    ) ?? null
  );
}

/** An all-sessions habit runs where its reviewer was set up: the reviewer's Machine and chosen folder. */
export function projectReviewHabitPlacement(reviewer: ReviewReviewerSelectionV1): WorkflowProjectTargetV1 | null {
    if (reviewer.kind !== 'model' || reviewer.launch.directory.kind !== 'path') return null;
    return { machineId: reviewer.launch.executionTarget.machineId, directory: reviewer.launch.directory.path };
}

/** The Account's all-sessions habit among the sets linking the built-in review: no Session lifetime, no Session subject. */
export function findAccountReviewHabit(sets: readonly WorkflowTriggerSetV1[]): Readonly<{
    automationId: string; triggerId: string; enabled: boolean;
}> | null {
    for (const set of sets) {
        if (set.scopeSessionId || set.target?.kind !== 'workflow' || set.target.ref !== REVIEW_HABIT_WORKFLOW_ID) continue;
        const trigger = set.triggers.find(candidate => candidate.kind === 'sessionLifecycle'
            && candidate.events.includes(TURN_COMPLETED) && !('subject' in candidate && candidate.subject));
        if (trigger) return { automationId: set.automationId, triggerId: trigger.id, enabled: set.enabled && trigger.enabled };
    }
    return null;
}
