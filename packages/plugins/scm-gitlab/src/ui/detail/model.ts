/**
 * The GitLab-owned body projection of one mounted detail input.
 *
 * It carries ONLY what a GitLab renderer owns. `CONTRACT.md` §7 and `core/SURFACE.md` §2.2 give
 * the Triage plugin one permanently mounted common header — the entry title, its source and kind,
 * the observing connection, aggregate freshness, source health, attention, and the bounded Session
 * relationship — and the source body begins directly below it. A source that re-renders those
 * facts is a second renderer of one header: the two drift, and the user reads the same entry
 * described twice, differently.
 *
 * What is left is what only GitLab knows: its own row-fact vocabulary and, for an issue, the
 * `Work Sessions` panel its approved composition names. Pipelines, approvals, diffs and
 * discussions are live provider reads this vertical does not perform yet, and this model
 * deliberately declares no placeholder for them: an empty tab and an unbuilt tab must not look
 * alike.
 *
 * The forge sources deliberately keep their own detail bodies. Checks, reviews, worktrees and
 * update-branch semantics genuinely differ per forge, and a shared four-forge renderer would have
 * to reintroduce those differences as branches. Extraction, if it happens, comes later from
 * working cases.
 */

import type {
  TriageDetailSurfaceInputV1,
  TriageLinkedSessionProjectionV1,
  TriageRowFactImportanceV1,
  TriageRowFactNumberFormatV1,
  TriageRowFactStatusToneV1,
  TriageRowFactTimestampFormatV1,
  TriageRowFactV1,
} from '@happier-dev/triage-protocol/v1';

/** One GitLab-native fact row the source renders from the applied observation. */
export type GitlabDetailFieldV1 =
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
  /** A fact the list deliberately defers and this build has not resolved yet. */
  | Readonly<{
    kind: 'pending';
    id: string;
    label: string;
    importance: TriageRowFactImportanceV1;
  }>;

export type GitlabDetailBodyV1 = Readonly<{
  /**
   * The declared source-local kind id, which selects the composition — not a label. The
   * header names the kind; this is the branch that decides which GitLab panels exist.
   */
  kindId: string;
  fields: readonly GitlabDetailFieldV1[];
  /**
   * Rendered only by the issue composition's `Work Sessions` panel. A merge request's
   * Session relationship is a common-header fact, so the body receives the bounded
   * projection unchanged and does not render it.
   */
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
}>;

/** The GitLab fact vocabulary `triage/mapping` emits. */
const FIELD_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({
  'gitlab/iid': 'Number',
  'gitlab/author': 'Author',
  'gitlab/comments': 'Comments',
  'gitlab/labels': 'Labels',
  'gitlab/merge-status': 'Merge status',
  'gitlab/approved': 'Approvals',
});

function toDetailField(fact: TriageRowFactV1): GitlabDetailFieldV1 | null {
  const label = FIELD_LABELS[fact.id] ?? fact.label ?? fact.id;
  const importance = fact.importance;
  switch (fact.value.kind) {
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
      // A value arm this build does not know is presentation-only: the row is skipped and the
      // entry kept.
      return null;
  }
}

/**
 * Projects one mounted GitLab detail input into the source-owned body model.
 *
 * The bounded linked-Session projection passes through unchanged. A retained link whose Session
 * summary is unavailable keeps its id and loses only its display text; no renderer may read that
 * as "never linked", and this projection never drops such a link.
 */
export function projectGitlabDetailBody(
  input: TriageDetailSurfaceInputV1,
): GitlabDetailBodyV1 {
  const { snapshot, entryRef } = input.observation;
  return {
    kindId: entryRef.kindId,
    fields: snapshot.facts
      .map(toDetailField)
      .filter((field): field is GitlabDetailFieldV1 => field !== null),
    linkedSessions: input.linkedSessions,
  };
}
