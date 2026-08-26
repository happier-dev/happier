import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
  type GithubApiResponseV1,
} from '../observations/githubApiClient.js';
import { GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  GITHUB_MISSING_LOCATOR_FAILURE,
  GITHUB_ROUTE_BODY_MISMATCH_FAILURE,
  isGithubSuccessStatus,
} from './errors.js';
import { buildGithubCollisionScope, buildGithubEntryLocalRef } from './identity.js';
import { buildGithubApiUrl, parseGithubRoutingToken, type GithubRepositoryRouteV1 } from './locator.js';
import {
  decodeGithubIssueBody,
  decodeGithubPullRequestBody,
  projectGithubEntry,
} from './mapping/entry.js';
import { createGithubRepositoryReader, type GithubRepositoryReaderV1 } from './repositories.js';
import type {
  GithubTriageEntryLocalRefV1,
  GithubTriageFailureV1,
  GithubTriageObservationV1,
  GithubTriageReviewRevisionV1,
} from './types.js';

/**
 * `get` is the ONLY operation that can conclude absence, and it fails closed.
 *
 * The ref says WHICH entry; the locator says WHERE TO KNOCK. A locator can be stale —
 * that is what a locator is — so a bare `200` never proves that the requested route
 * still holds the requested entry: both the number and the repository scope are
 * validated against the response before anything is called `present`.
 *
 * Recording a permission-masked `404` as `absent` tells a fork contributor "there is no
 * pull request" when there is one they cannot see. That row decides a user-visible
 * outcome, so the ladders below are endpoint-specific and conservative.
 */

export type GithubGetInputV1 = Readonly<{
  localRef: GithubTriageEntryLocalRefV1;
  /** The last-known routing token from the newest source observation. */
  routingToken: unknown;
}>;

export type GithubGetDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
  signal: AbortSignal;
  repositories?: GithubRepositoryReaderV1;
}>;

function unresolved(
  localRef: GithubTriageEntryLocalRefV1,
  failure: GithubTriageFailureV1,
): GithubTriageObservationV1 {
  return Object.freeze({ kind: 'unresolved', localRef, failure });
}

/** An observation that carries no pull-request facts, because none were read. */
function observed(observation: GithubTriageObservationV1): GithubPullRequestReadV1 {
  return Object.freeze({ observation, facts: null });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type GithubIssueRedirectDestinationV1 = Readonly<{
  route: GithubRepositoryRouteV1;
  number: string;
  url: string;
}>;

/**
 * Resolves `Location` against the requested API URL and accepts ONLY a same-origin
 * `https://api.github.com` issue route with no user information, query, or fragment,
 * whose path parses as `/repos/{owner}/{repo}/issues/{number}` with a positive decimal
 * number, and which differs from the requested route.
 *
 * Cross-origin, malformed, non-issue, same-route and second redirects are refused, and
 * credentials are never forwarded to them.
 */
export function validateGithubIssueRedirect(input: Readonly<{
  location: string | null;
  requestedUrl: string;
  requestedRoute: GithubRepositoryRouteV1;
  requestedNumber: string;
}>): GithubIssueRedirectDestinationV1 | null {
  if (input.location === null) return null;
  let url: URL;
  try {
    url = new URL(input.location, input.requestedUrl);
  } catch {
    return null;
  }
  if (url.origin !== GITHUB_API_ORIGIN) return null;
  if (url.username || url.password || url.search || url.hash) return null;

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 5) return null;
  const [repos, owner, name, issues, number] = segments;
  if (repos !== 'repos' || issues !== 'issues') return null;
  if (owner === undefined || name === undefined || number === undefined) return null;
  if (!/^[1-9][0-9]*$/u.test(number)) return null;

  const sameRoute = owner.toLowerCase() === input.requestedRoute.owner.toLowerCase()
    && name.toLowerCase() === input.requestedRoute.name.toLowerCase()
    && number === input.requestedNumber;
  if (sameRoute) return null;

  return Object.freeze({
    route: Object.freeze({ owner, name }),
    number,
    url: url.toString(),
  });
}

async function readRepositoryId(
  repositories: GithubRepositoryReaderV1,
  route: GithubRepositoryRouteV1,
  bodyRepositoryId: string | null,
): Promise<Readonly<{ kind: 'resolved'; repositoryId: string }>
  | Readonly<{ kind: 'failed'; failure: GithubTriageFailureV1 }>> {
  if (bodyRepositoryId !== null) {
    return Object.freeze({ kind: 'resolved', repositoryId: bodyRepositoryId });
  }
  const read = await repositories.read(route);
  return read.kind === 'readable'
    ? Object.freeze({ kind: 'resolved', repositoryId: read.repositoryId })
    : Object.freeze({ kind: 'failed', failure: read.failure });
}

/**
 * The private confirming read behind every `absent`, and its THREE outcomes.
 *
 * A bare `404`/`410` is permission-masked, so absence needs a `200` on the
 * repository with the SAME credential to distinguish "gone" from "you cannot see
 * it". Readability alone is not enough: `owner/name` is a mutable PATH, and a
 * repository can be renamed, deleted or recreated under it. A `200` from a
 * different occupant of the same path proves nothing about the repository this
 * entry belongs to, so `reassigned` is kept apart from `confirmed` — folding it
 * in is how a stale locator manufactures an authoritative absence.
 *
 * The comparison is against the collision scope built by the ONE identity owner,
 * so absence and presence agree on what "the same repository" means.
 */
type GithubRepositoryConfirmationV1 = 'confirmed' | 'reassigned' | 'unreadable';

async function confirmRepositoryIdentity(
  repositories: GithubRepositoryReaderV1,
  route: GithubRepositoryRouteV1,
  collisionScope: string,
): Promise<GithubRepositoryConfirmationV1> {
  const read = await repositories.read(route);
  if (read.kind !== 'readable') return 'unreadable';
  return buildGithubCollisionScope(read.repositoryId) === collisionScope
    ? 'confirmed'
    : 'reassigned';
}

export async function runGithubTriageGet(
  input: GithubGetInputV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubTriageObservationV1> {
  const route = parseGithubRoutingToken(input.routingToken);
  if (route === null) {
    // No outbound call: a path is never guessed from identity, display text or a remote.
    return unresolved(input.localRef, GITHUB_MISSING_LOCATOR_FAILURE);
  }
  const repositories = dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });

  return input.localRef.kindId === 'pull-request'
    ? (await readGithubPullRequest(input.localRef, route, repositories, dependencies)).observation
    : (await readGithubIssue(input.localRef, route, repositories, dependencies)).observation;
}

/**
 * The provider facts a write decision rests on, read from the SAME response the
 * observation is projected from.
 *
 * They are typed rather than re-derived from the projected snapshot because a
 * write must not branch on presentation text: `nativeLabel` is GitHub's own word
 * for the reader, and reading `'Merged'` back out of it to decide whether to
 * merge would make a display string a precondition.
 */
export type GithubPullRequestSourceTipV1 = Readonly<{
  owner: string;
  name: string;
  cloneUrl: string;
  branch: string;
  sourceHeadSha: string;
}>;

export type GithubPullRequestFactsV1 = Readonly<{
  /** The validated provider pull-request number from this reread. */
  number: number;
  /** GitHub's own `state`, trimmed: `open` or `closed`. */
  state: string | null;
  merged: boolean;
  draft: boolean;
  /** The head commit this read observed, or `null` when the response carried none. */
  headRevision: string | null;
  /** The three revisions the public source snapshot can project after this one read. */
  reviewRevision: GithubTriageReviewRevisionV1 | null;
  /** The writable fork/branch facts, never reconstructed from the target repository. */
  sourceTip: GithubPullRequestSourceTipV1 | null;
  /**
   * GitHub's own GraphQL global node id for this pull request, as REST publishes
   * it on `node_id`.
   *
   * It is read from the SAME response the observation is projected from, because
   * a transition GitHub exposes only over GraphQL — draft → ready for review —
   * must address the exact entity this read validated. Rereading it separately
   * would be a second answer to "which pull request is this", which is the one
   * question a write must not get two answers to.
   */
  nodeId: string | null;
}>;

export type GithubPullRequestReadV1 = Readonly<{
  observation: GithubTriageObservationV1;
  /** Present only when the observation is `present`. */
  facts: GithubPullRequestFactsV1 | null;
}>;

function readGithubPullRequestReviewRevision(
  raw: Readonly<Record<string, unknown>>,
  headRevision: string | null,
): GithubTriageReviewRevisionV1 | null {
  const base = isRecord(raw.base) ? raw.base : null;
  const head = isRecord(raw.head) ? raw.head : null;
  const baseSha = base === null ? null : readNonEmptyString(base.sha);
  const headSha = head === null ? null : readNonEmptyString(head.sha);
  if (baseSha === null || headSha === null || headRevision === null || headSha !== headRevision) {
    return null;
  }
  return Object.freeze({ baseSha, headSha, nativeRevision: headRevision });
}

function readGithubPullRequestSourceTip(
  raw: Readonly<Record<string, unknown>>,
  reviewRevision: GithubTriageReviewRevisionV1,
): GithubPullRequestSourceTipV1 | null {
  const head = isRecord(raw.head) ? raw.head : null;
  const repository = head !== null && isRecord(head.repo) ? head.repo : null;
  const owner = repository !== null && isRecord(repository.owner)
    ? readNonEmptyString(repository.owner.login)
    : null;
  const name = repository === null ? null : readNonEmptyString(repository.name);
  const cloneUrl = repository === null ? null : readNonEmptyString(repository.clone_url);
  const branch = head === null ? null : readNonEmptyString(head.ref);
  const sourceHeadSha = head === null ? null : readNonEmptyString(head.sha);
  if (
    owner === null
    || name === null
    || cloneUrl === null
    || branch === null
    || sourceHeadSha === null
    || sourceHeadSha !== reviewRevision.headSha
  ) {
    return null;
  }
  return Object.freeze({ owner, name, cloneUrl, branch, sourceHeadSha });
}

function readGithubPullRequestFacts(
  raw: Readonly<Record<string, unknown>>,
  headRevision: string | null,
  number: number,
): GithubPullRequestFactsV1 {
  const mergedAt = typeof raw.merged_at === 'string' ? raw.merged_at.trim() : '';
  const reviewRevision = readGithubPullRequestReviewRevision(raw, headRevision);
  return Object.freeze({
    number,
    state: typeof raw.state === 'string' && raw.state.trim() ? raw.state.trim() : null,
    // GitHub publishes both; either one alone is enough to prove the merge happened,
    // and requiring both would report an already-merged pull request as unmerged.
    merged: raw.merged === true || mergedAt !== '',
    draft: raw.draft === true,
    headRevision,
    reviewRevision,
    sourceTip: reviewRevision === null ? null : readGithubPullRequestSourceTip(raw, reviewRevision),
    nodeId: typeof raw.node_id === 'string' && raw.node_id.trim() ? raw.node_id.trim() : null,
  });
}

/**
 * The ONE authoritative read of one pull request.
 *
 * `get` consumes its observation; every pull-request write consumes the same
 * observation AND the typed facts its precondition rests on. A second reader
 * would be a second answer to "what does GitHub currently say about this entry",
 * which is exactly the question a write must not get two answers to.
 */
export async function readGithubPullRequest(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubPullRequestReadV1> {
  const url = buildGithubApiUrl(['repos', route.owner, route.name, 'pulls', localRef.entryId]);
  let response: GithubApiResponseV1;
  try {
    response = await dependencies.client.request({ url });
  } catch (error) {
    return observed(unresolved(localRef, classifyGithubTransportFailure(error)));
  }

  if (response.status === 404) {
    // Pull requests do not transfer; they close. The issue-only status contract is NOT
    // generalized onto this endpoint.
    const confirmation = await confirmRepositoryIdentity(
      repositories,
      route,
      localRef.collisionScope,
    );
    if (confirmation === 'confirmed') {
      return observed(Object.freeze({ kind: 'absent' as const, localRef }));
    }
    // A different repository now occupying this path is a stale locator, not a
    // deleted pull request: the route no longer names this entry's repository.
    return observed(unresolved(
      localRef,
      confirmation === 'reassigned'
        ? GITHUB_ROUTE_BODY_MISMATCH_FAILURE
        : classifyGithubResponseFailure(response, dependencies.now()),
    ));
  }
  if (!isGithubSuccessStatus(response.status)) {
    return observed(unresolved(
      localRef,
      classifyGithubResponseFailure(response, dependencies.now()),
    ));
  }

  let body: unknown;
  try {
    body = decodeGithubJsonResponse(response);
  } catch (error) {
    return observed(unresolved(localRef, classifyGithubTransportFailure(error)));
  }
  const view = decodeGithubPullRequestBody(body);
  if (view === null) {
    return observed(unresolved(localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  if (view.number !== localRef.entryId) {
    return observed(unresolved(localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  const number = Number(view.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    return observed(unresolved(localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  const resolved = await readRepositoryId(repositories, route, view.repositoryId);
  if (resolved.kind === 'failed') return observed(unresolved(localRef, resolved.failure));

  const observedRef = buildGithubEntryLocalRef({
    kindId: 'pull-request',
    repositoryId: resolved.repositoryId,
    nativeItemId: view.number,
  });
  if (observedRef === null || observedRef.collisionScope !== localRef.collisionScope) {
    return observed(unresolved(localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }

  const record = isRecord(body) ? body : {};
  const projection = projectGithubEntry(view, resolved.repositoryId, {
    mergeability: mapGithubMergeability(record),
    additionsDeletions: readAdditionsDeletions(record),
  });
  if (projection === null) {
    return observed(unresolved(localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }

  const facts = readGithubPullRequestFacts(record, view.nativeRevision, number);
  return Object.freeze({
    observation: Object.freeze({
      kind: 'present' as const,
      localRef: projection.localRef,
      locator: projection.locator,
      snapshot: facts.reviewRevision === null
        ? projection.snapshot
        : Object.freeze({ ...projection.snapshot, reviewRevision: facts.reviewRevision }),
      viewer: Object.freeze({ involvement: Object.freeze([]) }),
    }),
    facts,
  });
}

/**
 * The provider facts an ISSUE write decision rests on, read from the SAME response
 * the observation is projected from.
 *
 * They are typed rather than re-derived from the projected snapshot for the same
 * reason the pull-request facts are: a write must not branch on presentation text.
 * `labels` and `assignees` are GitHub's own names and logins, untouched — a delta
 * confirms the exact members it named against exactly what GitHub reported.
 */
export type GithubIssueFactsV1 = Readonly<{
  /** GitHub's own `state`, trimmed: `open` or `closed`. */
  state: string | null;
  labels: readonly string[];
  assignees: readonly string[];
}>;

export type GithubIssueReadV1 = Readonly<{
  observation: GithubTriageObservationV1;
  /** Present only when the observation is `present`. */
  facts: GithubIssueFactsV1 | null;
}>;

/** Reads one string member off each element of a GitHub actor/label collection. */
function readNamedMembers(value: unknown, member: string): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : [];
    if (!isRecord(entry)) return [];
    const name = entry[member];
    return typeof name === 'string' && name.trim() ? [name.trim()] : [];
  }));
}

function readGithubIssueFacts(raw: Readonly<Record<string, unknown>>): GithubIssueFactsV1 {
  return Object.freeze({
    state: typeof raw.state === 'string' && raw.state.trim() ? raw.state.trim() : null,
    // GitHub publishes a label as an object with a `name`, and the same field as a
    // bare string on some legacy payloads. Both are read, because a delta that
    // silently saw no labels would report every removal as already satisfied.
    labels: readNamedMembers(raw.labels, 'name'),
    assignees: readNamedMembers(raw.assignees, 'login'),
  });
}

function observedIssue(observation: GithubTriageObservationV1): GithubIssueReadV1 {
  return Object.freeze({ observation, facts: null });
}

/**
 * The ONE authoritative read of one issue.
 *
 * `get` consumes its observation; every issue write consumes the same observation
 * AND the typed facts its precondition rests on. A second reader would be a second
 * answer to "what does GitHub currently say about this entry", which is exactly the
 * question a write must not get two answers to.
 */
export async function readGithubIssue(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubIssueReadV1> {
  const input: GithubGetInputV1 = Object.freeze({ localRef, routingToken: null });
  const url = buildGithubApiUrl([
    'repos',
    route.owner,
    route.name,
    'issues',
    input.localRef.entryId,
  ]);
  let response: GithubApiResponseV1;
  try {
    response = await dependencies.client.requestWithoutFollowingRedirects({ url });
  } catch (error) {
    return observedIssue(unresolved(input.localRef, classifyGithubTransportFailure(error)));
  }

  if (response.status === 301) {
    // A transfer renumbers the entry, so the successor — not this route — is what a
    // later read or write must address. No facts travel with it.
    return observedIssue(
      await followIssueTransfer(input, route, url, response, repositories, dependencies),
    );
  }
  if (response.status === 410) {
    // `410` is the status that actually means deleted, and the confirming repository
    // read is the private proof that this credential could have seen it AND that the
    // path still holds this entry's own repository.
    const confirmation = await confirmRepositoryIdentity(
      repositories,
      route,
      input.localRef.collisionScope,
    );
    if (confirmation === 'confirmed') {
      return observedIssue(Object.freeze({ kind: 'absent', localRef: input.localRef }));
    }
    return observedIssue(unresolved(
      input.localRef,
      confirmation === 'reassigned'
        ? GITHUB_ROUTE_BODY_MISMATCH_FAILURE
        : classifyGithubResponseFailure(response, dependencies.now()),
    ));
  }
  if (response.status === 404) {
    // Transferred OR deleted into a repository this credential cannot read. The old
    // repository reading `200` says NOTHING about the credential's authority at the
    // transfer destination, so a `404` here is compatible with a live issue — it stays
    // unresolved, and no repository read is issued because none can change the arm. A
    // later scan may supply a new locator; only the validated `301` names a successor.
    return observedIssue(unresolved(
      input.localRef,
      classifyGithubResponseFailure(response, dependencies.now()),
    ));
  }
  if (!isGithubSuccessStatus(response.status)) {
    return observedIssue(unresolved(
      input.localRef,
      classifyGithubResponseFailure(response, dependencies.now()),
    ));
  }

  let body: unknown;
  try {
    body = decodeGithubJsonResponse(response);
  } catch (error) {
    return observedIssue(unresolved(input.localRef, classifyGithubTransportFailure(error)));
  }
  const view = decodeGithubIssueBody(body, route);
  if (view === null || view.kindId !== 'issue') {
    return observedIssue(unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  if (view.number !== input.localRef.entryId) {
    return observedIssue(unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  const resolved = await readRepositoryId(repositories, route, view.repositoryId);
  if (resolved.kind === 'failed') {
    return observedIssue(unresolved(input.localRef, resolved.failure));
  }
  if (buildGithubCollisionScope(resolved.repositoryId) !== input.localRef.collisionScope) {
    // An unrelated occupant of a recreated old path is not transfer evidence.
    return observedIssue(unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }

  const projection = projectGithubEntry(view, resolved.repositoryId);
  if (projection === null) {
    return observedIssue(unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  return Object.freeze({
    observation: Object.freeze({
      kind: 'present' as const,
      localRef: projection.localRef,
      locator: projection.locator,
      snapshot: projection.snapshot,
      viewer: Object.freeze({ involvement: Object.freeze([]) }),
    }),
    facts: readGithubIssueFacts(isRecord(body) ? body : {}),
  });
}

async function followIssueTransfer(
  input: GithubGetInputV1,
  route: GithubRepositoryRouteV1,
  requestedUrl: string,
  response: GithubApiResponseV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubTriageObservationV1> {
  const destination = validateGithubIssueRedirect({
    location: readTriageResponseHeaderV1(response.headers, 'location'),
    requestedUrl,
    requestedRoute: route,
    requestedNumber: input.localRef.entryId,
  });
  if (destination === null) return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);

  // Followed exactly ONCE, through the ordinary client: a second redirect is refused by
  // that client's `redirect: 'error'` rather than chased.
  let destinationResponse: GithubApiResponseV1;
  try {
    destinationResponse = await dependencies.client.request({ url: destination.url });
  } catch (error) {
    return unresolved(input.localRef, classifyGithubTransportFailure(error));
  }
  if (!isGithubSuccessStatus(destinationResponse.status)) {
    return unresolved(
      input.localRef,
      classifyGithubResponseFailure(destinationResponse, dependencies.now()),
    );
  }

  let destinationBody: unknown;
  try {
    destinationBody = decodeGithubJsonResponse(destinationResponse);
  } catch (error) {
    return unresolved(input.localRef, classifyGithubTransportFailure(error));
  }
  const destinationView = decodeGithubIssueBody(destinationBody, destination.route);
  if (destinationView === null || destinationView.kindId !== 'issue') {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  // Compared against the DESTINATION route's own number — never the old issue number,
  // because a transfer may renumber.
  if (destinationView.number !== destination.number) {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  const resolved = await readRepositoryId(
    repositories,
    destination.route,
    destinationView.repositoryId,
  );
  if (resolved.kind === 'failed') return unresolved(input.localRef, resolved.failure);

  const successor = buildGithubEntryLocalRef({
    kindId: 'issue',
    repositoryId: resolved.repositoryId,
    nativeItemId: destination.number,
  });
  if (successor === null) return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);

  return Object.freeze({ kind: 'merged', localRef: input.localRef, successor });
}

/**
 * `Computing` is a REAL GitHub state: mergeability is asynchronously derived and
 * `mergeable` is `null` until GitHub finishes. It means "ask again shortly" and must not
 * be collapsed into unresolved, which means "we cannot determine this at all".
 */
export function mapGithubMergeability(
  raw: Readonly<Record<string, unknown>>,
): 'conflicts' | 'blocked' | 'computing' | null {
  const state = typeof raw.mergeable_state === 'string' ? raw.mergeable_state.trim() : '';
  if (raw.mergeable === null || state === 'unknown' || state === '') return 'computing';
  if (raw.mergeable === false || state === 'dirty') return 'conflicts';
  if (state === 'blocked') return 'blocked';
  return null;
}

function readAdditionsDeletions(
  raw: Readonly<Record<string, unknown>>,
): Readonly<{ additions: number; deletions: number }> | null {
  const additions = raw.additions;
  const deletions = raw.deletions;
  if (typeof additions !== 'number' || !Number.isSafeInteger(additions)) return null;
  if (typeof deletions !== 'number' || !Number.isSafeInteger(deletions)) return null;
  return Object.freeze({ additions, deletions });
}
