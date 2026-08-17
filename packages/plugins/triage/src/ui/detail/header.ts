import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import type { ProjectedObservationV1 } from '../../corpus/fold/projectedObservation.js';
import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';

/**
 * The aggregate-owned common header of one selected entry.
 *
 * `core/SURFACE.md` §2.2 puts title, source and kind, the selected observing
 * connection, aggregate freshness, source health, attention and the bounded
 * Session relationship in the aggregate — and keeps them out of every source
 * detail body. Three source renderers were caught re-rendering these facts, and
 * the copy that drifts is always the one the reader is looking at, so this is
 * the single projection they come from.
 *
 * Every field is nullable and every null means "not known here", never a
 * placeholder: a connection with no display label loses the label rather than
 * showing an internal UUID.
 *
 * **The source's own name, and its name for this entry kind, are deliberately
 * absent.** §2.2 puts them in this header and the only place they exist is the
 * contributor's declared descriptor, which reaches a mounted surface as raw
 * JSON in the admission snapshot. Decoding it here is exactly the cold UI
 * semantic projection `SDK-EU-26` reserves for the SDK owner, and `PLAN.md`
 * §5.2 forbids a shell-local decoder. The fields land with their producer;
 * they are not carried as always-null members in the meantime.
 */

export type TriageDetailHeaderV1 = Readonly<{
  title: string;
  scopeLabel: string | null;
  /** The provider's own state word when it sent one. */
  stateLabel: string | null;
  /** The configured connection this detail is being read through. */
  connectionLabel: string | null;
  /** Why this entry is asking for the reader, in the source's own words. */
  attention: Readonly<{ level: 'required' | 'suggested'; reasonLabel: string }> | null;
  /** How the aggregate's own knowledge of this entry stands right now. */
  presence: 'present' | 'absent' | 'unresolved';
  /** The selected connection's own health, when it is not answering. */
  sourceUnhealthy: boolean;
  webUrl: string | null;
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
}>;

function selectedObservation(row: TriageListRowV1): ProjectedObservationV1 | null {
  const selectedInstanceId = row.selected.kind === 'selected' ? row.selected.sourceInstanceId : null;
  if (selectedInstanceId !== null) {
    const exact = row.observations.find(
      (candidate) => candidate.sourceInstanceId === selectedInstanceId
        && candidate.outcome.kind === 'present',
    );
    if (exact !== undefined) return exact;
  }
  // A retired or unselectable connection still leaves the reader an entry they
  // recognize: the newest present answer of any connection, exactly as the list
  // row's own display projection falls back.
  let newest: ProjectedObservationV1 | null = null;
  for (const observation of row.observations) {
    if (observation.outcome.kind !== 'present') continue;
    if (newest === null || observation.observedAtMs > newest.observedAtMs) newest = observation;
  }
  return newest;
}

export type TriageDetailHeaderInputV1 = Readonly<{
  row: TriageListRowV1;
  /** The lane set of the window this row was rendered from. */
  lanes: readonly TriageListLaneV1[];
  /** The configured connection's display label, when the aggregate knows one. */
  connectionLabel: string | null;
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
}>;

export function projectTriageDetailHeaderV1(
  input: TriageDetailHeaderInputV1,
): TriageDetailHeaderV1 {
  const { row } = input;
  const observation = selectedObservation(row);
  const present = observation?.outcome.kind === 'present' ? observation.outcome : null;
  const selectedInstanceId = row.selected.kind === 'selected' ? row.selected.sourceInstanceId : null;
  const lane = selectedInstanceId === null
    ? undefined
    : input.lanes.find((candidate) => candidate.sourceInstanceId === selectedInstanceId);

  return Object.freeze({
    // An entry with no present answer anywhere still has an identity, and its
    // own provider id is the only truthful thing left to name it by.
    title: present?.snapshot.title ?? row.entryRef.entryId,
    scopeLabel: present?.snapshot.scopeLabel ?? null,
    stateLabel: present?.snapshot.state.nativeLabel ?? null,
    connectionLabel: input.connectionLabel,
    attention: row.attention === null ? null : Object.freeze({
      level: row.attention.level,
      reasonLabel: row.attention.reasonLabel,
    }),
    presence: row.presence.kind,
    // Only the connection this detail runs under. Another connection failing is
    // aggregate list health and is already said there; repeating it in a
    // detail header would attribute it to the entry on screen.
    sourceUnhealthy: lane?.health.kind === 'failed' || lane?.health.kind === 'unavailable',
    webUrl: present?.locator.webUrl ?? null,
    linkedSessions: input.linkedSessions,
  });
}
