import type { ActionOperationProgressStepV1 } from '@happier-dev/protocol/actions/operations/v1';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import type { SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

const STEP_STATE = {
  pending: 'upcoming',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<
  ActionOperationProgressStepV1['state'],
  NonNullable<SetupStep['state']>
>;

/**
 * A build's owner-named steps (lab scene 5 `building`): each step's own label and state, and how long a settled
 * one took. A running step says nothing about time: its spinner is the present, and no clock ticks here.
 */
export function projectPresetPreparationSteps(
  steps: readonly ActionOperationProgressStepV1[],
): SetupStep[] {
  return steps.map((step) => ({
    key: step.id,
    state: STEP_STATE[step.state],
    title: step.label,
    ...(step.startedAt != null &&
    step.settledAt != null &&
    step.state === 'succeeded'
      ? { meta: formatElapsedDuration(step.settledAt - step.startedAt) }
      : {}),
  }));
}

/** "Built 10:45 from revision 7" (lab scene 5 `ready`); an unknown fact stays unsaid. */
export function describePreparedImageBuilt(
  summary: Readonly<{
    builtAt: number | null;
    builtFromRevision: number | null;
  }> | null,
): string | null {
  if (!summary) return null;
  const time = summary.builtAt != null ? formatAsOfTime(summary.builtAt) : null;
  if (time && summary.builtFromRevision != null)
    return t('machinePresets.prepareBuiltFrom', {
      time,
      revision: summary.builtFromRevision,
    });
  if (time) return t('machinePresets.prepareBuiltAt', { time });
  return summary.builtFromRevision != null
    ? t('machinePresets.prepareBuiltRevision', {
        revision: summary.builtFromRevision,
      })
    : null;
}
