import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import { getGithubConditionalChecksCache, readGithubConditionalWitness } from '../observations/githubConditionalRead.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import { buildGithubApiUrl } from './locator.js';
import { GITHUB_MAX_PAGE_SIZE_V1 } from './types.js';
import { decodeGithubJsonResponse } from '../observations/githubApiClient.js';
import { GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from './errors.js';
import { readGithubCheckOutcomeV1, readGithubStatusContextObservationV1 } from './checkOutcome.js';
import { projectGithubChecksCountsSurface, projectGithubChecksSurface, type GithubChecksOutcomeTallyV1, type GithubCheckObservationV1, type GithubChecksDependenciesV1, type GithubChecksSurfaceV1, type GithubNativePullRequestFactsV1 } from './checks.js';
import type { GithubRepositoryRouteV1 } from './locator.js';
import type { GithubResponseFailureV1 } from '../observations/githubResponseFailure.js';
import { decodeGithubReviewDecision, readGithubThreadResolutionV1 } from './feedback.js';
import { encodeGithubChecksQueryBody, githubChecksRepositoryFields } from './checksQuery.js';
import type { GithubReviewDecisionV1 } from './mapping/facts.js';
import { classifyGithubGraphqlError } from './mutations/graphql.js';
import { buildGithubCollisionScope, readGithubRepositoryIdFromCollisionScope } from './identity.js';
import type { GITHUB_CHECKS_CONDITION_STATES_V1 } from './types.js';
import { projectGithubPullRequestReviewRevision } from './detail/overview.js';
import { GithubViewerSubscriptionV1Schema } from './detail/contracts.js';

export type GithubChecksConditionSnapshotV1 = Readonly<{
  pullRequestNumber: number;
  headSha: string;
  currentHeadSha: string | null;
  selection: 'all' | 'required';
  state: (typeof GITHUB_CHECKS_CONDITION_STATES_V1)[number];
  complete: boolean;
  passed: boolean;
  failure?: GithubResponseFailureV1;
}>;

// The list row needs only the head's outcome counts. GitHub states them for the whole
// rollup connection, so no context page, per-context isRequired evaluation or follow-up
// cursor request is made (measured on the owner's account: 53 PRs 281 KB / ~9.7 s as
// context pages, 38 KB / ~4 s as counts).
const countsFields = `
    pullRequest(number: $number) {
    headRefOid
    baseRefOid
    reviewDecision
    commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts {
      checkRunCountsByState { state count } statusContextCountsByState { state count }
    } } } } }
  }`;
const PENDING_CHECK_RUN_STATES: ReadonlySet<string> = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);
/** Native state counts → outcome counts, through the same outcome policy rows use. */
function readOutcomeCounts(contexts: Readonly<Record<string, unknown>> | null): GithubChecksOutcomeTallyV1 | null {
  const tally = { failed: 0, pending: 0, passed: 0, neutral: 0, unknown: 0 };
  const add = (raw: unknown, outcomeOf: (state: string) => keyof typeof tally): boolean => {
    if (!Array.isArray(raw)) return false;
    for (const entry of raw) {
      const row = record(entry);
      const state = text(row?.state);
      const amount = count(row?.count);
      if (state === null || amount === null) return false;
      tally[outcomeOf(state)] += amount;
    }
    return true;
  };
  const runs = add(contexts?.checkRunCountsByState, state => readGithubCheckOutcomeV1(PENDING_CHECK_RUN_STATES.has(state)
    ? { status: state.toLowerCase(), conclusion: null }
    : { status: 'completed', conclusion: state === 'COMPLETED' ? null : state.toLowerCase() }));
  const statuses = add(contexts?.statusContextCountsByState,
    state => readGithubCheckOutcomeV1(readGithubStatusContextObservationV1(state)));
  return runs && statuses ? tally : null;
}
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}
function time(value: unknown): number | null {
  const epoch = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) ? epoch : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function decodeNativePullRequest(pr: Readonly<Record<string, unknown>>, repository: Readonly<Record<string, unknown>> | null): GithubNativePullRequestFactsV1 {
  const subscription = GithubViewerSubscriptionV1Schema.safeParse(pr.viewerSubscription);
  const reviews: Array<GithubNativePullRequestFactsV1['reviews'][number]> = [];
  const requests: Array<GithubNativePullRequestFactsV1['requests'][number]> = [];
  const threads: Array<GithubNativePullRequestFactsV1['threads'][number]> = [];
  const threadConnection = record(pr.reviewThreads);
  let threadsIncomplete = !Array.isArray(threadConnection?.nodes)
    || record(threadConnection?.pageInfo)?.hasPreviousPage !== false;
  const threadIds = new Set<string>();
  for (const raw of Array.isArray(threadConnection?.nodes) ? threadConnection.nodes : []) {
    const row = readGithubThreadResolutionV1(raw);
    if (row === null || row.truncated || threadIds.has(row.id)) { threadsIncomplete = true; continue; }
    threadIds.add(row.id);
    threads.push({ id: row.id, isResolved: row.isResolved });
  }
  const reviewConnection = record(pr.reviews);
  const requestConnection = record(pr.reviewRequests);
  let reviewIncomplete = !Array.isArray(reviewConnection?.nodes) || !Array.isArray(requestConnection?.nodes)
    || record(reviewConnection?.pageInfo)?.hasPreviousPage !== false
    || record(requestConnection?.pageInfo)?.hasNextPage !== false;
  for (const raw of Array.isArray(reviewConnection?.nodes) ? reviewConnection.nodes : []) {
    const row = record(raw);
    const id = text(row?.id);
    const state = text(row?.state);
    if (!row || id === null || state === null) { reviewIncomplete = true; continue; }
    const author = text(record(row.author)?.login);
    reviewIncomplete ||= author === null;
    reviews.push({ id, author, state, submittedAtMs: time(row.submittedAt) });
  }
  for (const raw of Array.isArray(requestConnection?.nodes) ? requestConnection.nodes : []) {
    const reviewer = record(record(raw)?.requestedReviewer);
    const kind = reviewer?.__typename === 'User' ? 'user' : reviewer?.__typename === 'Team' ? 'team' : null;
    const subject = kind === 'user' ? text(reviewer?.login) : text(reviewer?.name) ?? text(reviewer?.slug);
    if (kind === null || subject === null) { reviewIncomplete = true; continue; }
    requests.push({ kind, subject });
  }
  const entry = record(pr.mergeQueueEntry);
  const entryId = text(entry?.id);
  const queue = pr.mergeQueueEntry === null ? null : entryId === null ? undefined : {
    id: entryId, state: text(entry?.state), position: count(entry?.position),
    ...(entry?.estimatedTimeToMerge === undefined ? {} : { estimatedTimeToMergeSeconds: count(entry.estimatedTimeToMerge) }),
  };
  return {
    ...(subscription.success ? { viewerSubscription: subscription.data } : {}),
    repository: { archived: boolean(repository?.isArchived), hasIssues: boolean(repository?.hasIssuesEnabled), mergeSettings: {
      merge: boolean(repository?.mergeCommitAllowed), squash: boolean(repository?.squashMergeAllowed),
      rebase: boolean(repository?.rebaseMergeAllowed),
    } },
    nodeId: text(pr.id), mergeStateStatus: text(pr.mergeStateStatus),
    canMergeWithoutWaiting: boolean(pr.viewerCanMergeAsAdmin),
    viewerCanUpdate: boolean(pr.viewerCanUpdate),
    viewerCanEnableAutoMerge: boolean(pr.viewerCanEnableAutoMerge),
    viewerCanDisableAutoMerge: boolean(pr.viewerCanDisableAutoMerge),
    ...(queue === undefined ? {} : { queue }), reviews, requests, reviewIncomplete, threads, threadsIncomplete,
  };
}
function decode(raw: unknown, expected: Readonly<{ route: GithubRepositoryRouteV1; headSha: string }>): Readonly<{ required: boolean | null; row: GithubCheckObservationV1 }> | null {
  const node = record(raw);
  if (!node || typeof node.id !== 'string' || !node.id) return null;
  const required = boolean(node.isRequired);
  if (node.__typename === 'CheckRun' && typeof node.name === 'string' && typeof node.status === 'string'
    && (node.conclusion === null || typeof node.conclusion === 'string')) {
    const startedAtMs = time(node.startedAt);
    const completedAtMs = time(node.completedAt);
    const checkSuiteCreatedAtMs = time(record(node.checkSuite)?.createdAt);
    // Run times are nullable; the suite creation time is non-null in GitHub's
    // schema. A malformed fallback makes the canonical surface unknown.
    if (startedAtMs === null && completedAtMs === null && checkSuiteCreatedAtMs === null) return null;
    const suite = record(node.checkSuite);
    const workflowRun = record(suite?.workflowRun);
    const nativeId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    const runId = nativeId(workflowRun?.databaseId);
    const attempt = nativeId(workflowRun?.runAttempt);
    const checkRunId = nativeId(node.databaseId);
    const repositoryName = `${expected.route.owner}/${expected.route.name}`.toLowerCase();
    const actions = runId !== null && attempt !== null && checkRunId !== null
      && record(suite?.app)?.slug === 'github-actions' && record(suite?.commit)?.oid === expected.headSha
      && text(record(suite?.repository)?.nameWithOwner)?.toLowerCase() === repositoryName
      ? { selection: { kind: 'attempt' as const, attempt: { run: { v: 1 as const, repository: { kind: 'github' as const, deployment: 'https://github.com', repository: repositoryName }, runId }, attemptId: attempt } }, checkRunId, headSha: expected.headSha } : undefined;
    const annotationsCount = count(record(node.annotations)?.totalCount);
    // The check's own output, as the REST check-run reader joins it: distinct title, summary, text.
    const output = [text(node.title), text(node.summary), text(node.text)].filter((part): part is string => part !== null);
    const logExcerpt = output.filter((part, index) => output.indexOf(part) === index).join('\n\n') || null;
    return { required, row: {
      key: `github-check-run:${node.id}`, resourceKind: 'check-run', name: node.name,
      required,
      status: node.status.toLowerCase(), conclusion: node.conclusion?.toLowerCase() ?? null,
      detailsUrl: typeof node.detailsUrl === 'string' ? node.detailsUrl : null,
      startedAtMs, completedAtMs,
      ...(checkSuiteCreatedAtMs === null ? {} : { checkSuiteCreatedAtMs }),
      ...(annotationsCount === null ? {} : { annotationsCount }), ...(actions === undefined ? {} : { actions }),
      ...('title' in node || 'summary' in node || 'text' in node ? { logExcerpt } : {}),
    } };
  }
  if (node.__typename === 'StatusContext' && typeof node.context === 'string' && typeof node.state === 'string') {
    const normalized = readGithubStatusContextObservationV1(node.state);
    const pending = normalized.status === 'in_progress';
    return { required, row: {
      key: `github-commit-status:${node.id}`, resourceKind: 'commit-status', name: node.context,
      required,
      ...normalized,
      detailsUrl: typeof node.targetUrl === 'string' ? node.targetUrl : null,
      startedAtMs: time(node.createdAt), completedAtMs: pending ? null : time(node.updatedAt),
      ...('description' in node ? { logExcerpt: text(node.description) } : {}),
    } };
  }
  return null;
}

type ChecksInput = Readonly<{ route: GithubRepositoryRouteV1; headSha?: string; repositoryId?: string | null; pullRequestUrl?: string;
    observation: Readonly<{ pullRequestNumber: number; selection: 'all' | 'required' }>;
    includeStatus?: boolean;
    /** Also read each check's own output (Check Run title/summary/text, status description). */
    includeOutput?: boolean;
    /** `counts`: outcome counts only, for a list row; no rows, required flags or summary. */
    depth?: 'rows' | 'counts' }>;

/** The single decoder/projector owns both exact-head reads and inbox batches. */
function createChecksTraversal(input: ChecksInput) {
  const rows: GithubCheckObservationV1[] = [];
  let headSha = input.headSha ?? null;
  let currentHeadSha: string | null = null;
  let reviewRevision: ReturnType<typeof projectGithubPullRequestReviewRevision> = null;
  let reviewDecision: GithubReviewDecisionV1 | null = null;
  let nativePullRequest: GithubNativePullRequestFactsV1 | undefined;
  let partial = false;
  let partialFailure: GithubResponseFailureV1 | null = null;
  let tally: GithubChecksOutcomeTallyV1 | null = null;
  const finish = (state?: GithubChecksConditionSnapshotV1['state'], failure: GithubChecksSurfaceV1['checkRunsFailure'] = partialFailure) => {
    // Unknown acquisition is not an empty suite. Keep the existing collection-read
    // failure vocabulary so inbox and detail consumers preserve partial evidence.
    failure ??= state === 'unknown' ? { class: 'unsupportedContract', code: 'github_checks_envelope_invalid' } : null;
    const surface = tally !== null && failure === null ? projectGithubChecksCountsSurface(tally) : projectGithubChecksSurface({
      checkRuns: { observations: rows, totalCount: rows.length, truncated: false, failure },
      commitStatuses: { observations: [], totalCount: 0, truncated: false, failure: null },
    });
    const outcomes = tally ?? rows.map(readGithubCheckOutcomeV1).reduce((counts, outcome) => ({ ...counts, [outcome]: counts[outcome] + 1 }),
      { failed: 0, pending: 0, passed: 0, neutral: 0, unknown: 0 });
    const total = outcomes.failed + outcomes.pending + outcomes.passed + outcomes.neutral + outcomes.unknown;
    const selectedState = state ?? (total === 0 ? 'none' : outcomes.unknown > 0 ? 'unknown'
      : outcomes.failed > 0 ? 'failed' : outcomes.pending > 0 ? 'pending'
        : outcomes.passed === total ? 'passed' : 'neutral');
    const complete = !['none', 'unknown', 'superseded'].includes(selectedState) && outcomes.pending === 0;
    const unknown = selectedState === 'unknown' || selectedState === 'superseded';
    return { ...surface,
      ...(unknown ? { state: 'unknown' as const, failingCount: null, runningCount: null, passingCount: null, rowState: null } : {}),
      ...(nativePullRequest === undefined || selectedState === 'superseded' ? {} : { nativePullRequest }),
      ...(reviewRevision === null || selectedState === 'superseded' ? {} : { reviewRevision }),
      reviewDecision: selectedState === 'superseded' ? null : reviewDecision,
      ...(headSha === null ? {} : { observation: {
      ...input.observation, headSha, currentHeadSha,
      state: selectedState, complete, passed: selectedState === 'passed',
      ...(failure ? { failure } : {}),
    } }) } satisfies GithubChecksSurfaceV1;
  };
  let cursor: string | null = null;
  const seen = new Set<string>();
  const seenRows = new Set<string>();
  const consume = (repository: Readonly<Record<string, unknown>> | null, errors: unknown): GithubChecksSurfaceV1 | null => {
    if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
      partial = true;
      partialFailure ??= classifyGithubGraphqlError(Array.isArray(errors) ? errors : []);
    }
    const pr = record(repository?.pullRequest);
    if (!pr || typeof pr.headRefOid !== 'string') return finish('unknown');
    currentHeadSha = pr.headRefOid;
    headSha ??= currentHeadSha;
    if (currentHeadSha !== headSha) { rows.length = 0; return finish('superseded'); }
    if (input.depth === 'counts') reviewRevision = projectGithubPullRequestReviewRevision(pr.baseRefOid, currentHeadSha);
    reviewDecision = decodeGithubReviewDecision(pr.reviewDecision) ?? null;
    if (cursor === null && input.includeStatus === true) nativePullRequest = decodeNativePullRequest(pr, repository);
    const commits = record(pr.commits);
    const commit = record(record(Array.isArray(commits?.nodes) ? commits.nodes[0] : null)?.commit);
    if (!commit || commit.oid !== headSha) return finish('unknown');
    if (commit.statusCheckRollup === null) return finish(cursor === null && !partial ? 'none' : 'unknown');
    const contexts = record(record(commit.statusCheckRollup)?.contexts);
    if (input.depth === 'counts') {
      tally = readOutcomeCounts(contexts);
      return tally === null ? finish('unknown') : finish(partial ? 'unknown' : undefined);
    }
    const pageInfo = record(contexts?.pageInfo);
    if (!contexts || !Array.isArray(contexts.nodes) || !pageInfo || typeof pageInfo.hasNextPage !== 'boolean') return finish('unknown');
    for (const raw of contexts.nodes) {
      const decoded = decode(raw, { route: input.route, headSha });
      if (!decoded || seenRows.has(decoded.row.key)) { partial = true; continue; }
      seenRows.add(decoded.row.key);
      partial ||= decoded.required === null;
      if (input.observation.selection === 'all' || decoded.required === true) rows.push(decoded.row);
    }
    if (!pageInfo.hasNextPage) return finish(partial ? 'unknown' : undefined);
    if (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor || seen.has(pageInfo.endCursor)) return finish('unknown');
    cursor = pageInfo.endCursor;
    seen.add(cursor);
    return null;
  };
  return { consume, finish, get cursor() { return cursor; } };
}

export type GithubChecksBatchTargetV1 = Readonly<{
  route: GithubRepositoryRouteV1;
  /** Omitted for an issue row that needs only the repository's immutable identity. */
  pullRequestNumber?: number;
  /** A Watch read must correspond to the head captured by its admitted PR read. */
  headSha?: string;
  repositoryId?: string | null;
  pullRequestUrl?: string;
  includeStatus?: boolean;
  /** `counts` reads only the outcome counts a list row shows. */
  depth?: 'rows' | 'counts';
}>;
export type GithubChecksBatchReadV1 = Readonly<{
  repositoryId: string | null;
  surface: GithubChecksSurfaceV1 | null;
}>;

/** A PR validator cannot establish independent CI state. Watch reads revalidate
 * every REST check/status page before reusing the complete GraphQL projection.
 * Fresh Overview and mutation reads have no cadence scope and remain fresh.
 */
async function prepareConditionalChecks(input: ChecksInput, dependencies: GithubChecksDependenciesV1) {
  const cache = getGithubConditionalChecksCache(dependencies.client);
  if (cache === undefined || input.headSha === undefined) return undefined;
  const key = JSON.stringify([input.route, input.repositoryId, input.pullRequestUrl, input.headSha,
    input.observation, input.includeStatus === true, input.includeOutput === true, input.depth]);
  const witnesses: string[] = [];
  try {
    const prUrl = input.pullRequestUrl ?? buildGithubApiUrl(['repos', input.route.owner, input.route.name,
      'pulls', String(input.observation.pullRequestNumber)]);
    const pr = await readGithubConditionalWitness(dependencies.client, { url: prUrl });
    const prEtag = readTriageResponseHeaderV1(pr.headers, 'etag');
    if (pr.status !== 200 || !prEtag) { cache.delete(key); return undefined; }
    witnesses.push(prUrl, prEtag);
    const prefix = input.repositoryId ? ['repositories', input.repositoryId] : ['repos', input.route.owner, input.route.name];
    for (const resource of ['check-runs', 'status']) {
      let url = `${buildGithubApiUrl([...prefix, 'commits', input.headSha, resource])}?${resource === 'check-runs' ? 'filter=all&' : ''}per_page=${GITHUB_MAX_PAGE_SIZE_V1}`;
      while (true) {
        dependencies.signal.throwIfAborted();
        const response = await readGithubConditionalWitness(dependencies.client, { url });
        const etag = readTriageResponseHeaderV1(response.headers, 'etag');
        if (response.status !== 200 || !etag) { cache.delete(key); return undefined; }
        witnesses.push(url, etag);
        const next = readValidatedGithubFollowUpPage(response.headers, url, input.repositoryId);
        if (next.kind === 'invalid') { cache.delete(key); return undefined; }
        if (next.kind === 'ended') break;
        url = next.url;
      }
    }
  } catch {
    dependencies.signal.throwIfAborted();
    cache.delete(key);
    return undefined;
  }
  const prior = cache.get(key);
  return { cache, key, witnesses, reused: prior !== undefined && prior.witnesses.length === witnesses.length
    && prior.witnesses.every((value, index) => value === witnesses[index]) ? prior.value : undefined };
}
function retainConditionalChecks(prepared: Awaited<ReturnType<typeof prepareConditionalChecks>>, value: GithubChecksBatchReadV1) {
  const surface = value.surface;
  if (prepared === undefined) return;
  if (surface === null || surface.state === 'unknown' || surface.state === 'superseded'
    || surface.checkRunsFailure !== null || surface.commitStatusFailure !== null) prepared.cache.delete(prepared.key);
  else prepared.cache.set(prepared.key, { witnesses: prepared.witnesses, value });
}

/** One consumed native search page; only unfinished check connections remain in later requests. */
export async function readGithubChecksConditionBatch(
  targets: readonly GithubChecksBatchTargetV1[], dependencies: GithubChecksDependenciesV1,
): Promise<readonly GithubChecksBatchReadV1[]> {
  const prepared = await Promise.all(targets.map(target => target.pullRequestNumber === undefined ? undefined
    : prepareConditionalChecks({ ...target, observation: { pullRequestNumber: target.pullRequestNumber, selection: 'all' } }, dependencies)));
  const states = targets.map((target, index) => ({ target, repositoryId: prepared[index]?.reused?.repositoryId ?? null as string | null,
    traversal: target.pullRequestNumber === undefined ? null : createChecksTraversal({ route: target.route,
      headSha: target.headSha, includeStatus: target.includeStatus, depth: target.depth,
      observation: { pullRequestNumber: target.pullRequestNumber, selection: 'all' } }),
    surface: prepared[index]?.reused?.surface ?? null as GithubChecksSurfaceV1 | null,
  }));
  let pending = states.flatMap((_state, index) => prepared[index]?.reused === undefined ? [index] : []);
  while (pending.length > 0) {
    dependencies.signal.throwIfAborted();
    const definitions: string[] = [];
    const selections: string[] = [];
    const variables: Record<string, unknown> = {};
    for (const index of pending) {
      const state = states[index]!;
      definitions.push(`$owner${index}: String!`, `$name${index}: String!`);
      variables[`owner${index}`] = state.target.route.owner;
      variables[`name${index}`] = state.target.route.name;
      let fields = 'databaseId';
      if (state.traversal !== null && state.target.depth === 'counts') {
        definitions.push(`$number${index}: Int!`);
        variables[`number${index}`] = state.target.pullRequestNumber;
        fields += countsFields.replace(/\$number\b/gu, `$number${index}`);
      } else if (state.traversal !== null) {
        definitions.push(`$number${index}: Int!`, `$cursor${index}: String`, `$includeSummary${index}: Boolean!`,
          `$includeOutput${index}: Boolean!`);
        variables[`includeOutput${index}`] = false;
        variables[`number${index}`] = state.target.pullRequestNumber;
        variables[`cursor${index}`] = state.traversal.cursor;
        variables[`includeSummary${index}`] = state.target.includeStatus === true && state.traversal.cursor === null;
        fields += githubChecksRepositoryFields.replace(/\$(number|cursor|includeSummary|includeOutput)\b/gu, (_match, name: string) => `$${name}${index}`);
      }
      selections.push(`row${index}: repository(owner: $owner${index}, name: $name${index}) { ${fields} }`);
    }
    let body: Readonly<Record<string, unknown>> | null = null;
    let failure: GithubResponseFailureV1 | null = null;
    try {
      const response = await dependencies.client.request({ url: `${GITHUB_API_ORIGIN}/graphql`, method: 'POST', readOnlyGraphql: true,
        headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
          query: `query ScanChecks(${definitions.join(', ')}) { ${selections.join('\n')} }`, variables,
        })) });
      dependencies.signal.throwIfAborted();
      if (response.status !== 200) failure = classifyGithubResponseFailure(response, dependencies.now());
      else body = record(decodeGithubJsonResponse(response));
    } catch (error) {
      dependencies.signal.throwIfAborted();
      failure = classifyGithubTransportFailure(error);
    }
    const next: number[] = [];
    for (const index of pending) {
      const state = states[index]!;
      const repository = record(record(body?.data)?.[`row${index}`]);
      state.repositoryId ??= readGithubRepositoryIdFromCollisionScope(buildGithubCollisionScope(repository?.databaseId));
      if (state.traversal === null) continue;
      const errors = Array.isArray(body?.errors) ? body.errors.filter(error => {
        const path = record(error)?.path;
        return !Array.isArray(path) || path.length === 0 || path[0] === `row${index}`;
      }) : body?.errors;
      state.surface = failure !== null || body === null ? state.traversal.finish('unknown', failure)
        : state.traversal.consume(repository, errors);
      if (state.surface === null) next.push(index);
    }
    pending = next;
  }
  return states.map(({ repositoryId, surface }, index) => {
    const value = { repositoryId, surface };
    retainConditionalChecks(prepared[index], value);
    return value;
  });
}

/** Current PR rollup, distinct from the detail reader's historical REST rows. */
export async function readGithubChecksConditionSurface(
  input: ChecksInput & Readonly<{ headSha: string }>, dependencies: GithubChecksDependenciesV1,
): Promise<GithubChecksSurfaceV1> {
  const prepared = await prepareConditionalChecks(input, dependencies);
  if (prepared?.reused?.surface) return prepared.reused.surface;
  const surface = await readFreshGithubChecksConditionSurface(input, dependencies);
  retainConditionalChecks(prepared, { repositoryId: input.repositoryId ?? null, surface });
  return surface;
}
async function readFreshGithubChecksConditionSurface(
  input: ChecksInput & Readonly<{ headSha: string }>, dependencies: GithubChecksDependenciesV1,
): Promise<GithubChecksSurfaceV1> {
  const traversal = createChecksTraversal(input);
  while (true) {
    dependencies.signal.throwIfAborted();
    let response: Awaited<ReturnType<GithubChecksDependenciesV1['client']['request']>>;
    try {
      response = await dependencies.client.request({ url: `${GITHUB_API_ORIGIN}/graphql`, method: 'POST', readOnlyGraphql: true,
        headers: { 'Content-Type': 'application/json' }, body: encodeGithubChecksQueryBody({
          owner: input.route.owner, name: input.route.name, number: input.observation.pullRequestNumber,
          cursor: traversal.cursor, includeSummary: traversal.cursor === null && input.includeStatus === true,
          includeOutput: input.includeOutput === true,
        }) });
    } catch (error) {
      dependencies.signal.throwIfAborted();
      return traversal.finish('unknown', classifyGithubTransportFailure(error));
    }
    dependencies.signal.throwIfAborted();
    if (response.status !== 200) return traversal.finish('unknown', classifyGithubResponseFailure(response, dependencies.now()));
    let body: Readonly<Record<string, unknown>> | null;
    try { body = record(decodeGithubJsonResponse(response)); }
    catch (error) { return traversal.finish('unknown', classifyGithubTransportFailure(error)); }
    if (!body) return traversal.finish('unknown');
    const surface = traversal.consume(record(record(body.data)?.repository), body.errors);
    if (surface !== null) return surface;
  }
}
