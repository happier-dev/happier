import type {
  TriageDetailSurfaceInputV1,
  TriageLinkedSessionProjectionV1,
  TriageRowFactNumberFormatV1,
  TriageRowFactStatusToneV1,
  TriageRowFactTimestampFormatV1,
  TriageRowFactV1,
  TriageViewerInvolvementV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * One Overview row the source renders from the host-applied observation.
 *
 * `detailOnly` never reaches this model. A fact the list deliberately defers is a row the detail
 * surface is expected to resolve, so it is reported as pending rather than rendered as a value.
 */
export type BitbucketDetailFieldV1 =
  | Readonly<{ kind: 'text'; id: string; label: string; value: string }>
  | Readonly<{
    kind: 'timestamp';
    id: string;
    label: string;
    atMs: number;
    format: TriageRowFactTimestampFormatV1;
  }>
  | Readonly<{
    kind: 'number';
    id: string;
    label: string;
    value: number;
    format: TriageRowFactNumberFormatV1;
    /** The source could not promise an exact total, so the renderer must not present one. */
    approximate: boolean;
  }>
  | Readonly<{
    kind: 'status';
    id: string;
    label: string;
    value: string;
    tone: TriageRowFactStatusToneV1;
  }>
  | Readonly<{ kind: 'pending'; id: string; label: string }>;

/**
 * The source-owned Overview projection of one mounted Bitbucket detail input.
 *
 * It is derived entirely from the applied observation the host supplies, so it renders before any
 * provider read and stays correct when one fails. The `Activity`, `Diff`, `Builds` and `Comments`
 * tabs are separate provider collections this vertical does not yet read, and this model
 * deliberately declares no placeholder for them: an empty tab and an unbuilt tab must not look
 * alike.
 */
export type BitbucketDetailOverviewV1 = Readonly<{
  title: string;
  summary: string | null;
  scopeLabel: string;
  /** The repository path this entry currently lives at; presentation only, never identity. */
  displayPath: string | null;
  state: Readonly<{
    presentation: 'active' | 'resolved' | 'closed' | 'suppressed' | 'unknown';
    nativeLabel: string | null;
  }>;
  webUrl: string | null;
  /** `true` when the applied snapshot itself was shortened, so the reader is told, not misled. */
  projectionTruncated: boolean;
  fields: readonly BitbucketDetailFieldV1[];
  involvement: readonly TriageViewerInvolvementV1[];
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
  observedAtMs: number;
  sourceUpdatedAtMs: number | null;
}>;

const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'bitbucket/your-review': 'Your review',
  'bitbucket/number': 'Number',
  'bitbucket/author': 'Author',
  'bitbucket/updated': 'Updated',
  'bitbucket/draft': 'Draft',
  'bitbucket/target-branch': 'Target branch',
  'bitbucket/comments': 'Comments',
  'bitbucket/tasks': 'Tasks',
  'bitbucket/reviewers': 'Reviewers',
});

function toDetailField(fact: TriageRowFactV1): BitbucketDetailFieldV1 | null {
  const label = FIELD_LABELS[fact.id] ?? fact.label ?? fact.id;
  switch (fact.value.kind) {
    case 'text':
    case 'actor':
      return { kind: 'text', id: fact.id, label, value: fact.value.value };
    case 'timestamp':
      return {
        kind: 'timestamp',
        id: fact.id,
        label,
        atMs: fact.value.atMs,
        format: fact.value.format,
      };
    case 'number':
      return {
        kind: 'number',
        id: fact.id,
        label,
        value: fact.value.value,
        format: fact.value.format,
        approximate: fact.value.approximate === true,
      };
    case 'status':
      return { kind: 'status', id: fact.id, label, value: fact.value.value, tone: fact.value.tone };
    case 'detailOnly':
      return { kind: 'pending', id: fact.id, label };
    default:
      // An unknown presentation value is skipped and the entry kept: presentation only.
      return null;
  }
}

/**
 * Projects the mounted detail input into the source's Overview model.
 *
 * The bounded linked-Session projection passes through unchanged. A retained link whose Session
 * summary is unavailable keeps its id and loses only its display text; no renderer may read that
 * as "never linked", and this projection never drops such a link.
 */
export function projectBitbucketDetailOverview(
  input: TriageDetailSurfaceInputV1,
): BitbucketDetailOverviewV1 {
  const { snapshot, locator, viewer } = input.observation;
  const fields = snapshot.facts
    .map(toDetailField)
    .filter((field): field is BitbucketDetailFieldV1 => field !== null);

  return {
    title: snapshot.title,
    summary: snapshot.summary ?? null,
    scopeLabel: snapshot.scopeLabel,
    displayPath: locator.displayPath ?? null,
    state: {
      presentation: snapshot.state.presentation,
      nativeLabel: snapshot.state.nativeLabel ?? null,
    },
    webUrl: locator.webUrl ?? null,
    projectionTruncated: snapshot.projectionTruncated === true,
    fields,
    involvement: viewer.involvement,
    linkedSessions: input.linkedSessions,
    observedAtMs: input.observation.observedAtMs,
    sourceUpdatedAtMs: input.observation.sourceUpdatedAtMs ?? null,
  };
}
