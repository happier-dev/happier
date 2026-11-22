import { listUnreviewedSessionChangedFilesV1 } from '@happier-dev/protocol/reviews/reviewSessionCoverageV1';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { findAccountReviewHabit, REVIEW_HABIT_WORKFLOW_ID } from './reviewHabit';

type CoverageInput = Parameters<typeof listUnreviewedSessionChangedFilesV1>[0];

/**
 * The session-finished suggestion (lab `session-finished`, OQ1): "N changed files haven't been reviewed", shown while
 * the agent is idle, there are changes no completed Review of this Session covered, and no review habit is on. The
 * count is the coverage owner's (`listUnreviewedSessionChangedFilesV1`); this only decides whether to say it.
 */
export function resolveSessionReviewSuggestion(input: Readonly<{
    sessionId: string;
    thinking: boolean;
    habitOn: boolean;
    /** Null until the Session's changes are derived. */
    changeSet: CoverageInput['changeSet'] | null;
    /** Null until the Session's Reviews are read. */
    reviews: CoverageInput['reviews'] | null;
}>): Readonly<{ unreviewedCount: number }> | null {
    if (input.thinking || input.habitOn || !input.changeSet || !input.reviews) return null;
    const unreviewedCount = listUnreviewedSessionChangedFilesV1({
        sessionId: input.sessionId, changeSet: input.changeSet, reviews: input.reviews,
    }).length;
    return unreviewedCount > 0 ? { unreviewedCount } : null;
}

/** A review habit covers this Session: its own enabled review trigger, or the enabled all-sessions habit. */
export function isSessionReviewHabitOn(sessionSets: readonly WorkflowTriggerSetV1[], accountSets: readonly WorkflowTriggerSetV1[]): boolean {
    const own = sessionSets.some(set => set.enabled && set.target?.kind === 'workflow' && set.target.ref === REVIEW_HABIT_WORKFLOW_ID
        && set.triggers.some(trigger => trigger.enabled && trigger.kind === 'sessionLifecycle' && trigger.events.includes('parentTurnCompleted')));
    return own || findAccountReviewHabit(accountSets)?.enabled === true;
}
