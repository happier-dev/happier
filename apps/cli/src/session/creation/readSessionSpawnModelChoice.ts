import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readAuthoredSessionModelSelection } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

/** An omitted choice can inherit. Automatic and an authored model slot both occupy the model facet. */
export function readSessionSpawnModelChoice(
  input: Pick<SessionSpawnNewInputV2, 'modelSelection' | 'configuration' | 'teamCredentialBindings'>,
  agentTarget: SessionSpawnNewInputV2['agentTarget'],
): SessionModelSelection | null | undefined {
  const selection = readAuthoredSessionModelSelection({ ...input, agentTarget });
  if (selection) return selection;
  const model = input.configuration?.model;
  if (model?.value) return { v: 1, updatedAt: model.updatedAtMs,
    ref: { agentTargetKey: buildBackendTargetKeyV2(agentTarget), providerConnectionId: null, modelId: model.value } };
  if (model?.value === null && model.selectionSource !== 'inherited') return null;
  if (input.teamCredentialBindings?.some(intent => intent.slot.kind === 'provider_model')) return null;
  return undefined;
}
