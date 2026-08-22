/**
 * The GitHub-owned body projection of one mounted detail input.
 *
 * It carries ONLY what a GitHub renderer owns. `CONTRACT.md` §7 gives the Triage plugin one
 * permanently mounted common header — the entry title, its source and kind, the observing
 * connection, aggregate freshness, source health, attention, and the bounded Session
 * relationship — and the source body begins directly below it. A source that re-renders those
 * facts is a second renderer of one header: the two drift, and the user reads the same entry
 * described twice, differently.
 *
 * What is left is what only GitHub knows: its own row-fact vocabulary and, for an issue, the
 * `Work Sessions` panel its approved composition names.
 *
 * It is deliberately the projection of the APPLIED OBSERVATION and nothing else. The timeline,
 * changed files, checks and comments are live provider reads, and each is owned by its own panel
 * with its own lifetime (`ui/detail/panelReaders.ts`) rather than being folded in here: a body
 * model that carried them would make the detail root hold four collections a reader may never
 * open, and would spend GitHub's rate budget on every detail mount.
 *
 * The forge sources deliberately keep their own detail bodies. Checks, reviews, worktrees and
 * merge semantics genuinely differ per forge, and a shared four-forge renderer would have to
 * reintroduce those differences as branches.
 */

import { projectTriageDetailFieldsV1 } from '@happier-dev/triage-protocol/v1';
import type {
  TriageDetailFieldV1,
  TriageDetailSurfaceInputV1,
  TriageLinkedSessionProjectionV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * One provider-native detail row.
 *
 * Projecting a row fact into a renderable field is the same rule for every Triage
 * source — it is a function of the contract's own closed fact vocabulary — so it is
 * consumed from `@happier-dev/triage-protocol` rather than re-spelled here. What
 * stays with this source is its own fact-id label vocabulary below.
 */
export type GithubDetailFieldV1 = TriageDetailFieldV1;

export type GithubDetailBodyV1 = Readonly<{
  /**
   * The declared source-local kind id, which selects the composition — not a label. The
   * header names the kind; this is the branch that decides which GitHub panels exist.
   */
  kindId: string;
  fields: readonly GithubDetailFieldV1[];
  /**
   * Rendered only by the issue composition's `Work Sessions` panel. A pull request's
   * Session relationship is a common-header fact, so the body receives the bounded
   * projection unchanged and does not render it.
   */
  linkedSessions: readonly TriageLinkedSessionProjectionV1[];
}>;


/** The GitHub fact vocabulary `triage/mapping/facts.ts` emits. */
const FIELD_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({
  'github/number': 'Number',
  'github/repository': 'Repository',
  'github/author': 'Author',
  'github/updated': 'Updated',
  'github/comments': 'Comments',
  'github/labels': 'Labels',
  'github/review-decision': 'Review',
  'github/checks': 'Checks',
  'github/mergeability': 'Mergeability',
  'github/additions-deletions': 'Changes',
});

/**
 * Projects one mounted GitHub detail input into the source-owned body model.
 *
 * The bounded linked-Session projection passes through unchanged. A retained link whose Session
 * summary is unavailable keeps its id and loses only its display text; no renderer may read that
 * as "never linked", and this projection never drops such a link.
 */
export function projectGithubDetailBody(
  input: TriageDetailSurfaceInputV1,
): GithubDetailBodyV1 {
  const { snapshot, entryRef } = input.observation;
  return {
    kindId: entryRef.kindId,
    fields: projectTriageDetailFieldsV1(snapshot.facts, FIELD_LABELS),
    linkedSessions: input.linkedSessions,
  };
}
