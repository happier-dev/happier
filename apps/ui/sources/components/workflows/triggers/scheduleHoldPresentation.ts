import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { t } from '@/text';

export type ScheduleHold = NonNullable<
  WorkflowTriggerSetV1['scheduleHolds']
>[number];

/**
 * Why a recurring schedule is not starting its next run, as every trigger surface says it. The
 * scheduler starts one run at a time, so a due schedule waits while an earlier run is still open.
 * Detailed schedule rows name the Run holding the schedule.
 */
export type ScheduleHoldPresentation = Readonly<{
  /** The sentence for a row's status line. */
  text: string;
  /** The same state for a compact trailing time slot. */
  short: string;
  /** The holding Run stopped part way and waits for the person (Stop or Continue on its page). */
  interrupted: boolean;
  runId: string;
}>;

export function readTriggerScheduleHold(
  set: Pick<WorkflowTriggerSetV1, 'scheduleHolds'> | null | undefined,
  triggerId: string | null | undefined,
): ScheduleHold | undefined {
  if (!set?.scheduleHolds || !triggerId) return undefined;
  return set.scheduleHolds.find((hold) => hold.triggerId === triggerId);
}

/** The first held trigger of a set, for a row that speaks for the whole set (a retained 0.2 set). */
export function readSetScheduleHold(
  set: Pick<WorkflowTriggerSetV1, 'scheduleHolds' | 'triggers'>,
): ScheduleHold | undefined {
  return set.scheduleHolds?.find((hold) =>
    set.triggers.some((trigger) => trigger.id === hold.triggerId),
  );
}

export function presentScheduleHold(
  hold: ScheduleHold | null | undefined,
  holdingRun?: Pick<WorkflowRunSummaryV1, 'id' | 'state'> | null,
): ScheduleHoldPresentation | null {
  if (!hold || !('runId' in hold)) return null;
  const state = holdingRun?.id === hold.runId ? holdingRun.state : hold.runState;
  const interrupted = state === 'interrupted';
  return {
    text: t(
      interrupted
        ? 'workflows.triggers.row.heldByInterruptedRun'
        : 'workflows.triggers.row.heldByRun',
    ),
    short: t(
      interrupted
        ? 'workflows.triggers.row.heldInterruptedShort'
        : 'workflows.triggers.row.heldShort',
    ),
    interrupted,
    runId: hold.runId,
  };
}
