import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { workflowTriggerSetWritesToSession } from '@/sync/domains/workflows/workflowTriggerSession';
import { isSpentOnceSchedule } from './triggerSchedule';

export type ScheduledWorkflowRow = Readonly<{
    key: string;
    set: WorkflowTriggerSetV1;
    trigger: Extract<WorkflowTriggerSetV1['triggers'][number], { kind: 'schedule' }>;
}>;

export function projectScheduledWorkflowRows(sets: readonly WorkflowTriggerSetV1[], sessionId?: string): readonly ScheduledWorkflowRow[] {
    return sets.flatMap((set) => !set.enabled || (sessionId !== undefined && !workflowTriggerSetWritesToSession(set, sessionId))
        ? [] : set.triggers.flatMap((trigger): ScheduledWorkflowRow[] => trigger.enabled && trigger.kind === 'schedule' && !isSpentOnceSchedule(trigger)
            ? [{ key: `${set.automationId}:${trigger.id}`, set, trigger }] : []))
        .sort((left, right) => (left.trigger.nextRunAt ?? Infinity) - (right.trigger.nextRunAt ?? Infinity));
}
