import { mergeProviderCatalogV1 } from '@happier-dev/protocol/providers/catalog/merge';
import type { ProviderCatalogTransitionStateV1, ProviderContributionV1 } from '@happier-dev/protocol';

import type { AgentProviderCatalogObservationResult } from './agentCatalogObservation';

/** Both demand and admission project the observation owner's same transition.
 * Missing observations are declarations; successful empty observations stay empty. */
export function projectAgentCatalogObservationSnapshot(
  catalog: Extract<ProviderContributionV1['catalog'], { source: 'static+probe' | 'probe' }>,
  transition?: ProviderCatalogTransitionStateV1,
  refreshError = transition?.snapshot?.stale ?? true,
): AgentProviderCatalogObservationResult {
  const staticModels = catalog.source === 'static+probe' ? catalog.staticModels : [];
  if (!transition?.snapshot) return { source: 'static', refreshError: true,
    models: staticModels.map(model => ({ ...model })), stale: false };
  const merged = mergeProviderCatalogV1({ staticModels, manualModels: [],
    probeState: transition, membershipPolicy: catalog.membershipPolicy });
  return { source: 'dynamic', stale: transition.snapshot.stale,
    observedAt: transition.snapshot.observedAt, refreshError,
    models: merged.rows.map(row => ({ ...row.descriptor })) };
}
