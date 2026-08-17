import type { BitbucketTriageApiClient } from './apiClient.js';
import type { BitbucketRepositoryRef } from './entries.js';
import type { BitbucketTriageFailure } from './failures.js';
import { BITBUCKET_MAX_PAGE_LENGTH, withBitbucketPageLength } from './pagination.js';
import {
  buildBitbucketWorkspaceRepositoriesUrl,
  listBitbucketWorkspaceRepositories,
} from './pullRequests.js';

/**
 * How many workspace repository-listing pages one scan call may read.
 *
 * The listing is what makes the `review-requested` lane set exist at all, and it is itself paged.
 * Bounding it per call keeps a single scan page's request cost bounded against a 1,000/hour budget
 * while still letting the walk reach every repository: the unread cursor travels in the
 * continuation, so a later page continues the enumeration instead of paying for it again.
 */
export const BITBUCKET_REPOSITORY_PAGES_PER_SCAN_PAGE = 4;

export type BitbucketRepositoryAdvance =
  /** The next repository to walk, in provider list order. */
  | Readonly<{ kind: 'repository'; repositoryUuid: string }>
  /** Every repository this enumeration can reach has been entered. */
  | Readonly<{ kind: 'ended' }>
  /** This call's listing budget is spent; the walk stays open and the next page continues it. */
  | Readonly<{ kind: 'paused' }>
  /** The enumeration cannot be continued, so the workspace can never be called whole. */
  | Readonly<{ kind: 'incomplete' }>
  /** A credential-level or cancellation failure that ends the whole scan. */
  | Readonly<{ kind: 'failed'; failure: BitbucketTriageFailure }>;

export type BitbucketRepositoryEnumerator = Readonly<{
  advance(): Promise<BitbucketRepositoryAdvance>;
  /** The listing cursor a later scan page resumes the enumeration from, or `null` when it ended. */
  cursorUrl(): string | null;
}>;

/**
 * The workspace repository enumeration, entered one repository at a time.
 *
 * A repository the enumeration has not reached is *pending*, not open: it is not part of the lane
 * rotation and costs the continuation nothing. That is what keeps round-robin fairness and a
 * contract-bounded token compatible on the forge whose review involvement is repository-scoped —
 * the frontier carries the listing cursor and the repository being walked, never one entry per
 * repository the workspace owns.
 */
export function createBitbucketRepositoryEnumerator(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    workspaceUuid: string;
    /** The listing cursor carried by a continuation, or `null` on an initial page. */
    resumeUrl: string | null;
    /** The repository a continuation left open, used to locate the successor in provider order. */
    enteredRepositoryUuid: string | null;
    initial: boolean;
    signal?: AbortSignal;
  }>,
): BitbucketRepositoryEnumerator {
  const seedUrl = withBitbucketPageLength(
    buildBitbucketWorkspaceRepositoriesUrl({ workspaceUuid: input.workspaceUuid }),
    BITBUCKET_MAX_PAGE_LENGTH,
  );
  let cursor: string | null = input.initial ? seedUrl : input.resumeUrl;
  let entered: string | null = input.enteredRepositoryUuid;
  let page: Readonly<{
    url: string;
    repositories: readonly BitbucketRepositoryRef[];
    nextUrl: string | null;
  }> | null = null;
  let fetches = 0;

  return {
    cursorUrl: () => cursor,
    async advance(): Promise<BitbucketRepositoryAdvance> {
      for (;;) {
        if (page === null) {
          if (cursor === null) return { kind: 'ended' };
          if (fetches >= BITBUCKET_REPOSITORY_PAGES_PER_SCAN_PAGE) return { kind: 'paused' };
          const requestUrl = cursor;
          fetches += 1;
          const listing = await listBitbucketWorkspaceRepositories({
            client: input.client,
            workspaceUuid: input.workspaceUuid,
            maxPages: 1,
            resumeUrl: requestUrl,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          if (!listing.ok) return { kind: 'failed', failure: listing.failure };
          if (listing.repositories.length === 0 && listing.nextUrl === null) {
            // The listing could not be read at all. An enumeration that stopped short is discovery
            // evidence the walk carries to its settling page, never a smaller complete workspace.
            cursor = null;
            return listing.complete ? { kind: 'ended' } : { kind: 'incomplete' };
          }
          page = { url: requestUrl, repositories: listing.repositories, nextUrl: listing.nextUrl };
        }

        // Repositories are entered in provider list order and advanced by stable uuid. A resumed
        // uuid that is no longer in the page is simply not found: the enumeration continues from
        // the page's first repository rather than claiming a fact about repositories that moved,
        // and repeated involvement converges at the target.
        const index = entered === null
          ? -1
          : page.repositories.findIndex((repository) => repository.uuid === entered);
        const next = page.repositories[index + 1];
        if (next === undefined) {
          cursor = page.nextUrl;
          entered = null;
          page = null;
          continue;
        }

        entered = next.uuid;
        // Resume from this page while it still holds an unentered repository, and from its `next`
        // once the entered repository is its last: either way a later scan page continues the
        // listing instead of re-enumerating the workspace.
        cursor = page.repositories[index + 2] === undefined ? page.nextUrl : page.url;
        return { kind: 'repository', repositoryUuid: next.uuid };
      }
    },
  };
}
