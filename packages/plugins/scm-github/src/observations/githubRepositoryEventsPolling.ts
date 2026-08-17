import {
  orderGithubRepositoryEventTimeline,
  type GithubRepositoryTimelineEntryV1,
} from './githubRepositoryEventsCursor.js';

export type GithubRepositoryEventsPageFetchResultV1<TObservation> =
  | Readonly<{
    kind: 'notModified';
    /** Provider instruction observed on the completed conditional response. */
    pollIntervalMs: number | null;
  }>
  | Readonly<{
    kind: 'page';
    etag: string | null;
    nextUrl: string | null;
    events: readonly GithubRepositoryTimelineEntryV1<TObservation>[];
    /** The initial response owns the next poll cadence for this timeline. */
    pollIntervalMs: number | null;
  }>;

export type GithubRepositoryEventsPageFetcherV1<TObservation> = (input: Readonly<{
  url: string;
  /** Only the initial page has the persisted validator. */
  ifNoneMatch: string | null;
}>) => Promise<GithubRepositoryEventsPageFetchResultV1<TObservation>>;

export type GithubRepositoryEventsPollResultV1<TObservation> =
  | Readonly<{ kind: 'notModified'; pollIntervalMs: number | null }>
  | Readonly<{
    kind: 'events';
    etag: string | null;
    events: readonly GithubRepositoryTimelineEntryV1<TObservation>[];
    pollIntervalMs: number | null;
  }>;

const GITHUB_REPOSITORY_EVENTS_TIMELINE_LIMIT = 300;
const GITHUB_REPOSITORY_EVENTS_PAGE_SIZE = 100;
const GITHUB_REPOSITORY_EVENTS_MAX_PAGES = GITHUB_REPOSITORY_EVENTS_TIMELINE_LIMIT
  / GITHUB_REPOSITORY_EVENTS_PAGE_SIZE;

/**
 * A bounded GitHub Events timeline cannot safely advance when pagination or
 * timeline integrity is broken. The observer maps this provider fact to its
 * single source-status owner.
 */
export class GithubRepositoryEventsHistoryGapError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Follows the API's `rel="next"` URLs instead of manufacturing page numbers.
 * The caller owns authenticated HTTP; this provider adapter owns only GitHub
 * pagination and its response-order-independent timeline normalization.
 */
export async function pollGithubRepositoryEvents<TObservation>(input: Readonly<{
  initialUrl: string;
  etag: string | null;
  getPage: GithubRepositoryEventsPageFetcherV1<TObservation>;
}>): Promise<GithubRepositoryEventsPollResultV1<TObservation>> {
  if (!input.initialUrl) throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events requires an initial request URL');

  const visitedUrls = new Set<string>();
  const events: GithubRepositoryTimelineEntryV1<TObservation>[] = [];
  let nextUrl: string | null = input.initialUrl;
  let isInitialPage = true;
  let initialEtag: string | null = null;
  let initialPollIntervalMs: number | null = null;
  let pageCount = 0;

  while (nextUrl !== null) {
    if (pageCount >= GITHUB_REPOSITORY_EVENTS_MAX_PAGES) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events exceeded its three-page timeline window');
    }
    if (visitedUrls.has(nextUrl)) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events pagination repeated a next URL');
    }
    visitedUrls.add(nextUrl);
    pageCount += 1;

    const page = await input.getPage({
      url: nextUrl,
      ifNoneMatch: isInitialPage ? input.etag : null,
    });
    if (page.kind === 'notModified') {
      if (!isInitialPage) {
        throw new GithubRepositoryEventsHistoryGapError('Only the initial GitHub repository Events page may be conditionally not modified');
      }
      return Object.freeze({ kind: 'notModified', pollIntervalMs: page.pollIntervalMs });
    }

    if (isInitialPage) {
      initialEtag = page.etag;
      initialPollIntervalMs = page.pollIntervalMs;
    }
    events.push(...page.events);
    if (events.length > GITHUB_REPOSITORY_EVENTS_TIMELINE_LIMIT) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events exceeded its 300-entry timeline bound');
    }
    nextUrl = page.nextUrl;
    isInitialPage = false;
  }

  try {
    return Object.freeze({
      kind: 'events',
      etag: initialEtag,
      events: orderGithubRepositoryEventTimeline(events),
      pollIntervalMs: initialPollIntervalMs,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new GithubRepositoryEventsHistoryGapError(error.message);
    }
    throw error;
  }
}
