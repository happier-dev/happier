import type {
  TriageLinkedSessionProjectionV1,
  TriageSourceDescriptorV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import type { ProjectedObservationV1 } from '../../corpus/fold/projectedObservation.js';
import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';
import { readTriageLaneFailure } from '../../projection/sourceHealth.js';

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
 * The source's own name and its own name for this entry kind come from the
 * contributor's declared descriptor, read from this physical mount's exact
 * host-stamped targeted snapshot. The shell uses the target-owned admission
 * helper and never takes a second daemon-side descriptor read. What is left
 * here is the naming — which of the
 * declared kinds this entry is, and what the source calls it — and that is the
 * §2.2 decision this projection exists to make in one place.
 */

export type TriageDetailHeaderV1 = Readonly<{
  title: string;
  /** What the source calls itself, when its contribution is currently admitted. */
  sourceLabel: string | null;
  /**
   * What the source calls this entry's kind.
   *
   * `null` covers both "no admitted contribution to ask" and "admitted, and its
   * declared vocabulary does not contain this kind". The raw `kindId` is never
   * substituted: it is a routing token the source chose, and showing it would
   * present an internal identifier as the source's own word for the thing.
   */
  kindLabel: string | null;
  /**
   * The source-neutral workflow subject of this entry's declared kind.
   *
   * It comes from the SAME declared-kind lookup `kindLabel` does, because they
   * are two readings of one descriptor entry and a second lookup is how a header
   * ends up calling something a pull request while the controls beside it offer
   * an issue's actions. `null` covers both "no admitted contribution to ask" and
   * "admitted, and its declared vocabulary does not contain this kind": the
   * header can still name the entry, but nothing may be offered on a subject
   * nobody has declared.
   */
  workflowSubject: TriageSourceWorkflowSubjectV1 | null;
  scopeLabel: string | null;
  /** The provider's own state word when it sent one. */
  stateLabel: string | null;
  /** The configured connection this detail is being read through. */
  connectionLabel: string | null;
  /** Why this entry is asking for the reader, in the source's own words. */
  attention: Readonly<{ level: 'required' | 'suggested'; reasonLabel: string }> | null;
  /** How the aggregate's own knowledge of this entry stands right now. */
  presence: 'present' | 'absent' | 'unresolved';
  /**
   * The connection this detail is read through answered the last pass with a
   * typed failure.
   *
   * A connection the pass never asked is not one of these and never will be:
   * `projection/sourceHealth.ts` owns that distinction, and collapsing it here
   * is how the header came to tell a reader that a connection nothing asked
   * "did not answer".
   */
  sourceReadFailed: boolean;
  webUrl: string | null;
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
  linkedSessionsHasMore: boolean;
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
  /**
   * The entry's source's declared descriptor, as the target parsed it from the
   * mounted snapshot. `null` for a source with no currently admitted V1
   * contribution.
   */
  sourceDescriptor: TriageSourceDescriptorV1 | null;
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
  linkedSessionsHasMore: boolean;
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

  const descriptor = input.sourceDescriptor;
  const kind = descriptor?.kinds.find((candidate) => candidate.id === row.entryRef.kindId);

  return Object.freeze({
    // An entry with no present answer anywhere still has an identity, and its
    // own provider id is the only truthful thing left to name it by.
    title: present?.snapshot.title ?? row.entryRef.entryId,
    sourceLabel: descriptor?.displayName ?? null,
    kindLabel: kind?.displayName ?? null,
    workflowSubject: kind?.workflowSubject ?? null,
    scopeLabel: present?.snapshot.scopeLabel ?? null,
    stateLabel: present?.snapshot.state.nativeLabel ?? null,
    connectionLabel: input.connectionLabel,
    attention: row.attention === null ? null : Object.freeze({
      level: row.attention.level,
      reasonLabel: row.attention.reasonLabel,
    }),
    presence: row.presence.kind,
    // Only the connection this detail runs under, and only through the one
    // health owner. Another connection failing is aggregate list health and is
    // already said beside the list; repeating it here would attribute it to the
    // entry on screen.
    sourceReadFailed: readTriageLaneFailure(lane) !== null,
    webUrl: present?.locator.webUrl ?? null,
    linkedSessions: input.linkedSessions,
    linkedSessionsHasMore: input.linkedSessionsHasMore,
  });
}
