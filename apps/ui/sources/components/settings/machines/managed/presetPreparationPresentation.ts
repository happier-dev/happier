import type { ActionOperationProgressStepV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readManagedMachinePresetPreparationV1 } from '@happier-dev/cli-common/machines/managed/presetPreparation';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import type { SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';

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

type PresetPreparedImage = NonNullable<OpenedManagedMachinePresetV1['prepared']>;

/**
 * A ready image's facts from the preset's own private record: when and from which revision it was built, the
 * storage it keeps, and whether the launch owner (`readManagedMachinePresetPreparationV1`) says its authored
 * configuration has moved on since. The preset page and its list rows read this one answer; nothing re-checks it.
 */
export function readPresetPreparedSummary(
  preset: OpenedManagedMachinePresetV1 | null,
  prepared: PresetPreparedImage | null = preset?.prepared ?? null,
): Readonly<{
  builtAt: number | null;
  builtFromRevision: number | null;
  storageBytes: number | null;
  stale: boolean;
}> | null {
  if (prepared?.status !== 'ready' || preset === null) return null;
  // The launch owner decides authored-configuration staleness. Current CLI and credential observations belong to
  // acquire; this view retains the build's identities.
  const decision = readManagedMachinePresetPreparationV1({
    content: preset,
    cliIdentity: prepared.binding.cliIdentity,
    credentialConfigurations: prepared.binding.credentialConfigurations,
  });
  return {
    builtAt: prepared.builtAt ?? null,
    builtFromRevision: prepared.builtFromRevision ?? null,
    storageBytes: prepared.artifactSizeBytes ?? null,
    stale: decision.kind === 'cold' && decision.reason === 'stale',
  };
}

/** The image's state as one word in the page's own words, with its tone and its one next step. */
export type PresetImageState = Readonly<{
  kind: 'none' | 'off' | 'notBuilt' | 'building' | 'ready' | 'stale' | 'failed';
  word: string;
  /** `quiet`: nothing to do (healthy or not kept); `warning`: it needs the person; `danger`: it failed; `running`: a build is under way. */
  tone: 'quiet' | 'warning' | 'danger' | 'running';
  /** When and from what it was built ("Built 10:45 from revision 7"); `null` when unknown or not built. */
  line: string | null;
  /** The one next step a row offers beside it; a healthy image keeps Rebuild in its "…" menu. */
  next: 'build' | 'rebuild' | 'retry' | null;
}>;

/**
 * The prepared image's state (lab scenes 5–7): the preset page, the Presets table and a Machine's Sandboxes table
 * all say it through this one decision, in the page's words. A preset that keeps no image says "Off" when its
 * switch is off and "No image" when it never chose one (a provider that can't keep one has no switch).
 */
export function describePresetImage(
  preset: OpenedManagedMachinePresetV1,
  summary: ReturnType<typeof readPresetPreparedSummary> = readPresetPreparedSummary(preset),
): PresetImageState {
  const enabled = preset.preparation?.enabled;
  const status = preset.prepared?.status ?? null;
  if (enabled !== true && status === null)
    return enabled === false
      ? { kind: 'off', word: t('machinePresets.imageOff'), tone: 'quiet', line: null, next: null }
      : { kind: 'none', word: t('machinePresets.imageNone'), tone: 'quiet', line: null, next: null };
  if (enabled === false)
    return { kind: 'off', word: t('machinePresets.imageOff'), tone: 'quiet', line: null, next: null };
  switch (status) {
    case 'building':
      return { kind: 'building', word: t('machinePresets.prepareBuilding'), tone: 'running', line: null, next: null };
    case 'failed':
      return { kind: 'failed', word: t('inbox.actionOperations.status.failed'), tone: 'danger', line: null, next: 'retry' };
    case 'cancelled':
      // The person stopped it, so it reads as not built yet, quietly, with Build in the row's "…" (ruling 11-19 10:38Z).
      return { kind: 'notBuilt', word: t('machinePresets.prepareNotBuilt'), tone: 'quiet', line: null, next: 'build' };
    case 'ready': {
      const line = describePreparedImageBuilt(summary);
      return summary?.stale
        ? { kind: 'stale', word: t('machinePresets.prepareStale'), tone: 'warning', line, next: 'rebuild' }
        : { kind: 'ready', word: t('machinePresets.prepareReady'), tone: 'quiet', line, next: null };
    }
    default:
      return { kind: 'notBuilt', word: t('machinePresets.prepareNotBuilt'), tone: 'quiet', line: null, next: 'build' };
  }
}

/**
 * Whether a Machine made from a preset runs an older image than the one the preset keeps now (owner decision D):
 * the image revision recorded at the Machine's admission against the preset's own ready summary. A Machine started
 * cold (no recorded image) or a preset with no ready image says nothing.
 */
export function isMachineImageOlderThanPreset(
  machineImageRevision: number | undefined,
  summary: ReturnType<typeof readPresetPreparedSummary>,
): boolean {
  return machineImageRevision !== undefined && summary?.builtFromRevision != null
    && machineImageRevision < summary.builtFromRevision;
}
