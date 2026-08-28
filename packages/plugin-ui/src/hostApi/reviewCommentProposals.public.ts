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
}>;

export type ReviewCommentProposalQueryV1 = Readonly<{
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
 * The Reviews Action remains the sole data owner. This hook only owns one mounted read: it follows
 * the canonical cursor to exhaustion, deduplicates the same comment linked through several Sessions,
 * aborts on unmount/query replacement, and persists nothing. Provider surfaces then build only their
 * provider-specific frozen publication plans from the returned canonical comments.
 */
export function useReviewCommentProposalsForEntry(
  query: ReviewCommentProposalQueryV1,
): ReviewCommentProposalReadV1 {
  const host = usePluginHostApi();
  const [state, setState] = React.useState<ReviewCommentProposalReadV1>({
    status: 'loading',
    proposals: [],
  });
  const linkedSessionIdsKey = JSON.stringify(query.linkedSessionIds);
  const entryKey = JSON.stringify(query.entry);

  React.useEffect(() => {
    let current = true;
    const cancellation = new AbortController();
    const linkedSessionIds = JSON.parse(linkedSessionIdsKey) as string[];
    const entry = JSON.parse(entryKey) as ReviewCommentProposalQueryV1['entry'];

    void (async () => {
      // A retained proposal belongs to the prior exact query. Keeping it while an entry or linked
      // Session changes would let a provider build a new target plan around an old comment.
      setState({ status: 'loading', proposals: [] });
      const byId = new Map<string, ReviewCommentProposalWithBodyV1>();
      try {
        // Pull-request links are canonically matched by their provider URL. If this projection has
        // no URL, there is no exact identity to query against; returning an honest empty read avoids
        // both a fuzzy provider match and needless Session scans.
        if (entry.kind === 'pullRequest' && entry.url === undefined) {
          if (current) setState({ status: 'ready', proposals: [] });
          return;
        }
        for (const sessionId of linkedSessionIds) {
          let cursor: string | undefined;
          const seenCursors = new Set<string>();
          do {
            const page = await host.executeAction('reviews.comments.list', {
              sessionId,
              states: ['proposed'],
              taxonomyIds: [],
              includeHistory: false,
              // The canonical Reviews request schema admits at most 200 rows per page.
              limit: 200,
              ...(cursor === undefined ? {} : { cursor }),
            }, { signal: cancellation.signal });
            for (const proposal of page.items) {
              if (hasPublishableContent(proposal) && proposal.linkedRefs?.some((ref) => (
                entry.kind === 'pullRequest'
                  ? ref.kind === 'pullRequest' && ref.url === entry.url
                  : ref.kind === 'issue' && ref.id === entry.id
              ))) byId.set(proposal.id, proposal);
            }
            const next = page.cursor ?? undefined;
            if (next === undefined || seenCursors.has(next)) cursor = undefined;
            else {
              seenCursors.add(next);
              cursor = next;
            }
          } while (cursor !== undefined);
        }
        if (current) {
          setState({ status: 'ready', proposals: Object.freeze([...byId.values()]) });
        }
      } catch {
        if (current) setState({ status: 'failed', proposals: [] });
      }
    })();

    return () => {
      current = false;
      cancellation.abort();
    };
  }, [entryKey, host, linkedSessionIdsKey]);

  return state;
}
