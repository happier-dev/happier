import type { BitbucketTriageApiClient } from './apiClient.js';
import type { BitbucketRepositoryRef } from './entries.js';
import type { BitbucketTriageFailure } from './failures.js';
import {
  advanceCursorCycleWalkV1,
  type CursorCycleProbeV1,
  type CursorCycleWalkV1,
} from '@happier-dev/triage-sources/runtime';
import { BITBUCKET_MAX_PAGE_LENGTH, withBitbucketPageLength } from './pagination.js';
import {
  buildBitbucketWorkspaceRepositoriesUrl,
  listBitbucketWorkspaceRepositories,
} from './pullRequests.js';

export type BitbucketRepositoryAdvance =
  /** The next repository to walk, in provider list order. */
  | Readonly<{ kind: 'repository'; repositoryUuid: string }>
  /** Every repository this enumeration can reach has been entered. */
  | Readonly<{ kind: 'ended' }>
  /** The enumeration cannot be continued, so the workspace can never be called whole. */
  | Readonly<{ kind: 'incomplete' }>
  /** A credential-level or cancellation failure that ends the whole scan. */
  | Readonly<{ kind: 'failed'; failure: BitbucketTriageFailure }>;

export type BitbucketRepositoryEnumerator = Readonly<{
  advance(): Promise<BitbucketRepositoryAdvance>;
  /** The listing cursor a later scan page resumes the enumeration from, or `null` when it ended. */
  cursorUrl(): string | null;
  cursorCycleProbe(): CursorCycleProbeV1 | null;
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
    resumeCycleProbe?: CursorCycleProbeV1 | null;
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
  let cursorWalk: CursorCycleWalkV1 | null = cursor === null
    ? null
    : input.resumeCycleProbe == null
      ? (advanceCursorCycleWalkV1(null, cursor) as Extract<ReturnType<typeof advanceCursorCycleWalkV1>, { kind: 'advanced' }>).walk
      : { cursor, probe: input.resumeCycleProbe };
  let entered: string | null = input.enteredRepositoryUuid;
  let page: Readonly<{
    url: string;
    repositories: readonly BitbucketRepositoryRef[];
    requestWalk: CursorCycleWalkV1;
    nextUrl: string | null;
    nextWalk: CursorCycleWalkV1 | null;
  }> | null = null;
  let pageEndsIncomplete = false;
  return {
    cursorUrl: () => cursor,
    cursorCycleProbe: () => cursorWalk?.probe ?? null,
    async advance(): Promise<BitbucketRepositoryAdvance> {
      for (;;) {
        if (page === null) {
          if (cursor === null) return { kind: 'ended' };
          const requestUrl = cursor;
          const requestWalk = cursorWalk;
          if (requestWalk === null) return { kind: 'ended' };
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
          // Preserve repositories already admitted from this page, then report the enumeration as
          // incomplete when its provider cursor points back to the same page. Treating it as an
          // ordinary next would replay this page forever across scan continuations; treating it as
          // end would falsely claim the workspace inventory was exhausted.
          const advanced = listing.nextUrl === null
            ? null
            : advanceCursorCycleWalkV1(requestWalk, listing.nextUrl);
          pageEndsIncomplete = advanced?.kind === 'revisited';
          page = {
            url: requestUrl,
            repositories: listing.repositories,
            requestWalk,
            nextUrl: advanced?.kind === 'advanced' ? advanced.walk.cursor : null,
            nextWalk: advanced?.kind === 'advanced' ? advanced.walk : null,
          };
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
          if (pageEndsIncomplete) {
            cursor = null;
            cursorWalk = null;
            page = null;
            pageEndsIncomplete = false;
            return { kind: 'incomplete' };
          }
          cursor = page.nextUrl;
          cursorWalk = page.nextWalk;
          entered = null;
          page = null;
          continue;
        }

        entered = next.uuid;
        // Resume from this page while it still holds an unentered repository, and from its `next`
        // once the entered repository is its last: either way a later scan page continues the
        // listing instead of re-enumerating the workspace.
        if (page.repositories[index + 2] === undefined) {
          cursor = page.nextUrl;
          cursorWalk = page.nextWalk;
        } else {
          cursor = page.url;
          // Re-fetching the same listing page after a continuation is intentional while its
          // already-entered repository identifies the successor. Keep the probe at this current
          // page; advancing it is reserved for the provider's `next` edge.
          cursorWalk = page.requestWalk;
        }
        return { kind: 'repository', repositoryUuid: next.uuid };
      }
    },
  };
}
