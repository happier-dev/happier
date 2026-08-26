import { BITBUCKET_CLOUD_API_BASE_URL, type BitbucketTriageApiClient } from './apiClient.js';
import {
  decodeBitbucketPullRequestRow,
  decodeBitbucketRepositoryRow,
  decodeBitbucketWorkspaceAccessRow,
  type BitbucketPullRequestEntry,
  type BitbucketRepositoryRef,
  type BitbucketWorkspaceRef,
} from './entries.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from './failures.js';
import { encodeBitbucketPathSegment } from './identity.js';
import {
  decodeBitbucketPageEnvelope,
  resolveBitbucketNextPageUrl,
  withBitbucketPageLength,
  type BitbucketPageGeometry,
} from './pagination.js';
import type { BitbucketRepositoryEnumerator } from './repositoryFrontier.js';
import {
  BITBUCKET_WALK_HEALTH_REASONS,
  type BitbucketWalkHealthReason,
} from './scanContinuation.js';
import { walkBitbucketCollection } from './collection.js';

export const BITBUCKET_TRIAGE_LANE_IDS = [
  'authored',
  'review-requested',
  'reviewed',
  'assigned',
  'mentioned',
] as const;

export type BitbucketLaneId = (typeof BITBUCKET_TRIAGE_LANE_IDS)[number];

export type BitbucketLaneAvailability =
  | Readonly<{ kind: 'available' }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

/**
 * Two of the five canonical lanes cannot be served by Bitbucket Cloud, and each is declared rather
 * than silently returned empty.
 *
 * - `assigned`: pull requests have no assignee concept, and Cloud Issues are out of scope.
 * - `mentioned`: Cloud exposes no mention lane.
 *
 * `reviewed` is served. Atlassian omits `participants` from the pull-request collection by default
 * and says why — "it would impact performance too much" — in the same section that documents
 * `fields` as the parameter for overriding exactly such defaults, and the additive projection does
 * restore the list on a collection page, with `approved`, `state`, `role` and the participant's own
 * uuid intact. Identity and approval arrive inside one participant object, so binding "this viewer"
 * to "this approval" needs no cross-element inference.
 */
export function readBitbucketLaneAvailability(laneId: BitbucketLaneId): BitbucketLaneAvailability {
  switch (laneId) {
    case 'authored':
    case 'review-requested':
    case 'reviewed':
      return { kind: 'available' };
    case 'assigned':
      return { kind: 'unavailable', reason: 'bitbucket-assignee-lane-unavailable' };
    case 'mentioned':
      return { kind: 'unavailable', reason: 'bitbucket-mentioned-lane-unavailable' };
    default:
      return { kind: 'unavailable', reason: 'bitbucket-lane-unknown' };
  }
}

export { withBitbucketPageLength };

/**
 * The workspace-scoped selected-user route: "Returns all workspace pull requests authored by the
 * specified user." It is authored-only and is never presented as account-wide review discovery.
 */
export function buildBitbucketAuthoredLaneUrl(
  input: Readonly<{ workspaceUuid: string; accountUuid: string }>,
): string {
  const workspace = encodeBitbucketPathSegment(input.workspaceUuid);
  const account = encodeBitbucketPathSegment(input.accountUuid);
  return `${BITBUCKET_CLOUD_API_BASE_URL}/workspaces/${workspace}/pullrequests/${account}?state=OPEN`;
}

/**
 * The additive partial-response projection that restores the two lists the pull-request collection
 * omits by default. It is additive rather than omit-all-but-specified so the row keeps every
 * default field the entry decoder and the row projection read, and so a later field addition cannot
 * be silently dropped by an enumeration nobody remembered to extend.
 */
export const BITBUCKET_REVIEW_LANE_FIELDS_PROJECTION = '+values.reviewers,+values.participants';

/**
 * The one repository-scoped walk that serves both review lanes.
 *
 * It is deliberately unfiltered. `reviewers.uuid` is the only reviewer predicate BBQL accepts, and
 * filtering on it would define the walk as "pull requests you were asked to review" — which is not
 * what `reviewed` means. Bitbucket's own participants contract includes users who "are not explicit
 * reviewers, but have approved the pull request", and such a pull request can carry an empty
 * `reviewers` list and not one participant in the `REVIEWER` role, so the filtered walk would report
 * that approval as nonexistent. Every `participants.*` predicate is refused outright — `400 Field
 * ".participants.approved" does not support filtering` — so there is no narrower server-side form to
 * fall back to and no silently-accepted predicate to guess wrong.
 *
 * The cost of dropping the filter is bounded: the scan was already O(repositories), and a repository
 * whose open pull requests fit one native page still costs exactly one request. Only repositories
 * above that add pages, and the walk's existing budget, frontier and continuation are what bound
 * them. The involvement predicate the filter used to express is evaluated instead against the
 * evidence each row now carries, where identity and approval sit in the same participant object.
 */
export function buildBitbucketRepositoryReviewLaneUrl(
  input: Readonly<{ workspaceUuid: string; repositoryUuid: string }>,
): string {
  const workspace = encodeBitbucketPathSegment(input.workspaceUuid);
  const repository = encodeBitbucketPathSegment(input.repositoryUuid);
  const url = new URL(
    `${BITBUCKET_CLOUD_API_BASE_URL}/repositories/${workspace}/${repository}/pullrequests`,
  );
  url.searchParams.set('state', 'OPEN');
  url.searchParams.set('fields', BITBUCKET_REVIEW_LANE_FIELDS_PROJECTION);
  return url.toString();
}

export function buildBitbucketPullRequestUrl(
  input: Readonly<{ workspaceUuid: string; repositoryUuid: string; entryId: string }>,
): string {
  const workspace = encodeBitbucketPathSegment(input.workspaceUuid);
  const repository = encodeBitbucketPathSegment(input.repositoryUuid);
  const entry = encodeBitbucketPathSegment(input.entryId);
  return `${BITBUCKET_CLOUD_API_BASE_URL}/repositories/${workspace}/${repository}/pullrequests/${entry}`;
}

/** The supported route; `GET /2.0/workspaces` is deprecated in Atlassian's own schema. */
export function buildBitbucketUserWorkspacesUrl(): string {
  return `${BITBUCKET_CLOUD_API_BASE_URL}/user/workspaces`;
}

export function buildBitbucketWorkspaceRepositoriesUrl(
  input: Readonly<{ workspaceUuid: string }>,
): string {
  const workspace = encodeBitbucketPathSegment(input.workspaceUuid);
  return `${BITBUCKET_CLOUD_API_BASE_URL}/repositories/${workspace}`;
}

export type BitbucketInvolvement = 'author' | 'reviewRequested' | 'participating';

/**
 * One row this walk read, together with the involvement its own route proves.
 *
 * The workspace-wide route returns "all workspace pull requests authored by the specified user", so
 * every row it returns is authored by this credential and the route itself is proof. The repository
 * review route proves nothing: it is unfiltered, so the rows it returns include pull requests this
 * credential has no relationship to at all. `null` says exactly that, and leaves the involvement
 * question to the row's own reviewer and participant evidence rather than letting the route assert
 * an involvement it did not establish.
 */
export type BitbucketScanObservation = Readonly<{
  routeInvolvement: BitbucketInvolvement | null;
  entry: BitbucketPullRequestEntry;
}>;

/** The state one lane carries between scan pages: a validated provider `next`, or its seed. */
export type BitbucketScanLaneFrontier = Readonly<{ nextUrl: string | null; ended: boolean }>;

export type BitbucketScanWalkFrontier = Readonly<{
  /** Rotation position within the lanes still open, in `[authored, repository]` order. */
  nextLaneIndex: number;
  authored: BitbucketScanLaneFrontier;
  /** The one repository being walked; every other workspace repository is pending, not open. */
  currentRepository: Readonly<{
    repositoryUuid: string;
    lane: BitbucketScanLaneFrontier;
  }> | null;
}>;

export type BitbucketScanOutcome =
  | Readonly<{
    ok: true;
    observations: readonly BitbucketScanObservation[];
    /** Rows this page dropped by tolerant decoding; a per-call number, never a walk total. */
    omittedItemCount: number;
    /** The walk-level facts that must still be true on the call that settles the walk. */
    walkHealth: readonly BitbucketWalkHealthReason[];
    /**
     * This call's own page-shape fact: it stopped on a budget of its own with work still pending —
     * either another whole native page that did not fit the row budget, or a repository enumeration
     * that reached its per-call request budget. One reason, because it is one fact: the caller was
     * not told the walk finished, it was told this call's allowance ran out.
     */
    projectionBudget: boolean;
    frontier: BitbucketScanWalkFrontier;
    /** Whether any lane or the repository enumeration is still open after this page. */
    walkOpen: boolean;
  }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/**
 * A credential-level failure ends the whole scan rather than one lane: every remaining lane uses
 * the same authorization and would fail identically, and a rate limit must reach the caller with
 * its deadline instead of being spent lane by lane.
 */
function isScanTerminatingFailure(failure: BitbucketTriageFailure): boolean {
  return failure.class === 'cancelled'
    || failure.class === 'rateLimit'
    || failure.class === 'authentication';
}

type BitbucketWalkLane = {
  /** The involvement this route proves on its own, or `null` when only the row can prove it. */
  routeInvolvement: BitbucketInvolvement | null;
  /** Whether this route asked for the participant projection the review lanes are read from. */
  projectsReviewEvidence: boolean;
  repositoryUuid: string | null;
  url: string;
  /** `true` when `url` is a provider-issued `next` rather than this lane's own seed URL. */
  advanced: boolean;
  ended: boolean;
};

/**
 * One bounded Bitbucket scan page.
 *
 * `geometry.scanLimit` is this call's raw-row budget, not a whole-account walk allowance. The call
 * fills up to that budget and then settles: whatever remains open travels back in the returned
 * frontier so the caller can issue a continuation, and only an all-lanes-ended walk over a finished
 * repository enumeration has nothing left to carry.
 *
 * Lane selection is round-robin over two PLANES — the workspace-wide `authored` route, and the
 * repository review route — and deliberately not a fixed N-way split of the budget. This forge's
 * review involvement is repository-scoped, so the lane set is discovered *during* the invocation
 * and still growing while the walk runs; N is unknown when the budget is bound. The repository
 * plane's own turn is what enters the next repository, so a workspace with review work waiting is
 * never queued behind an account's own pull requests; the remaining repositories stay pending, in
 * the listing cursor, until the plane's turn comes round again.
 *
 * Nothing about the walk survives cancellation, interruption, or settlement, and no arm of this
 * function can produce an absence conclusion.
 */
export async function scanBitbucketPullRequests(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    geometry: BitbucketPageGeometry;
    /** The workspace-wide authored collection this walk rebuilds an unadvanced lane from. */
    authoredSeedUrl: string;
    authored: BitbucketScanLaneFrontier;
    currentRepository: Readonly<{
      repositoryUuid: string;
      lane: BitbucketScanLaneFrontier;
    }> | null;
    nextLaneIndex: number;
    buildRepositoryLaneUrl: (repositoryUuid: string) => string;
    repositories: BitbucketRepositoryEnumerator;
    unavailableLanes?: readonly Readonly<{ laneId: BitbucketLaneId; reason: string }>[];
    /** The sticky health this walk already established on an earlier page. */
    carriedWalkHealth?: readonly BitbucketWalkHealthReason[];
    signal?: AbortSignal;
  }>,
): Promise<BitbucketScanOutcome> {
  // Read through a call so the abort state is re-observed on every pass: a signal can abort at any
  // point during the walk, and a narrowed property check would silently freeze the first reading.
  const isCancelled = (): boolean => input.signal?.aborted === true;

  if (isCancelled()) {
    return { ok: false, failure: createBitbucketFailure('cancelled', 'invocation-cancelled') };
  }

  const nativePageSize = input.geometry.nativePageSize;
  const health = new Set<BitbucketWalkHealthReason>(input.carriedWalkHealth ?? []);
  if ((input.unavailableLanes?.length ?? 0) > 0) health.add('lane-unavailable');

  const seedLane = (
    routeInvolvement: BitbucketInvolvement | null,
    repositoryUuid: string | null,
    seedUrl: string,
    carried: BitbucketScanLaneFrontier,
  ): BitbucketWalkLane => ({
    routeInvolvement,
    projectsReviewEvidence: repositoryUuid !== null,
    repositoryUuid,
    // An unadvanced carried lane rebuilds the seed this source built for it in the first place;
    // that is not constructing a provider `next`, which is only ever followed verbatim.
    url: carried.nextUrl ?? withBitbucketPageLength(seedUrl, nativePageSize),
    advanced: carried.nextUrl !== null,
    ended: carried.ended,
  });

  const authoredLane = seedLane('author', null, input.authoredSeedUrl, input.authored);
  let repositoryLane: BitbucketWalkLane | null = input.currentRepository === null
    ? null
    : seedLane(
      null,
      input.currentRepository.repositoryUuid,
      input.buildRepositoryLaneUrl(input.currentRepository.repositoryUuid),
      input.currentRepository.lane,
    );

  const isOpen = (lane: BitbucketWalkLane | null): boolean => lane !== null && !lane.ended;

  /**
   * Whether the repository REVIEW PLANE can still produce a page in this call.
   *
   * The plane is not the same thing as the one repository lane that happens to be open: a
   * workspace whose enumeration has not yet named a repository still has review work waiting.
   * Treating an unopened plane as closed is what let the workspace-wide `authored` lane hold the
   * rotation for the whole walk — reviews waiting on the reader were reachable only after their
   * own pull requests ran out, which on a busy account is never.
   */
  let repositoryPlaneSettled = false;
  const isRepositoryPlaneOpen = (): boolean => !repositoryPlaneSettled
    && (isOpen(repositoryLane) || input.repositories.cursorUrl() !== null);

  // Rotation resumes where the previous page stopped. A stale position can only decide which of
  // two open planes goes first — the selector below scans both, so it can never skip one.
  let slot = input.nextLaneIndex === 1 ? 1 : 0;

  const selectPlane = (): 'authored' | 'repository' | null => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const index = (slot + attempt) % 2;
      const open = index === 0 ? isOpen(authoredLane) : isRepositoryPlaneOpen();
      if (open) {
        slot = (index + 1) % 2;
        return index === 0 ? 'authored' : 'repository';
      }
    }
    return null;
  };

  const observations: BitbucketScanObservation[] = [];
  let omittedItemCount = 0;
  let remaining = input.geometry.scanLimit;
  let stoppedOnBudget = false;


  for (;;) {
    if (isCancelled()) {
      return { ok: false, failure: createBitbucketFailure('cancelled', 'invocation-cancelled') };
    }

    // A whole native page is the smallest unit this walk can consume, so a remainder that cannot
    // hold one ends the page rather than fetching rows the result would have to discard.
    if (remaining < nativePageSize) {
      stoppedOnBudget = true;
      break;
    }

    const plane = selectPlane();
    if (plane === null) break;

    let lane: BitbucketWalkLane;
    if (plane === 'authored') {
      lane = authoredLane;
    } else {
      if (!isOpen(repositoryLane)) {
        // The plane's turn is what opens the next repository, so entering one is part of the
        // rotation rather than something that happens once every other lane is exhausted.
        const advance = await input.repositories.advance();
        if (advance.kind === 'failed') return { ok: false, failure: advance.failure };
        if (advance.kind === 'incomplete') {
          health.add('repository-enumeration-incomplete');
          repositoryPlaneSettled = true;
          continue;
        }
        if (advance.kind === 'paused') {
          // `paused` settles the plane for THIS call only: the listing cursor travels back in the
          // frontier, so `walkOpen` stays true and the next page continues the enumeration.
          //
          // It is also this call's own page-shape fact, and the page has to report it. A workspace
          // whose first repositories hold no open pull request produces a page with no rows at all,
          // and a page that reported `walkFinished` there told the caller the walk was DONE while
          // handing it a continuation — which the host's non-progress guard reads as a lane that
          // consumed nothing and asks to be called again. That killed the lane and made the reviews
          // behind those repositories unreachable rather than merely deferred.
          stoppedOnBudget = true;
          repositoryPlaneSettled = true;
          continue;
        }
        if (advance.kind === 'ended') {
          repositoryPlaneSettled = true;
          continue;
        }
        repositoryLane = {
          routeInvolvement: null,
          projectsReviewEvidence: true,
          repositoryUuid: advance.repositoryUuid,
          url: withBitbucketPageLength(
            input.buildRepositoryLaneUrl(advance.repositoryUuid),
            nativePageSize,
          ),
          advanced: false,
          ended: false,
        };
      }
      // `isOpen` above guarantees a lane here; the local narrowing is what the compiler needs.
      if (repositoryLane === null) continue;
      lane = repositoryLane;
    }

    const response = await input.client.requestJson({
      url: lane.url,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (!response.ok) {
      if (isScanTerminatingFailure(response.failure)) {
        return { ok: false, failure: response.failure };
      }
      lane.ended = true;
      health.add('lane-unresolved');
      continue;
    }

    const page = decodeBitbucketPageEnvelope(response.body);
    if (!page.ok) {
      lane.ended = true;
      health.add('lane-unresolved');
      continue;
    }

    for (const raw of page.envelope.values) {
      const decoded = decodeBitbucketPullRequestRow(raw);
      if (!decoded.ok) {
        omittedItemCount += 1;
        continue;
      }
      // The review lanes exist only because the projection puts `participants` on a list page. A
      // page that came back without it decodes perfectly and yields no involvement at all, which
      // would read as "nothing is waiting on you" rather than as "this walk could not see". The
      // walk says so instead of publishing that silence as a clean result.
      if (lane.projectsReviewEvidence && decoded.entry.participants === null) {
        health.add('review-evidence-unprojected');
      }
      if (lane.projectsReviewEvidence && decoded.entry.reviewEvidenceIncomplete) {
        health.add('undecodable-items');
      }
      observations.push({ routeInvolvement: lane.routeInvolvement, entry: decoded.entry });
    }

    // Raw cardinality, not decoded cardinality: an omitted row still consumed provider position,
    // and charging only for mapped rows is what lets a page report more rows than the caller
    // allowed once a short page of undecodable rows leaves the budget untouched.
    remaining = Math.max(0, remaining - page.envelope.values.length);

    const next = resolveBitbucketNextPageUrl(page.envelope);
    if (next.kind === 'invalid') {
      lane.ended = true;
      health.add('lane-unresolved');
      continue;
    }
    if (next.kind === 'end') {
      lane.ended = true;
      continue;
    }
    lane.url = next.url;
    lane.advanced = true;
  }

  if (omittedItemCount > 0) health.add('undecodable-items');

  const carriedLane = (lane: BitbucketWalkLane): BitbucketScanLaneFrontier => ({
    nextUrl: lane.advanced ? lane.url : null,
    ended: lane.ended,
  });
  // The repository stays in the frontier once entered even after its lane ends: its stable uuid is
  // how the next page finds the successor in provider list order.
  const currentRepository = repositoryLane === null || repositoryLane.repositoryUuid === null
    ? null
    : { repositoryUuid: repositoryLane.repositoryUuid, lane: carriedLane(repositoryLane) };
  const walkOpen = isOpen(authoredLane)
    || isOpen(repositoryLane)
    || input.repositories.cursorUrl() !== null;

  return {
    ok: true,
    observations,
    omittedItemCount,
    walkHealth: BITBUCKET_WALK_HEALTH_REASONS.filter((reason) => health.has(reason)),
    projectionBudget: stoppedOnBudget && walkOpen,
    frontier: {
      // The rotation position is carried as it stands. Collapsing it to zero whenever one plane
      // is momentarily closed is what made every page restart at the same lane.
      nextLaneIndex: slot,
      authored: carriedLane(authoredLane),
      currentRepository,
    },
    walkOpen,
  };
}

export type BitbucketGetOutcome =
  | Readonly<{ kind: 'present'; entry: BitbucketPullRequestEntry }>
  | Readonly<{ kind: 'unresolved'; failure: BitbucketTriageFailure }>;

/**
 * Bitbucket Cloud V1 never concludes absence. Under a single credential the API cannot distinguish
 * a pull request that was removed from one the caller cannot see, so a `404` — like a redirect, a
 * body mismatch, a `401`, a throttle, a `5xx`, or a transport failure — is unresolved. A declined
 * pull request is `present` with its state, never absent.
 */
export async function getBitbucketPullRequest(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    workspaceUuid: string;
    repositoryUuid: string;
    entryId: string;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketGetOutcome> {
  const response = await input.client.requestJson({
    url: buildBitbucketPullRequestUrl({
      workspaceUuid: input.workspaceUuid,
      repositoryUuid: input.repositoryUuid,
      entryId: input.entryId,
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (!response.ok) return { kind: 'unresolved', failure: response.failure };

  const decoded = decodeBitbucketPullRequestRow(response.body);
  if (!decoded.ok) {
    return {
      kind: 'unresolved',
      failure: createBitbucketFailure('unsupportedContract', 'undecodable-entity'),
    };
  }

  const sameRepository = decoded.entry.repository.uuid === input.repositoryUuid;
  if (!sameRepository || decoded.entry.entryId !== input.entryId) {
    return {
      kind: 'unresolved',
      failure: createBitbucketFailure('unknown', 'route-body-mismatch'),
    };
  }

  return { kind: 'present', entry: decoded.entry };
}

export type BitbucketWorkspaceListOutcome =
  | Readonly<{
    ok: true;
    workspaces: readonly BitbucketWorkspaceRef[];
    complete: boolean;
    nextUrl: string | null;
    failure?: BitbucketTriageFailure;
  }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/**
 * Walks the caller's accessible workspaces. A partial traversal keeps what it saw and says so:
 * an incomplete enumeration is discovery evidence, never a smaller complete workspace set.
 */
export async function listBitbucketWorkspaces(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    pageLength?: number;
    maxPages?: number;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketWorkspaceListOutcome> {
  const outcome = await walkBitbucketCollection<BitbucketWorkspaceRef>({
    client: input.client,
    url: buildBitbucketUserWorkspacesUrl(),
    decode: (raw) => {
      const decoded = decodeBitbucketWorkspaceAccessRow(raw);
      return decoded.ok ? decoded.workspace : null;
    },
    pageCeilingCode: 'workspace-page-ceiling',
    ...(input.pageLength === undefined ? {} : { pageLength: input.pageLength }),
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    workspaces: outcome.items,
    complete: outcome.complete,
    nextUrl: outcome.nextUrl,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
  };
}

export type BitbucketRepositoryListOutcome =
  | Readonly<{
    ok: true;
    repositories: readonly BitbucketRepositoryRef[];
    complete: boolean;
    /** The validated repository-listing `next` a later scan page continues from, or `null`. */
    nextUrl: string | null;
    failure?: BitbucketTriageFailure;
  }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/**
 * Walks one workspace's repository collection. The `review-requested` lane is repository-scoped on
 * this forge — the selected-user pull-request route is authored-only (§5.5) — so review discovery
 * needs this enumeration before it can build any lane.
 */
export async function listBitbucketWorkspaceRepositories(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    workspaceUuid: string;
    pageLength?: number;
    maxPages?: number;
    /** A validated repository-listing `next` from an earlier page of the same scan invocation. */
    resumeUrl?: string;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketRepositoryListOutcome> {
  const outcome = await walkBitbucketCollection<BitbucketRepositoryRef>({
    client: input.client,
    url: buildBitbucketWorkspaceRepositoriesUrl({ workspaceUuid: input.workspaceUuid }),
    ...(input.resumeUrl === undefined ? {} : { resumeUrl: input.resumeUrl }),
    decode: (raw) => {
      const decoded = decodeBitbucketRepositoryRow(raw);
      return decoded.ok ? decoded.repository : null;
    },
    pageCeilingCode: 'repository-page-ceiling',
    ...(input.pageLength === undefined ? {} : { pageLength: input.pageLength }),
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    repositories: outcome.items,
    complete: outcome.complete,
    nextUrl: outcome.nextUrl,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
  };
}
