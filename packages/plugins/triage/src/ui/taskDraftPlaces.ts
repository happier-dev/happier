import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { TriageEntryRepositoryRefV1 } from '@happier-dev/triage-protocol/v1';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import type { TriageListRowV1 } from '../projection/listWindow.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../internalTasks/identity.js';
import type { TriageListWindowSnapshotV1 } from '../projection/listWindowStore.js';
import { projectTriageUnreadableSourceHealth, readTriageLaneFailure } from '../projection/sourceHealth.js';

export type TriageTaskDraftPlaceV1 = Readonly<{
  source: PluginContributionIdentity;
  sourceInstanceId: string;
  kindId: string;
}>;
export type TriageTaskDraftPlaceSuggestionV1 = TriageTaskDraftPlaceV1 & Readonly<{
  /** A source-native selection identity, never inferred to be a create scope operand. */
  scopeUnitId?: string;
}>;

/** Recommend the built-in Account task only from positive read evidence already held by the window. */
export function defaultTriageTaskDraftPlaceV1(
  places: readonly TriageTaskDraftPlaceV1[], snapshot: TriageListWindowSnapshotV1 | undefined,
): TriageTaskDraftPlaceV1 | undefined {
  const place = places.find(place => sameTriageSourceIdentity(place.source, INTERNAL_TASK_SOURCE_V1) && place.kindId === 'task');
  if (place === undefined || snapshot === undefined) return undefined;
  const lane = snapshot.window?.lanes.find(candidate => candidate.sourceInstanceId === place.sourceInstanceId);
  return lane !== undefined && lane.health.kind !== 'unavailable' && readTriageLaneFailure(lane) === null
    && !projectTriageUnreadableSourceHealth(snapshot).some(unreadable => unreadable.sourceInstance.sourceInstanceId === place.sourceInstanceId)
    ? place : undefined;
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

/**
 * Where the person last created a task: the place of the newest entry they authored that the window already
 * holds. Choice-only, like a suggestion; no source or provider read.
 */
export function recentTriageTaskDraftPlaceV1(rows: readonly TriageListRowV1[]): TriageTaskDraftPlaceSuggestionV1 | undefined {
  let newest: Readonly<{ at: number; place: TriageTaskDraftPlaceSuggestionV1 }> | undefined;
  for (const row of rows) for (const observation of row.observations) {
    if (observation.outcome.kind !== 'present' || !observation.outcome.viewer.involvement.includes('author')) continue;
    const { createdAtMs, scopeUnitId } = observation.outcome.snapshot;
    if (createdAtMs === undefined || (newest !== undefined && newest.at >= createdAtMs)) continue;
    newest = { at: createdAtMs, place: { source: row.entryRef.source, sourceInstanceId: observation.sourceInstanceId,
      kindId: row.entryRef.kindId, ...(scopeUnitId === undefined ? {} : { scopeUnitId }) } };
  }
  return newest?.place;
}
