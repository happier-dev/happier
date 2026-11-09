import type { ProviderBoundModelRef, SessionModelSelectionV1 } from '@happier-dev/protocol';
import { readSessionModelSelectionIntentSourceV1 } from '@happier-dev/protocol/providers/model-selection';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';

/** Projects provenance of the selected tuple without choosing a model or route. */
export function resolveModelSelectionSource(input: Readonly<{
  selection?: ProviderBoundModelRef | null;
  metadata: Readonly<Record<string, unknown>> | null;
  launchSelection?: SessionModelSelectionV1 | null;
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
  if (source.status === 'canonical') return matches(source.intent.selection) ? 'explicit' : 'inherited';
  if (source.status !== 'absent') return 'inherited';
  const v2 = readSessionModelSelectionV2FromMetadata(metadata);
  if (v2) {
    return matches({
      agentTargetKey: v2.ref.agentTargetKey,
      providerConnectionId: v2.ref.source === 'account_provider_connection' ? v2.ref.providerConnectionId : null,
      modelId: v2.ref.modelId,
    }) ? 'explicit' : 'inherited';
  }
  return input.launchSelection && matches(input.launchSelection.ref) ? 'explicit' : 'inherited';
}
