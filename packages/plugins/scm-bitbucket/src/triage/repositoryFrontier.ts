import type { BitbucketTriageApiClient } from './apiClient.js';
import type { BitbucketRepositoryRef } from './entries.js';
import type { BitbucketTriageFailure } from './failures.js';
import { BITBUCKET_MAX_PAGE_LENGTH, withBitbucketPageLength } from './pagination.js';
import {
  buildBitbucketWorkspaceRepositoriesUrl,
  listBitbucketWorkspaceRepositories,
} from './pullRequests.js';

/**
 * How many provider requests the repository enumeration may cost one scan call.
 *
 * The listing is what makes the review lane set exist at all, and it is itself paged. Bounding
 * the enumeration per call keeps a single scan page's request cost bounded against the documented
 * `/2.0/repositories/*` rate band — 1,000/hour at its floor — while still letting the walk reach
 * every repository: the unread cursor travels in the continuation, so a later page continues the
 * enumeration instead of paying for it again.
 *
 * It counts REPOSITORIES ENTERED as well as listing pages fetched, because both cost exactly one
 * serial provider request and the entries are by far the larger number. Counting only the listing
 * pages bounded the cheap half and left the expensive half free: one listing page names up to
 * `BITBUCKET_MAX_PAGE_LENGTH` repositories, so four listing pages authorised four hundred serial
 * pull-request requests inside one page a person was waiting on — and a repository with no open
 * pull requests answers zero rows, so the walk's row budget could never stop it either.
 *
 * Nothing is refused when it is reached. The enumeration reports `paused`, the walk stays open,
 * and the very next scan page continues from the same cursor.
 */
export const BITBUCKET_REPOSITORY_REQUESTS_PER_SCAN_PAGE = 4;

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
  // One counter for both costs: a listing fetch and a repository entered are one request each.
  let spent = 0;

  return {
    cursorUrl: () => cursor,
    async advance(): Promise<BitbucketRepositoryAdvance> {
      for (;;) {
        if (page === null) {
          if (cursor === null) return { kind: 'ended' };
          if (spent >= BITBUCKET_REPOSITORY_REQUESTS_PER_SCAN_PAGE) return { kind: 'paused' };
          const requestUrl = cursor;
          spent += 1;
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

        if (spent >= BITBUCKET_REPOSITORY_REQUESTS_PER_SCAN_PAGE) return { kind: 'paused' };
        spent += 1;
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
