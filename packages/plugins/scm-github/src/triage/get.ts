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
import { buildGithubEntryLocalRef } from './identity.js';
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1]?.trim() || null;
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
 * The private confirming read behind every `absent`. A bare `404`/`410` is
 * permission-masked; only a `200` on the repository with the SAME credential
 * distinguishes "gone" from "you cannot see it".
 */
async function confirmRepositoryReadable(
  repositories: GithubRepositoryReaderV1,
  route: GithubRepositoryRouteV1,
): Promise<boolean> {
  const read = await repositories.read(route);
  return read.kind === 'readable';
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
    ? getPullRequest(input, route, repositories, dependencies)
    : getIssue(input, route, repositories, dependencies);
}

async function getPullRequest(
  input: GithubGetInputV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubTriageObservationV1> {
  const url = buildGithubApiUrl(['repos', route.owner, route.name, 'pulls', input.localRef.entryId]);
  let response: GithubApiResponseV1;
  try {
    response = await dependencies.client.request({ url });
  } catch (error) {
    return unresolved(input.localRef, classifyGithubTransportFailure(error));
  }

  if (response.status === 404) {
    // Pull requests do not transfer; they close. The issue-only status contract is NOT
    // generalized onto this endpoint.
    return await confirmRepositoryReadable(repositories, route)
      ? Object.freeze({ kind: 'absent', localRef: input.localRef })
      : unresolved(input.localRef, classifyGithubResponseFailure(response, dependencies.now()));
  }
  if (!isGithubSuccessStatus(response.status)) {
    return unresolved(input.localRef, classifyGithubResponseFailure(response, dependencies.now()));
  }

  let body: unknown;
  try {
    body = decodeGithubJsonResponse(response);
  } catch (error) {
    return unresolved(input.localRef, classifyGithubTransportFailure(error));
  }
  const view = decodeGithubPullRequestBody(body);
  if (view === null) {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  if (view.number !== input.localRef.entryId) {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  const resolved = await readRepositoryId(repositories, route, view.repositoryId);
  if (resolved.kind === 'failed') return unresolved(input.localRef, resolved.failure);

  const localRef = buildGithubEntryLocalRef({
    kindId: 'pull-request',
    repositoryId: resolved.repositoryId,
    nativeItemId: view.number,
  });
  if (localRef === null || localRef.collisionScope !== input.localRef.collisionScope) {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }

  const record = isRecord(body) ? body : {};
  const projection = projectGithubEntry(view, resolved.repositoryId, {
    mergeability: mapGithubMergeability(record),
    additionsDeletions: readAdditionsDeletions(record),
  });
  if (projection === null) return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);

  return Object.freeze({
    kind: 'present',
    localRef: projection.localRef,
    locator: projection.locator,
    snapshot: projection.snapshot,
    viewer: Object.freeze({ involvement: Object.freeze([]) }),
  });
}

async function getIssue(
  input: GithubGetInputV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubTriageObservationV1> {
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
    return unresolved(input.localRef, classifyGithubTransportFailure(error));
  }

  if (response.status === 301) {
    return followIssueTransfer(input, route, url, response, repositories, dependencies);
  }
  if (response.status === 410) {
    // `410` is the status that actually means deleted, and the readable-repository read
    // is the private confirmation that this credential could have seen it.
    return await confirmRepositoryReadable(repositories, route)
      ? Object.freeze({ kind: 'absent', localRef: input.localRef })
      : unresolved(input.localRef, classifyGithubResponseFailure(response, dependencies.now()));
  }
  if (response.status === 404) {
    // Transferred OR deleted into a repository this credential cannot read. The old
    // repository reading `200` says NOTHING about the credential's authority at the
    // transfer destination, so a `404` here is compatible with a live issue — it stays
    // unresolved, and no repository read is issued because none can change the arm. A
    // later scan may supply a new locator; only the validated `301` names a successor.
    return unresolved(
      input.localRef,
      classifyGithubResponseFailure(response, dependencies.now()),
    );
  }
  if (!isGithubSuccessStatus(response.status)) {
    return unresolved(input.localRef, classifyGithubResponseFailure(response, dependencies.now()));
  }

  let body: unknown;
  try {
    body = decodeGithubJsonResponse(response);
  } catch (error) {
    return unresolved(input.localRef, classifyGithubTransportFailure(error));
  }
  const view = decodeGithubIssueBody(body, route);
  if (view === null || view.kindId !== 'issue') {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  if (view.number !== input.localRef.entryId) {
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  const resolved = await readRepositoryId(repositories, route, view.repositoryId);
  if (resolved.kind === 'failed') return unresolved(input.localRef, resolved.failure);
  if (`github:${resolved.repositoryId}` !== input.localRef.collisionScope) {
    // An unrelated occupant of a recreated old path is not transfer evidence.
    return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }

  const projection = projectGithubEntry(view, resolved.repositoryId);
  if (projection === null) return unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  return Object.freeze({
    kind: 'present',
    localRef: projection.localRef,
    locator: projection.locator,
    snapshot: projection.snapshot,
    viewer: Object.freeze({ involvement: Object.freeze([]) }),
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
    location: readHeader(response.headers, 'location'),
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
