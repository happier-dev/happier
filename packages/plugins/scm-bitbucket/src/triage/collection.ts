import { type BitbucketTriageApiClient } from './apiClient.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from './failures.js';
import {
  BITBUCKET_MAX_PAGE_LENGTH,
  decodeBitbucketPageEnvelope,
  resolveBitbucketNextPageUrl,
  withBitbucketPageLength,
} from './pagination.js';

/**
 * One bounded walk of a Bitbucket paginated collection.
 *
 * A partial traversal keeps what it saw and says so: an incomplete enumeration is discovery
 * evidence, never a smaller complete set. A cancelled walk produces no result at all, because a
 * cancelled enumeration is not a smaller enumeration.
 */
export type BitbucketCollectionOutcome<TItem> =
  | Readonly<{
    ok: true;
    items: readonly TItem[];
    complete: boolean;
    /**
     * The validated provider `next` this walk stopped before fetching, or `null` when the
     * collection ended or stopping was not a page boundary. It is the only thing that lets a later
     * scan page continue an enumeration instead of paying for it again, and it is opaque: it is
     * used verbatim and never reconstructed.
     */
    nextUrl: string | null;
    failure?: BitbucketTriageFailure;
  }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/** Bounded page ceiling for a discovery walk; exceeding it is reported, never silently truncated. */
export const BITBUCKET_COLLECTION_PAGE_CEILING = 50;

/**
 * The single walker for every Bitbucket discovery collection.
 *
 * Workspaces and repositories page identically, so they share one traversal owner rather than two
 * similar-but-different loops that could drift on origin validation, failure attribution, or
 * completeness reporting.
 */
export async function walkBitbucketCollection<TItem>(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    url: string;
    decode: (raw: unknown) => TItem | null;
    /**
     * The code attributed when the walk stops at its page ceiling with the
     * collection still going.
     *
     * Omitted by a caller for whom stopping there is the CONTRACT rather than an
     * anomaly — a mounted detail panel reads exactly one page and offers the
     * reader the frontier. Attributing a failure to that would render a working
     * `Show more` control beside a warning about nothing.
     */
    pageCeilingCode?: string;
    pageLength?: number;
    maxPages?: number;
    /**
     * A provider-issued `next` from an earlier invocation of this same walk. It is followed
     * byte-for-byte, including its own `pagelen`, because Bitbucket documents `next` as an opaque
     * location clients must not construct or assume predictable.
     */
    resumeUrl?: string;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketCollectionOutcome<TItem>> {
  const pageLength = input.pageLength ?? BITBUCKET_MAX_PAGE_LENGTH;
  const maxPages = input.maxPages ?? BITBUCKET_COLLECTION_PAGE_CEILING;
  const items: TItem[] = [];
  let url: string | null = input.resumeUrl ?? withBitbucketPageLength(input.url, pageLength);

  for (let page = 0; page < maxPages; page += 1) {
    if (url === null) return { ok: true, items, complete: true, nextUrl: null };
    if (input.signal?.aborted === true) {
      return { ok: false, failure: createBitbucketFailure('cancelled', 'invocation-cancelled') };
    }

    const response = await input.client.requestJson({
      url,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!response.ok) {
      if (response.failure.class === 'cancelled') return { ok: false, failure: response.failure };
      return { ok: true, items, complete: false, nextUrl: null, failure: response.failure };
    }

    const envelope = decodeBitbucketPageEnvelope(response.body);
    if (!envelope.ok) {
      return { ok: true, items, complete: false, nextUrl: null, failure: envelope.failure };
    }

    for (const raw of envelope.envelope.values) {
      const decoded = input.decode(raw);
      if (decoded !== null) items.push(decoded);
    }

    const next = resolveBitbucketNextPageUrl(envelope.envelope);
    if (next.kind === 'invalid') {
      return { ok: true, items, complete: false, nextUrl: null, failure: next.failure };
    }
    url = next.kind === 'next' ? next.url : null;
  }

  // The collection ended exactly on the last admitted page: a bounded walk that read everything is
  // complete, not truncated.
  if (url === null) return { ok: true, items, complete: true, nextUrl: null };

  // Stopping at the page ceiling leaves an unread frontier. It travels back to the caller so a
  // walk that can resume continues instead of restarting, and it stays attributed for a caller
  // that cannot resume and must report its enumeration incomplete.
  return {
    ok: true,
    items,
    complete: false,
    nextUrl: url,
    ...(input.pageCeilingCode === undefined
      ? {}
      : { failure: createBitbucketFailure('unsupportedContract', input.pageCeilingCode) }),
  };
}
