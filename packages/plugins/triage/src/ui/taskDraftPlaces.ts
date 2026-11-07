import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { TriageEntryRepositoryRefV1 } from '@happier-dev/triage-protocol/v1';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import type { TriageListRowV1 } from '../projection/listWindow.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../internalTasks/identity.js';

export type TriageTaskDraftPlaceV1 = Readonly<{
  source: PluginContributionIdentity;
  sourceInstanceId: string;
  kindId: string;
}>;
export type TriageTaskDraftPlaceSuggestionV1 = TriageTaskDraftPlaceV1 & Readonly<{
  /** A source-native selection identity, never inferred to be a create scope operand. */
  scopeUnitId?: string;
}>;

/** The built-in Account task is the initial create target among admitted places. */
export function defaultTriageTaskDraftPlaceV1(places: readonly TriageTaskDraftPlaceV1[]): TriageTaskDraftPlaceV1 | undefined {
  return places.find(place => sameTriageSourceIdentity(place.source, INTERNAL_TASK_SOURCE_V1) && place.kindId === 'task');
}

/** Choice-only suggestions from already admitted observations, without a source or provider read. */
export function suggestTriageTaskDraftPlacesV1(
  repository: TriageEntryRepositoryRefV1 | undefined,
  rows: readonly TriageListRowV1[],
  places: readonly TriageTaskDraftPlaceV1[],
): readonly TriageTaskDraftPlaceSuggestionV1[] {
  if (repository === undefined) return [];
  const placesByInstance = new Map<string, TriageTaskDraftPlaceV1[]>();
  for (const place of places) {
    const current = placesByInstance.get(place.sourceInstanceId);
    if (current === undefined) placesByInstance.set(place.sourceInstanceId, [place]);
    else current.push(place);
  }
  const suggestions: TriageTaskDraftPlaceSuggestionV1[] = [];
  const seen = new Set<string>();
  for (const row of rows) for (const observation of row.observations) {
    if (observation.outcome.kind !== 'present'
      || !sameScmHostingRepositoryIdentity(repository, observation.outcome.repository)) continue;
    const scopeUnitId = observation.outcome.snapshot.scopeUnitId;
    for (const place of placesByInstance.get(observation.sourceInstanceId) ?? []) {
      if (!sameTriageSourceIdentity(place.source, row.entryRef.source)) continue;
      const key = JSON.stringify([place.sourceInstanceId, place.kindId, scopeUnitId ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ ...place, ...(scopeUnitId === undefined ? {} : { scopeUnitId }) });
    }
  }
  return suggestions;
}
