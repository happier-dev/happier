import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { containsMachineSetupItem } from '@/components/settings/machines/managed/machineSetupItems';

import type { MachineSetupReviewIntent } from './useMachineSetup';

export type MachineSetupRunRecovery = Readonly<{
  /** What Retry reviews: the run's own captured proposal planned again, or (a run that captured none) the Machine's setup. */
  retry: MachineSetupReviewIntent & Readonly<{ removeItemKeys?: string[] }>;
  /** The one Software recipe the proposal added, with the inputs it was given: Edit reopens its Store listing with them. */
  edit: Readonly<{
    ref: MachineRecipeReferenceV1;
    inputs: Readonly<Record<string, unknown>>;
  }> | null;
}>;

/**
 * The ways forward from a stopped Setup run, read from the run's own `machineSetup` attachment (`source`, the authored
 * proposal the native owner retained). A run without it (older daemons) keeps re-planning the Machine's own setup.
 */
export function readMachineSetupRunRecovery(
  snapshot: ActionOperationSnapshotV1 | null | undefined,
  current: MachineSetupPlanResultV1 | null,
): MachineSetupRunRecovery {
  const source =
    snapshot?.domainRef?.kind === 'machineSetup'
      ? snapshot.domainRef.source
      : undefined;
  if (!source) return { retry: { kind: 'reapply' }, edit: null };
  const retry = {
    kind: 'sources' as const,
    sources: source.sources,
    ...(source.candidatePreset === undefined ? {} : { candidatePreset: source.candidatePreset }),
    ...(source.removeItemKeys?.length ? { removeItemKeys: [...source.removeItemKeys] } : {}),
  };
  if (source.candidatePreset) return { retry, edit: null };
  const currentDirect = current?.sources.find(
    (entry) => entry.kind === 'direct',
  );
  const proposedDirect = source.sources.find(
    (entry) => entry.kind === 'direct',
  );
  const added = (
    proposedDirect?.kind === 'direct' ? (proposedDirect.setup.items ?? []) : []
  ).filter(
    (item) =>
      item.kind === 'softwareRecipe' &&
      !containsMachineSetupItem(
        currentDirect?.kind === 'direct' ? currentDirect.setup : undefined,
        item,
      ),
  );
  const only =
    added.length === 1 && added[0]!.kind === 'softwareRecipe'
      ? added[0]!
      : null;
  const inputs =
    only?.kind === 'softwareRecipe' ? only.selection.inputs : undefined;
  return {
    retry,
    edit:
      only?.kind === 'softwareRecipe' &&
      inputs &&
      typeof inputs === 'object' &&
      !Array.isArray(inputs)
        ? { ref: only.selection.ref, inputs: inputs as Record<string, unknown> }
        : null,
  };
}
