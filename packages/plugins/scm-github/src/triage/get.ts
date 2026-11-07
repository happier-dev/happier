import { projectTriageDisplayTextV1, readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import type { SessionInputForgeEvidenceV1 } from '@happier-dev/plugin-sdk/sessions';
import type { GithubMergeMethodV1 } from './mutations/contracts.js';

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
import { buildGithubCollisionScope, buildGithubEntryLocalRef, readGithubRepositoryIdFromCollisionScope } from './identity.js';
import { buildGithubApiUrl, parseGithubRoutingToken, type GithubRepositoryRouteV1 } from './locator.js';
import {
  decodeGithubIssueBody,
  decodeGithubPullRequestBody,
  projectGithubEntry,
  type GithubRawEntityViewV1,
} from './mapping/entry.js';
import { mapGithubMergeability } from './mapping/state.js';
import {
  readGithubEntryMetadataFields,
  projectGithubIssueOverview,
  projectGithubPullRequestOverview,
  readGithubNamedMembers,
  type GithubIssueOverviewV1,
  type GithubPullRequestOverviewV1,
} from './detail/overview.js';
import { createGithubRepositoryReader, type GithubRepositoryReaderV1 } from './repositories.js';
import { projectGithubRepositoryCapabilities } from './capabilities.js';
import { readGithubIssueRelations } from './relations.js';
import { readGithubNativeSecurityAlert } from './securityAlerts/reads.js';
import { projectGithubSecurityAlertDispatchEvidence } from './securityAlerts/dispatchEvidence.js';
import type {
  GithubTriageEntryLocalRefV1,
  GithubTriageEntrySnapshotV1,
  GithubTriageFailureV1,
  GithubTriageObservationV1,
  GithubTriageReviewRevisionV1,
} from './types.js';

/**
 * This reader owns absence conclusions and fails closed. A successful native
 * issue-deletion payload is reduced here too; a masked 404 is not deletion proof.
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
  return Object.freeze({ observation, facts: null, overview: null });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type GithubIssueRedirectDestinationV1 = Readonly<{
  /** The destination repository path, or `null` for the numeric destination form. */
  route: GithubRepositoryRouteV1 | null;
  /** The repository id the numeric destination form asserts, or `null` for a path. */
  repositoryId: string | null;
  number: string;
  url: string;
}>;

const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Resolves `Location` against the requested API URL and accepts ONLY a same-origin
 * `https://api.github.com` issue destination with no user information, query, or
 * fragment, whose path parses as one of the TWO issue destination grammars GitHub
 * actually returns:
 *
 *  - `/repos/{owner}/{repo}/issues/{number}`, which must differ from the requested
 *    route; and
 *  - `/repositories/{repositoryId}/issues/{number}`, the numeric form observed on
 *    2026-09-05 from `GET /repos/zeit/next.js/issues/98287`, which answered `301`
 *    with `Location: https://api.github.com/repositories/70107786/issues/98287` at
 *    `X-GitHub-Api-Version: 2026-03-10`. Refusing that grammar refuses the only
 *    recovery a renamed repository's entries have.
 *
 * Both numbers are positive decimals. Cross-origin, malformed, non-issue, same-route
 * and second redirects are refused, and credentials are never forwarded to them.
 * Neither form is an identity: the destination body and a read of that exact
 * destination repository still have to agree before anything is projected.
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

  if (segments.length === 4) {
    const [repositories, repositoryId, issues, number] = segments;
    if (repositories !== 'repositories' || issues !== 'issues') return null;
    if (repositoryId === undefined || number === undefined) return null;
    if (!POSITIVE_DECIMAL_PATTERN.test(repositoryId)) return null;
    if (!POSITIVE_DECIMAL_PATTERN.test(number)) return null;
    return Object.freeze({
      route: null,
      repositoryId,
      number,
      url: url.toString(),
    });
  }

  if (segments.length !== 5) return null;
  const [repos, owner, name, issues, number] = segments;
  if (repos !== 'repos' || issues !== 'issues') return null;
  if (owner === undefined || name === undefined || number === undefined) return null;
  if (!POSITIVE_DECIMAL_PATTERN.test(number)) return null;

  const sameRoute = owner.toLowerCase() === input.requestedRoute.owner.toLowerCase()
    && name.toLowerCase() === input.requestedRoute.name.toLowerCase()
    && number === input.requestedNumber;
  if (sameRoute) return null;

  return Object.freeze({
    route: Object.freeze({ owner, name }),
    repositoryId: null,
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

/** The exact native read also supplies dispatch evidence without a second provider acquisition. */
export async function runGithubTriageGet(
  input: GithubGetInputV1,
  dependencies: GithubGetDependenciesV1,
): Promise<Readonly<{ observation: GithubTriageObservationV1; dispatchEvidence?: SessionInputForgeEvidenceV1 }>> {
  // A pin retains identity, not provider routing. Ask GitHub for the current
  // locator by its immutable repository id, then use the ordinary exact ladder.
  // Malformed supplied locators remain refusals rather than alternate routing.
  if (input.routingToken == null) {
    const repositoryId = readGithubRepositoryIdFromCollisionScope(input.localRef.collisionScope);
    if (repositoryId === null) return { observation: unresolved(input.localRef, GITHUB_MISSING_LOCATOR_FAILURE) };
    const repositories = dependencies.repositories ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
    const repository = await repositories.read({ repositoryId });
    if (repository.kind !== 'readable') return { observation: unresolved(input.localRef, repository.failure) };
    if (repository.repositoryId !== repositoryId) return { observation: unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE) };
    if (repository.repositoryKey === null) return { observation: unresolved(input.localRef, GITHUB_MISSING_LOCATOR_FAILURE) };
    input = { ...input, routingToken: repository.repositoryKey };
    dependencies = { ...dependencies, repositories };
  }
  if (input.localRef.kindId !== 'dependabot-alert' && input.localRef.kindId !== 'code-scanning-alert') {
    return { observation: await readGithubNonAlertTriageGet(input, dependencies) };
  }
  const route = parseGithubRoutingToken(input.routingToken);
  if (route === null) return { observation: unresolved(input.localRef, GITHUB_MISSING_LOCATOR_FAILURE) };
  const repositories = dependencies.repositories ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
  const repository = await repositories.read(route);
  if (repository.kind !== 'readable') return { observation: unresolved(input.localRef, repository.failure) };
  const read = await readGithubNativeSecurityAlert({ localRef: input.localRef, route,
    repositoryId: repository.repositoryId, repositoryKey: repository.repositoryKey ?? `${route.owner}/${route.name}` }, dependencies);
  return read.kind === 'readable'
    ? { observation: read.observation, dispatchEvidence: projectGithubSecurityAlertDispatchEvidence(read.alert) }
    : { observation: unresolved(input.localRef, read.failure) };
}

async function readGithubNonAlertTriageGet(
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

  if (input.localRef.kindId === 'pull-request') {
    return (await readGithubPullRequest(input.localRef, route, repositories, dependencies)).observation;
  }
  if (input.localRef.kindId !== 'issue') return unresolved(input.localRef, { class: 'unsupportedContract', code: 'github_detail_kind_unsupported' });
  const read = await readGithubIssue(input.localRef, route, repositories, dependencies);
  const observation = read.observation;
  if (observation.kind !== 'present') return observation;
  const currentRoute = parseGithubRoutingToken(observation.locator.routingToken);
  if (currentRoute === null) return observation;
  const relations = await readGithubIssueRelations(input.localRef, currentRoute, repositories, dependencies,
    observation.snapshot.relations?.children);
  // Reuse the invocation-local repository reader, including any facts already
  // acquired for issue identity or relations, for the native capability controls.
  const repository = await repositories.read(currentRoute);
  const detailData = read.overview === null ? undefined : Object.freeze({
    overview: Object.freeze({ kind: 'overview' as const, kindId: 'issue' as const,
      observedAtMs: dependencies.now(), ...read.overview }),
    capabilities: repository.kind === 'readable'
      ? Object.freeze({ kind: 'capabilities' as const, ...projectGithubRepositoryCapabilities(repository, 'issue') })
      : Object.freeze({ kind: 'unavailable' as const, failure: repository.failure }),
  });
  return Object.freeze({
    ...observation,
    ...(detailData === undefined ? {} : { detailData }),
    ...(relations === undefined ? {} : { snapshot: Object.freeze({ ...observation.snapshot, relations }) }),
  });
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

export type GithubPullRequestFactsV1 = GithubIssueFactsV1 & Readonly<{
  /** The validated provider pull-request number from this reread. */
  number: number;
  /** GitHub's own `state`, trimmed: `open` or `closed`. */
  state: string | null;
  merged: boolean;
  draft: boolean;
  /** GitHub's provider-computed `mergeable_state`, when it stated one. */
  mergeableState: string | null;
  /** Native mergeability is unknown while GitHub computes it. */
  mergeable: boolean | null;
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
  /** Same REST response: null means unavailable, not a disabled request. */
  autoMerge?: Readonly<{ enabled: boolean | null; method: GithubMergeMethodV1 | null }> | null;
}>;

export type GithubPullRequestReadV1 = Readonly<{
  observation: GithubTriageObservationV1;
  /** Present only when the observation is `present`. */
  facts: GithubPullRequestFactsV1 | null;
  /** Exact display facts copied from the same provider response. */
  overview: GithubPullRequestOverviewV1 | null;
}>;

export function readGithubPullRequestReviewRevision(
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
    ...readGithubIssueFacts(raw),
    number,
    // GitHub publishes both; either one alone is enough to prove the merge happened,
    // and requiring both would report an already-merged pull request as unmerged.
    merged: raw.merged === true || mergedAt !== '',
    draft: raw.draft === true,
    mergeableState: readNonEmptyString(raw.mergeable_state),
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
    headRevision,
    reviewRevision,
    sourceTip: reviewRevision === null ? null : readGithubPullRequestSourceTip(raw, reviewRevision),
    autoMerge: raw.auto_merge === null ? { enabled: false, method: null }
      : isRecord(raw.auto_merge) ? { enabled: true,
        method: raw.auto_merge.merge_method === 'merge' || raw.auto_merge.merge_method === 'squash'
          || raw.auto_merge.merge_method === 'rebase' ? raw.auto_merge.merge_method : null }
        : null,
  } satisfies GithubPullRequestFactsV1);
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
  const overview = projectGithubPullRequestOverview(record);
  const branches = readGithubPullRequestBranches(overview);
  return Object.freeze({
    observation: Object.freeze({
      kind: 'present' as const,
      localRef: projection.localRef,
      locator: projection.locator,
      snapshot: facts.reviewRevision === null && branches === null
        ? projection.snapshot
        : Object.freeze({
          ...projection.snapshot,
          ...(facts.reviewRevision === null ? {} : { reviewRevision: facts.reviewRevision }),
          ...(branches === null ? {} : { branches: branches.value }),
          ...(branches?.truncated === true ? { projectionTruncated: true } : {}),
        }),
      viewer: Object.freeze({ involvement: Object.freeze([]) }),
    }),
    facts,
    overview,
  });
}

/**
 * The head → base branch names the detail header says, from the overview this read already
 * projected (one reader of `head.ref`/`base.ref`). Both or neither: half a pair names no merge.
 */
function readGithubPullRequestBranches(
  overview: GithubPullRequestOverviewV1,
): Readonly<{ value: NonNullable<GithubTriageEntrySnapshotV1['branches']>; truncated: boolean }> | null {
  if (overview.headBranch === undefined || overview.baseBranch === undefined) return null;
  const head = projectTriageDisplayTextV1(overview.headBranch);
  const base = projectTriageDisplayTextV1(overview.baseBranch);
  if (head.value === '' || base.value === '') return null;
  return { value: Object.freeze({ head: head.value, base: base.value }), truncated: head.truncated || base.truncated };
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
  /** Native GraphQL identity from the same validated REST entity. */
  nodeId: string | null;
  title: string | null;
  body: string | null;
  /** GitHub's own `state`, trimmed: `open` or `closed`. */
  state: string | null;
  /** GitHub's own close classification; null while open or when omitted. */
  stateReason: string | null;
  labels: readonly string[];
  assignees: readonly string[];
  milestoneNumber: number | null | undefined;
  issueType: string | null | undefined;
  locked: boolean | null;
  lockReason: string | null;
}>;

export type GithubIssueReadV1 = Readonly<{
  observation: GithubTriageObservationV1;
  /** Present only when the observation is `present`. */
  facts: GithubIssueFactsV1 | null;
  /** Exact display facts copied from the same provider response. */
  overview: GithubIssueOverviewV1 | null;
}>;

/** Positive native deletion acknowledgement, never inferred from a subsequent masked 404. */
export function projectGithubIssueDeletion(
  localRef: GithubTriageEntryLocalRefV1, payload: unknown,
): Extract<GithubTriageObservationV1, { kind: 'absent' }> | null {
  if (!isRecord(payload) || !isRecord(payload.repository)
    || String(payload.repository.databaseId) !== readGithubRepositoryIdFromCollisionScope(localRef.collisionScope)) return null;
  return { kind: 'absent', localRef };
}

/** Reads one string member off each element of a GitHub actor/label collection. */
function readNamedMembers(value: unknown, member: string): readonly string[] {
  return readGithubNamedMembers(value, member) ?? Object.freeze([]);
}

function readGithubIssueFacts(raw: Readonly<Record<string, unknown>>): GithubIssueFactsV1 {
  const metadata = readGithubEntryMetadataFields(raw);
  return Object.freeze({
    nodeId: readNonEmptyString(raw.node_id),
    title: typeof raw.title === 'string' ? raw.title : null,
    body: typeof raw.body === 'string' ? raw.body : raw.body === null ? '' : null,
    state: typeof raw.state === 'string' && raw.state.trim() ? raw.state.trim() : null,
    stateReason: typeof raw.state_reason === 'string' && raw.state_reason.trim()
      ? raw.state_reason.trim()
      : null,
    // GitHub publishes a label as an object with a `name`, and the same field as a
    // bare string on some legacy payloads. Both are read, because a delta that
    // silently saw no labels would report every removal as already satisfied.
    labels: readNamedMembers(raw.labels, 'name'),
    assignees: readNamedMembers(raw.assignees, 'login'),
    milestoneNumber: metadata.milestoneNumber,
    issueType: metadata.issueType,
    locked: metadata.locked ?? null,
    lockReason: metadata.lockReason ?? null,
  });
}

function observedIssue(observation: GithubTriageObservationV1): GithubIssueReadV1 {
  return Object.freeze({ observation, facts: null, overview: null });
}

/** Shared metadata uses the canonical entity reader for its admitted kind. */
export async function readGithubEntryMetadata(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubIssueReadV1> {
  return localRef.kindId === 'pull-request'
    ? readGithubPullRequest(localRef, route, repositories, dependencies)
    : readGithubIssue(localRef, route, repositories, dependencies);
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
    // Two different things arrive as `301`. A transfer renumbers the entry, so the
    // successor — not this route — is what a later read or write must address, and no
    // facts travel with it. A rename keeps the entry and moves only its path, so the
    // destination response IS this entry and is projected as present.
    return await followIssueTransfer(input, route, url, response, repositories, dependencies);
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

  return projectIssuePresent(input.localRef, view, resolved.repositoryId, body);
}

/**
 * The ONE present projection an issue read produces, from whichever response
 * proved this entry: the direct `200`, or the `200` behind a validated `301`.
 *
 * Both callers have the same evidence at this point — a decoded view whose number
 * and repository identity were validated — so they must publish the same locator,
 * snapshot and facts. A second projection at the redirect path is how the two
 * would drift.
 */
function projectIssuePresent(
  localRef: GithubTriageEntryLocalRefV1,
  view: GithubRawEntityViewV1,
  repositoryId: string,
  body: unknown,
): GithubIssueReadV1 {
  const projection = projectGithubEntry(view, repositoryId);
  if (projection === null) {
    return observedIssue(unresolved(localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE));
  }
  const record = isRecord(body) ? body : {};
  const facts = readGithubIssueFacts(record);
  const labels = readGithubNamedMembers(record.labels, 'name', 'exact');
  const assignees = readGithubNamedMembers(record.assignees, 'login', 'exact');
  return Object.freeze({
    observation: Object.freeze({
      kind: 'present' as const,
      localRef: projection.localRef,
      locator: projection.locator,
      snapshot: projection.snapshot,
      viewer: Object.freeze({ involvement: Object.freeze([]) }),
      taskFields: {
        ...(facts.title === null ? {} : { title: facts.title }),
        ...(facts.body === null ? {} : { body: facts.body }),
        ...(labels === null ? {} : { labelIds: [...labels] }),
        ...(assignees === null ? {} : { assigneeIds: [...assignees] }),
      },
    }),
    facts,
    overview: projectGithubIssueOverview(record),
  });
}

async function followIssueTransfer(
  input: GithubGetInputV1,
  route: GithubRepositoryRouteV1,
  requestedUrl: string,
  response: GithubApiResponseV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
): Promise<GithubIssueReadV1> {
  const mismatch = (): GithubIssueReadV1 => observedIssue(
    unresolved(input.localRef, GITHUB_ROUTE_BODY_MISMATCH_FAILURE),
  );
  const destination = validateGithubIssueRedirect({
    location: readTriageResponseHeaderV1(response.headers, 'location'),
    requestedUrl,
    requestedRoute: route,
    requestedNumber: input.localRef.entryId,
  });
  if (destination === null) return mismatch();

  // Followed exactly ONCE, through the ordinary client: a second redirect is refused by
  // that client's `redirect: 'error'` rather than chased.
  let destinationResponse: GithubApiResponseV1;
  try {
    destinationResponse = await dependencies.client.request({ url: destination.url });
  } catch (error) {
    return observedIssue(unresolved(input.localRef, classifyGithubTransportFailure(error)));
  }
  if (!isGithubSuccessStatus(destinationResponse.status)) {
    return observedIssue(unresolved(
      input.localRef,
      classifyGithubResponseFailure(destinationResponse, dependencies.now()),
    ));
  }

  let destinationBody: unknown;
  try {
    destinationBody = decodeGithubJsonResponse(destinationResponse);
  } catch (error) {
    return observedIssue(unresolved(input.localRef, classifyGithubTransportFailure(error)));
  }
  const destinationView = decodeGithubIssueBody(destinationBody, destination.route);
  if (destinationView === null || destinationView.kindId !== 'issue') return mismatch();
  // Compared against the DESTINATION route's own number — never the old issue number,
  // because a transfer may renumber.
  if (destinationView.number !== destination.number) return mismatch();

  // The destination body's own repository is the locator, and whatever the redirect
  // asserted about it has to agree: a named destination names an `owner/name`, and the
  // numeric destination names a repository id. Either disagreeing is the same
  // `route-body-mismatch` a bare `200` scope mismatch is.
  const destinationRoute: GithubRepositoryRouteV1 = Object.freeze({
    owner: destinationView.owner,
    name: destinationView.name,
  });
  if (destination.route !== null
    && (destination.route.owner.toLowerCase() !== destinationRoute.owner.toLowerCase()
      || destination.route.name.toLowerCase() !== destinationRoute.name.toLowerCase())) {
    return mismatch();
  }
  const resolved = await readRepositoryId(
    repositories,
    destinationRoute,
    destinationView.repositoryId,
  );
  if (resolved.kind === 'failed') return observedIssue(unresolved(input.localRef, resolved.failure));
  if (destination.repositoryId !== null && destination.repositoryId !== resolved.repositoryId) {
    return mismatch();
  }

  const successor = buildGithubEntryLocalRef({
    kindId: 'issue',
    repositoryId: resolved.repositoryId,
    nativeItemId: destination.number,
  });
  if (successor === null) return mismatch();

  // §3.4a: a redirect that lands on the SAME entry is a repository rename, so the
  // answer is this entry at a refreshed locator. `merged` naming an entry as its own
  // successor is not recovery — presence folding treats merged as unresolved, so the
  // row would stay stuck at a path that no longer exists.
  if (successor.collisionScope === input.localRef.collisionScope
    && successor.entryId === input.localRef.entryId) {
    return projectIssuePresent(
      input.localRef,
      destinationView,
      resolved.repositoryId,
      destinationBody,
    );
  }

  return observedIssue(Object.freeze({ kind: 'merged', localRef: input.localRef, successor }));
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
