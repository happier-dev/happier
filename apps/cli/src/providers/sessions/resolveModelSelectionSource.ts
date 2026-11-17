import { readSessionModelSelectionProviderConnectionId, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import { readSessionModelSelectionIntentSourceV1 } from '@happier-dev/protocol/providers/model-selection';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';

/** Projects provenance of the selected tuple without choosing a model or route. */
export function resolveModelSelectionSource(input: Readonly<{
  selection?: ProviderBoundModelRef | null;
  metadata: Readonly<Record<string, unknown>> | null;
  launchSelection?: SessionModelSelection | null;
}>): 'explicit' | 'inherited' {
  const selection = input.selection;
  if (!selection) return 'inherited';
  const metadata = input.metadata ?? {};
  const matches = (candidate: ProviderBoundModelRef | null): boolean => candidate !== null
    && candidate.agentTargetKey === selection.agentTargetKey
    && candidate.providerConnectionId === selection.providerConnectionId
    && candidate.modelId === selection.modelId;
  const source = readSessionModelSelectionIntentSourceV1({
    canonical: metadata.modelSelectionIntentV1,
    legacy: metadata.modelOverrideV1,
  });
  const v2 = readSessionModelSelectionV2FromMetadata(metadata);
  if (v2 && (source.status === 'canonical' || source.status === 'legacy')
    && source.intent.updatedAt > v2.updatedAt) {
    return source.status === 'canonical' && matches(source.intent.selection) ? 'explicit' : 'inherited';
  }
  if (v2) {
    return matches({
      agentTargetKey: v2.ref.agentTargetKey,
      providerConnectionId: readSessionModelSelectionProviderConnectionId(v2),
      modelId: v2.ref.modelId,
    }) ? 'explicit' : 'inherited';
  }
  if (metadata.modelSelectionIntentV2 !== undefined) return 'inherited';
  if (source.status === 'canonical') return matches(source.intent.selection) ? 'explicit' : 'inherited';
  if (source.status !== 'absent') return 'inherited';
  return input.launchSelection && matches({ ...input.launchSelection.ref, providerConnectionId: readSessionModelSelectionProviderConnectionId(input.launchSelection) }) ? 'explicit' : 'inherited';
}
