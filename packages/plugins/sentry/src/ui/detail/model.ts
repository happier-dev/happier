/**
 * The Sentry-owned Overview projection of one mounted detail input.
 *
 * It is derived entirely from the host-applied observation the target supplies, so the body
 * paints before any Sentry read and stays truthful when one fails. What it deliberately does
 * **not** project is the common chrome: title, presentation state, scope, attention, viewer
 * involvement and the linked Happier Sessions belong to the aggregate detail shell, which
 * renders and opens them for every source alike. Projecting them here too would make this source
 * a second owner of facts it does not own.
 *
 * The provider-native collections — retained events, the tag distribution and the recorded
 * activity — are separate reads owned by `src/detail/**`; this model states nothing about them,
 * because an empty tab and an unbuilt tab must not look alike.
 *
 * Nothing here reaches a provider, materializes an account, or reconstructs an identity.
 */

import { projectTriageDetailFieldsV1 } from '@happier-dev/triage-protocol/v1';
import type {
  TriageDetailFieldV1,
  TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * One provider-native detail row.
 *
 * Projecting a row fact into a renderable field is the same rule for every Triage
 * source — it is a function of the contract's own closed fact vocabulary — so it is
 * consumed from `@happier-dev/triage-protocol` rather than re-spelled here. What
 * stays with this source is its own fact-id label vocabulary below.
 */
export type SentryDetailFieldV1 = TriageDetailFieldV1;

export type SentryDetailOverviewV1 = Readonly<{
  /** The provider's own one-line culprit summary, when the observation carried one. */
  summary: string | null;
  /** `true` when the applied snapshot itself was shortened, so the reader is told, not misled. */
  projectionTruncated: boolean;
  fields: readonly SentryDetailFieldV1[];
  observedAtMs: number;
  sourceUpdatedAtMs: number | null;
}>;

/**
 * The Sentry fact vocabulary this surface labels.
 *
 * The ids are the ones `sentryIssueMapping` emits. A fact carrying its own `label` wins, because
 * the source that produced the observation knows more than this table; an id with neither is
 * shown as itself rather than dropped.
 */
const FIELD_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({
  'issue-category': 'Category',
  'issue-type': 'Type',
  level: 'Level',
  culprit: 'Culprit',
  unhandled: 'Handling',
  project: 'Project',
  events: 'Events',
  users: 'Users',
  'last-seen': 'Last seen',
  'first-seen': 'First seen',
  assignee: 'Assignee',
  priority: 'Priority',
  'last-release': 'Last release',
});


/** Projects one mounted Sentry detail input into the source-owned Overview model. */
export function projectSentryDetailOverview(
  input: TriageDetailSurfaceInputV1,
): SentryDetailOverviewV1 {
  const { snapshot } = input.observation;
  const fields = projectTriageDetailFieldsV1(snapshot.facts, FIELD_LABELS);

  return {
    summary: snapshot.summary ?? null,
    projectionTruncated: snapshot.projectionTruncated === true,
    fields,
    observedAtMs: input.observation.observedAtMs,
    sourceUpdatedAtMs: input.observation.sourceUpdatedAtMs ?? null,
  };
}
