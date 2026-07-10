import {
  SessionModelSelectionResolutionError,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';

export function resolveInitialHostSessionModelSelection(params: Readonly<{
  agentTargetKey: string;
  runtimeSelection?: SessionModelSelectionV1;
  lifecycleSelection?: SessionModelSelectionV1;
}>): SessionModelSelectionV1 | undefined {
  const selection = params.runtimeSelection ?? params.lifecycleSelection;
  if (selection && selection.ref.agentTargetKey !== params.agentTargetKey) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
  }
  return selection;
}
