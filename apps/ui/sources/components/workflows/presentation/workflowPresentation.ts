import { t } from '@/text';
import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import { fromWorkflowRunStatus } from '@happier-dev/protocol/sessions/work/agentActivity/adapters/fromWorkflowRunStatus';
import type { SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import type { SessionWorkflowRunStatusV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';

import { resolveWorkStatusTone, type WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

/**
 * Neutral workflow presentation owner.
 *
 * Progress and rollup formatting shared by every workflow surface — the transcript
 * card, the Session work-state popover, and the managed library/run/Flow surfaces. It is
 * origin-neutral on purpose: nothing here reads a Claude observation snapshot or a managed run
 * record, only exact counts and statuses already normalized by the owning reader. Claude-observation
 * snapshot normalization stays in `@/components/sessions/workState/sessionWorkflowActivityPresentation`.
 */

/**
 * An observed run's tone, from the one work-status owner (INT §5.3): the run's status reads as the
 * agent-activity vocabulary every roster row speaks, so healthy work is neutral, a dependency block or
 * a stop is not alarm, and only a failure is trouble.
 */
export function resolveWorkflowRunTone(status: SessionWorkflowRunStatusV1): WorkStatusTone {
    return resolveWorkStatusTone({ kind: 'agent_activity', facts: { status: fromWorkflowRunStatus(status), word: '' } }).tone;
}

/** Progress meter tone for `MeterBar`: neutral while the run is healthy, danger once an agent failed. */
export function resolveWorkflowMeterTone(rollup: WorkflowPhaseRollup): 'danger' | 'neutral' {
    return rollup.failed > 0 ? 'danger' : 'neutral';
}

/** Completed-over-total fraction in 0..1 for the progress meter; 0 when there are no agents. */
export function resolveWorkflowProgressFraction(run: Pick<SessionWorkflowRunHeadlineV1, 'completedAgents' | 'totalAgents'>): number {
    if (run.totalAgents <= 0) return 0;
    return Math.min(1, Math.max(0, run.completedAgents / run.totalAgents));
}

/**
 * Compose a concise rollup string from exact counts, e.g. `3/3 complete`, `2/5 active · 1 failed`.
 * Returns the highest-signal summary so phase headers stay scannable.
 */
export function formatPhaseRollup(rollup: WorkflowPhaseRollup): string {
    const segments: string[] = [];
    if (rollup.total > 0) {
        segments.push(t('tools.workflowActivityView.phaseComplete', { complete: rollup.complete, total: rollup.total }));
    }
    if (rollup.active > 0) segments.push(t('tools.workflowActivityView.phaseActive', { count: rollup.active }));
    if (rollup.failed > 0) segments.push(t('tools.workflowActivityView.phaseFailed', { count: rollup.failed }));
    if (rollup.blocked > 0) segments.push(t('tools.workflowActivityView.phaseBlocked', { count: rollup.blocked }));
    if (rollup.pending > 0 && rollup.active === 0 && rollup.complete === 0) {
        segments.push(t('tools.workflowActivityView.phasePending', { count: rollup.pending }));
    }
    return segments.join(' · ');
}
