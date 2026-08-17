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

import type {
  TriageDetailSurfaceInputV1,
  TriageRowFactImportanceV1,
  TriageRowFactNumberFormatV1,
  TriageRowFactStatusToneV1,
  TriageRowFactTimestampFormatV1,
  TriageRowFactV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * One Overview row the source renders from the applied observation.
 *
 * `detailOnly` becomes `pending` rather than a rendered value: a fact the list deliberately
 * defers is one this surface is expected to resolve, and it has not resolved it yet. Showing it
 * as an empty value would claim the provider has nothing.
 */
export type SentryDetailFieldV1 =
  | Readonly<{
    kind: 'text';
    id: string;
    label: string;
    importance: TriageRowFactImportanceV1;
    value: string;
  }>
  | Readonly<{
    kind: 'timestamp';
    id: string;
    label: string;
    importance: TriageRowFactImportanceV1;
    atMs: number;
    format: TriageRowFactTimestampFormatV1;
  }>
  | Readonly<{
    kind: 'number';
    id: string;
    label: string;
    importance: TriageRowFactImportanceV1;
    value: number;
    format: TriageRowFactNumberFormatV1;
    /**
     * A Sentry event or user count is measured over the project's retention window, so it is
     * not a lifetime total. The flag is carried through instead of being flattened away.
     */
    approximate: boolean;
  }>
  | Readonly<{
    kind: 'status';
    id: string;
    label: string;
    importance: TriageRowFactImportanceV1;
    value: string;
    tone: TriageRowFactStatusToneV1;
  }>
  | Readonly<{
    kind: 'pending';
    id: string;
    label: string;
    importance: TriageRowFactImportanceV1;
  }>;

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

function toDetailField(fact: TriageRowFactV1): SentryDetailFieldV1 | null {
  const label = FIELD_LABELS[fact.id] ?? fact.label ?? fact.id;
  const importance = fact.importance;
  switch (fact.value.kind) {
    // An actor is a person or a team; the Overview renders the display name it already carries
    // rather than inventing an avatar identity the contract does not supply.
    case 'text':
    case 'actor':
      return { kind: 'text', id: fact.id, label, importance, value: fact.value.value };
    case 'timestamp':
      return {
        kind: 'timestamp',
        id: fact.id,
        label,
        importance,
        atMs: fact.value.atMs,
        format: fact.value.format,
      };
    case 'number':
      return {
        kind: 'number',
        id: fact.id,
        label,
        importance,
        value: fact.value.value,
        format: fact.value.format,
        approximate: fact.value.approximate === true,
      };
    case 'status':
      return {
        kind: 'status',
        id: fact.id,
        label,
        importance,
        value: fact.value.value,
        tone: fact.value.tone,
      };
    case 'detailOnly':
      return { kind: 'pending', id: fact.id, label, importance };
    default:
      // A value arm this build does not know is presentation-only, so the entry is kept and the
      // single row skipped. It never removes the issue from the surface.
      return null;
  }
}

/** Projects one mounted Sentry detail input into the source-owned Overview model. */
export function projectSentryDetailOverview(
  input: TriageDetailSurfaceInputV1,
): SentryDetailOverviewV1 {
  const { snapshot } = input.observation;
  const fields = snapshot.facts
    .map(toDetailField)
    .filter((field): field is SentryDetailFieldV1 => field !== null);

  return {
    summary: snapshot.summary ?? null,
    projectionTruncated: snapshot.projectionTruncated === true,
    fields,
    observedAtMs: input.observation.observedAtMs,
    sourceUpdatedAtMs: input.observation.sourceUpdatedAtMs ?? null,
  };
}
