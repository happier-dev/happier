import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import { locateDocPassageThreadV1, selectDocPassageThreadAnchorMessageV1,
  type DocPassageThreadLocationV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { readDiscussionContentPassage } from '@/components/discussions/discussionComposerDocument';

type ArtifactRevisionV1 = DocPassageRefV1['revision'];

/** The message fields the Doc margin reads; a committed opened Discussion message satisfies it. */
export type DocPassageMarginMessage = Pick<
  DiscussionOpenedMessageV1,
  | 'id'
  | 'discussionId'
  | 'seq'
  | 'authorAccountId'
  | 'createdAt'
  | 'content'
  | 'replyTarget'
  | 'docEditProposalDispositionV1'
> &
  Partial<
    Pick<
      DiscussionOpenedMessageV1,
      'accountActor' | 'producerV1' | 'messageRef'
    >
  >;

export type DocPassageMarginLocation = DocPassageThreadLocationV1;

export type DocPassageMarginThread<
  M extends DocPassageMarginMessage = DocPassageMarginMessage,
> = Readonly<{
  discussionId: string;
  /** The comment basis the thread is placed by: its latest, which a re-attachment moves past the first. */
  passage: DocPassageRefV1;
  /** The passage the thread was started on; the same as `passage` until it is re-attached. */
  original: DocPassageRefV1;
  location: DocPassageMarginLocation;
  /** The quote and its version from the shared placement owner, including when detached. */
  quote: string;
  quoteRevision: ArtifactRevisionV1;
  root: M;
  /** Everything after the passage root, oldest first. */
  replies: readonly M[];
  /** The suggested edit the thread's card shows: the one still open, else the latest decision. */
  proposal: M | null;
  /** The accepted edit the current words derive from, which may precede a later open suggestion. */
  acceptedProposal: M | null;
  /**
   * The open suggestion as it would change the text being read: only while the Doc is at the revision it
   * was based on and its words are still there. The body paints it; otherwise its card shows the diff.
   */
  suggestion: Readonly<{ range: Readonly<{ start: number; end: number }>; after: string }> | null;
}>;

export type DocPassageMarginAccepted = Readonly<{
  deciderAccountId: string;
  proposerAccountId: string | null;
  atMs: number;
  revision: ArtifactRevisionV1;
}>;

/** The words a thread is about as read now: the revised text once its edit is in this version. */
export function readDocPassageThreadQuote(thread: DocPassageMarginThread): string {
  return thread.quote;
}

const sameRevision = (left: ArtifactRevisionV1, right: ArtifactRevisionV1) =>
  left.headerVersion === right.headerVersion &&
  left.bodyVersion === right.bodyVersion;

/**
 * Place each passage thread of a Doc against the revision being read.
 *
 * A passage is found by `locateDocPassageV1` (its stored source range at its own revision, an
 * unambiguous unchanged quote at another; never the first duplicate). Accepted replacement text
 * follows that same placement rule in subsequent revisions.
 */
export function buildDocPassageMargin<M extends DocPassageMarginMessage>(
  input: Readonly<{
    source: string;
    revision: ArtifactRevisionV1;
    threads: readonly Readonly<{
      discussionId: string;
      messages: readonly M[];
    }>[];
  }>,
): Readonly<{
  threads: readonly DocPassageMarginThread<M>[];
  accepted: DocPassageMarginAccepted | null;
  unreadable: number;
}> {
  const threads: DocPassageMarginThread<M>[] = [];
  let accepted: DocPassageMarginAccepted | null = null;
  let unreadable = 0;
  for (const thread of input.threads) {
    const ordered = [...thread.messages].sort(
      (left, right) => left.seq - right.seq,
    );
    const root = ordered.find(
      (message) => message.replyTarget?.kind === 'doc_passage',
    );
    const original = root ? readDiscussionContentPassage(root.content) : null;
    if (!root || !original) {
      unreadable += 1;
      continue;
    }
    // Re-attaching is a later comment with its own passage basis (`doc.comment.reply` without a parent);
    // the thread is placed by the latest readable one and keeps the first as what it was started on.
    const anchor = selectDocPassageThreadAnchorMessageV1(ordered.filter(message => message.content !== null));
    const passage = readDiscussionContentPassage(anchor?.content) ?? original;
    const replies = ordered.filter((message) => message !== root);
    const proposals = ordered.filter(
      (message) =>
        message.content !== null &&
        'kind' in message.content &&
        message.content.kind === 'doc_edit_proposal',
    );
    // Each suggestion keeps its own disposition: the edit in the revision being read is the one
    // accepted into it, whether or not a later suggestion on the same words is still open.
    const { location, quote, quoteRevision, acceptedProposal } = locateDocPassageThreadV1({ target: passage,
      source: input.source, revision: input.revision, messages: ordered });
    // The card shows what a person can still act on, otherwise the latest decision. Accepted placement
    // remains separate: declining a later suggestion must not erase its receipt behind the older Accept.
    const open = [...proposals]
      .reverse()
      .find((message) => (message.docEditProposalDispositionV1?.state ?? 'open') === 'open');
    const proposal = open ?? proposals[proposals.length - 1] ?? null;
    const disposition = acceptedProposal?.docEditProposalDispositionV1;
    if (disposition?.state === 'accepted' && acceptedProposal) {
      if (!accepted || disposition.decidedBy.atMs > accepted.atMs) {
        accepted = {
          deciderAccountId: disposition.decidedBy.accountId,
          proposerAccountId: acceptedProposal.authorAccountId,
          atMs: disposition.decidedBy.atMs,
          revision: disposition.acceptedRevision,
        };
      }
    }
    const openContent = open?.content && 'kind' in open.content && open.content.kind === 'doc_edit_proposal'
      ? open.content.proposal : null;
    const suggestion = openContent && sameRevision(openContent.baseRevision, input.revision)
      && input.source.slice(openContent.target.range.start, openContent.target.range.end) === openContent.before
      ? { range: openContent.target.range, after: openContent.after } : null;
    threads.push({
      discussionId: thread.discussionId,
      passage,
      original,
      location,
      quote,
      quoteRevision,
      root,
      replies,
      proposal,
      acceptedProposal,
      suggestion,
    });
  }
  const position = (thread: DocPassageMarginThread<M>) =>
    thread.location.state === 'detached'
      ? Number.POSITIVE_INFINITY
      : thread.location.range.start;
  threads.sort((left, right) => position(left) - position(right));
  return { threads, accepted, unreadable };
}
