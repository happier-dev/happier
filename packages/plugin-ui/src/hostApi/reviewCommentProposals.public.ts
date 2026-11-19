import * as React from 'react';
import type {
  ReviewCommentSnapshotV1,
  ReviewCommentV1,
} from '@happier-dev/plugin-sdk/reviews';

import { usePluginHostApi } from './context.js';

export type ReviewCommentProposalWithBodyV1 = Omit<ReviewCommentV1, 'body' | 'snapshot'> & Readonly<{
  body: string;
  snapshot: ReviewCommentSnapshotV1;
}>;

export type ReviewCommentProposalReadV1 = Readonly<{
  status: 'loading' | 'ready' | 'failed';
  proposals: readonly ReviewCommentProposalWithBodyV1[];
  /** Requests the next candidate page from the selected Review or linked Sessions. */
  loadMore?: () => void;
}>;

export type ReviewCommentProposalQueryV1 = Readonly<{
  /** The admitted Review is the exact publication scope when present. */
  reviewId?: string;
  linkedSessionIds: readonly string[];
  entry:
    | Readonly<{ kind: 'pullRequest'; url?: string }>
    | Readonly<{ kind: 'issue'; id: string }>;
}>;

function hasPublishableContent(
  proposal: ReviewCommentV1,
): proposal is ReviewCommentProposalWithBodyV1 {
  return typeof proposal.body === 'string'
    && proposal.body.trim().length > 0
    && typeof proposal.snapshot === 'object'
    && proposal.snapshot !== null
    && 'kind' in proposal.snapshot;
}

/**
 * Reads proposed canonical Review comments linked to one exact provider entry.
 *
 * The Reviews Action remains the sole data owner. This hook only owns one mounted read: it requests
 * one candidate page from the selected Review, or per linked Session for legacy entry reads,
 * deduplicates the same comment linked through several Sessions,
 * aborts on unmount/query replacement, and persists nothing. Provider surfaces then build only their
 * provider-specific frozen publication plans from the returned canonical comments. Continuation is
 * explicit even when a page has no matching comments for this entry.
 */
export function useReviewCommentProposalsForEntry(
  query: ReviewCommentProposalQueryV1,
): ReviewCommentProposalReadV1 {
  const host = usePluginHostApi();
  const [state, setState] = React.useState<ReviewCommentProposalReadV1>({
    status: 'loading',
    proposals: [],
  });
  const reviewId = query.reviewId;
  const linkedSessionIdsKey = JSON.stringify(reviewId === undefined ? query.linkedSessionIds : []);
  const entryKey = JSON.stringify(query.entry);

  React.useEffect(() => {
    let current = true;
    const cancellation = new AbortController();
    const linkedSessionIds = JSON.parse(linkedSessionIdsKey) as string[];
    const entry = JSON.parse(entryKey) as ReviewCommentProposalQueryV1['entry'];

    const byId = new Map<string, ReviewCommentProposalWithBodyV1>();
    const cursors = new Map((reviewId === undefined ? linkedSessionIds : [reviewId])
      .map(scopeId => [scopeId, undefined as string | undefined]));
    let pending = false;
    const readNext = async () => {
      if (!current || pending || cursors.size === 0) return;
      pending = true;
      setState(previous => ({ ...previous, status: 'loading' }));
      try {
        // Pull-request links are canonically matched by their provider URL. If this projection has
        // no URL, there is no exact identity to query against; returning an honest empty read avoids
        // both a fuzzy provider match and needless Session scans.
        if (entry.kind === 'pullRequest' && entry.url === undefined) {
          if (current) setState({ status: 'ready', proposals: [] });
          return;
        }
        for (const [scopeId, cursor] of cursors) {
          const page = await host.executeAction('reviews.comments.list', {
            ...(reviewId === undefined ? { sessionId: scopeId } : { reviewId: scopeId }),
            states: ['proposed'],
            taxonomyIds: [],
            includeHistory: false,
            // The canonical Reviews request schema admits at most 200 rows per page.
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          }, { signal: cancellation.signal });
          if (!current) return;
          for (const proposal of page.items) {
            if (hasPublishableContent(proposal) && proposal.linkedRefs?.some((ref) => (
              entry.kind === 'pullRequest'
                ? ref.kind === 'pullRequest' && ref.url === entry.url
                : ref.kind === 'issue' && ref.id === entry.id
            ))) {
              byId.set(proposal.id, proposal);
            }
          }
          const next = page.cursor ?? undefined;
          if (next === undefined || next === cursor) cursors.delete(scopeId);
          else cursors.set(scopeId, next);
        }
        if (current) {
          setState({ status: 'ready', proposals: Object.freeze([...byId.values()]),
            ...(cursors.size === 0 ? {} : { loadMore }) });
        }
      } catch {
        if (current) setState({ status: 'failed', proposals: Object.freeze([...byId.values()]), loadMore });
      } finally {
        pending = false;
      }
    };
    const loadMore = () => { void readNext(); };
    // A retained proposal belongs to the prior exact query. Never attach it to a new entry.
    setState({ status: 'loading', proposals: [] });
    if (cursors.size === 0) setState({ status: 'ready', proposals: [] });
    else loadMore();

    return () => {
      current = false;
      cancellation.abort();
    };
  }, [entryKey, host, linkedSessionIdsKey, reviewId]);

  return state;
}
