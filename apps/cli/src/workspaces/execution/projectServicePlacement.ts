import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectServicePlacementReadResultV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';

export type ProjectServiceStartChoice = Readonly<{
  status: 'resolved';
  choice: ProjectExecutionChoiceV1;
  unavailable: 'primary' | 'fail';
  provenance: 'saved' | 'default' | 'invocation';
}> | Readonly<{ status: 'refused'; reason: 'primary_only' | 'settings_unavailable' }>;

/** Services read only their entry; finite worker enablement and slots never govern service lifetime. */
export function resolveProjectServiceStartChoice(input: Readonly<{
  execution: 'primary' | 'portable';
  placement: ProjectServicePlacementReadResultV1;
  invocation?: ProjectExecutionChoiceV1;
}>): ProjectServiceStartChoice {
  if (input.execution === 'primary' && input.invocation?.kind === 'workers') {
    return { status: 'refused', reason: 'primary_only' };
  }
  if (input.placement.status !== 'ready') return { status: 'refused', reason: 'settings_unavailable' };
  const choice = input.invocation ?? input.placement.placement.runsOn;
  if (input.execution === 'primary' && choice.kind === 'workers') {
    return { status: 'refused', reason: 'primary_only' };
  }
  return {
    status: 'resolved',
    choice,
    unavailable: input.placement.placement.unavailable,
    provenance: input.invocation ? 'invocation' : input.placement.provenance,
  };
}
