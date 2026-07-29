import {
  BackendTargetKeyV2InputSchema,
  SessionModelSelectionResolutionError,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';

export function resolveInitialHostSessionModelSelection(params: Readonly<{
  agentTargetKey: string;
  runtimeSelection?: SessionModelSelectionV1;
  lifecycleSelection?: SessionModelSelectionV1;
}>): SessionModelSelectionV1 | undefined {
  const selection = params.runtimeSelection ?? params.lifecycleSelection;
  if (!selection) return undefined;

  const normalizedTargetKey = BackendTargetKeyV2InputSchema.safeParse(
    selection.ref.agentTargetKey,
  );
  if (!normalizedTargetKey.success || normalizedTargetKey.data !== params.agentTargetKey) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
  }
  if (normalizedTargetKey.data === selection.ref.agentTargetKey) return selection;

  return {
    ...selection,
    ref: {
      ...selection.ref,
      agentTargetKey: normalizedTargetKey.data,
    },
  };
}
