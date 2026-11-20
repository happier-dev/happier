import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import { decodeGithubPendingDeploymentsV1 } from '../actions/deploymentReviews.js';
import { reconcileGithubDeploymentNoticeFactsV1 } from '../actions/deploymentNotices.js';
import type { GithubDeploymentNoticeFactsV1, GithubDeploymentMonitorCursorV1 } from '../actions/deploymentReviewProtocol.js';
import { githubRecord as record } from '../actions/mapping.js';
import { GithubCiReadError, requestGithubCiJson } from '../actions/reads.js';
import { createGithubApiClient, decodeGithubJsonResponse, type GithubApiMediaClientV1 } from './githubApiClient.js';
import { classifyGithubResponseFailure } from './githubResponseFailure.js';
import { readGithubPositiveDecimal, type GithubAutomationRepositoryEventSourceConfigV1 } from './githubProviderContracts.js';
import { buildGithubApiUrl } from '../triage/locator.js';
import { readValidatedGithubFollowUpPage, validateGithubFollowUpPageUrl } from '../triage/scan/link.js';
import { GITHUB_MAX_PAGE_SIZE_V1 } from '../triage/types.js';

type GithubDeploymentWaitingPagesV1 = NonNullable<GithubDeploymentMonitorCursorV1['waitingPages']>;
type GithubDeploymentRunReadV1 =
  | Readonly<{ kind: 'value'; pending: readonly GithubDeploymentNoticeFactsV1[] }>
  | Readonly<{ kind: 'failed'; error: unknown }>;

/** Finite provider facts, shared only within one admitted repository attempt. */
export type GithubDeploymentReviewCandidateV1 =
  | Readonly<{ kind: 'census'; waitingPages: GithubDeploymentWaitingPagesV1;
    responseHeaders: Readonly<Record<string, string>>; runs: ReadonlyMap<string, GithubDeploymentRunReadV1> }>
  | Readonly<{ kind: 'exactRun'; runId: string;
    responseHeaders: Readonly<Record<string, string>>; runs: ReadonlyMap<string, GithubDeploymentRunReadV1> }>;

function deploymentCensusDemand(previous: GithubDeploymentMonitorCursorV1 | null, pages: GithubDeploymentWaitingPagesV1) {
  const priorPages = previous?.waitingPages ?? [];
  const unchanged = pluginJsonValuesEqual(priorPages, pages);
  const waitingPages = unchanged ? priorPages : pages;
  const runIds = new Set<string>();
  if (previous !== null && unchanged) return { waitingPages, runIds, unchanged: true };
  const priorRuns = new Map(priorPages.flatMap(page => page.runs.map(run => [run.runId, run] as const)));
  const candidateIds = new Set<string>();
  for (const page of pages) for (const run of page.runs) {
    candidateIds.add(run.runId);
    const prior = priorRuns.get(run.runId);
    if (!prior || !pluginJsonValuesEqual(prior, run)) runIds.add(run.runId);
  }
  const candidatesChanged = runIds.size > 0 || [...priorRuns.keys()].some(runId => !candidateIds.has(runId));
  for (const pending of previous?.pending ?? []) {
    if (!candidateIds.has(pending.runId) && (priorPages.length === 0 || candidatesChanged)) runIds.add(pending.runId);
  }
  return { waitingPages, runIds, unchanged: false };
}

/** Reads one complete census and the union of each subscriber's exact demand. */
export async function readGithubDeploymentReviewCandidateV1(input: Readonly<{
  source: GithubAutomationRepositoryEventSourceConfigV1;
  previousCursors: readonly (GithubDeploymentMonitorCursorV1 | null)[];
  client?: GithubApiMediaClientV1;
  /** Authenticated webhook wake: read only this run, never the waiting census. */
  deliveredRunId?: string;
}>, context: PluginInvocationContext): Promise<GithubDeploymentReviewCandidateV1> {
  if (!input.source.deploymentReview) throw new RangeError('Deployment monitoring is not enrolled');
  const { repository, credentialRef } = input.source;
  const client = input.client ?? await createGithubApiClient(context, credentialRef);
  const root = buildGithubApiUrl(['repos', repository.owner, repository.name, 'actions', 'runs']);
  const query = new URL(root);
  query.searchParams.set('status', 'waiting');
  query.searchParams.set('per_page', String(GITHUB_MAX_PAGE_SIZE_V1));
  let next: string | null = query.toString();
  // A fresh or divergent subscriber cannot inherit another subscriber's ETag
  // baseline: only an agreed complete census permits conditional requests.
  const firstPages = input.previousCursors[0]?.waitingPages ?? [];
  const priorPages = input.previousCursors.every(previous => pluginJsonValuesEqual(previous?.waitingPages ?? [], firstPages)) ? firstPages : [];
  const priorPagesByUrl = new Map(priorPages.map(page => [page.url, page]));
  const pages: Array<GithubDeploymentWaitingPagesV1[number]> = [];
  const runIds = new Set<string>();
  let candidateCount = 0;
  const candidateIds = new Set<string>();
  let total: number | null = null;
  let responseHeaders: Readonly<Record<string, string>> = {};
  if (input.deliveredRunId !== undefined) runIds.add(readGithubPositiveDecimal(input.deliveredRunId, 'run ID'));
  while (input.deliveredRunId === undefined && next !== null) {
    context.signal.throwIfAborted();
    const cached = priorPagesByUrl.get(next);
    const response = await client.request({ url: next,
      ...(cached?.etag === undefined ? {} : { headers: { 'If-None-Match': cached.etag } }) });
    if (pages.length === 0) responseHeaders = response.headers;
    let page: (typeof pages)[number];
    if (response.status === 304) {
      if (!cached) throw new RangeError('Waiting deployment baseline is unavailable');
      if (cached.nextUrl !== null && validateGithubFollowUpPageUrl(cached.nextUrl, next, repository.repositoryId) === null) {
        throw new RangeError('Waiting deployment continuation is invalid');
      }
      const etag = readTriageResponseHeaderV1(response.headers, 'etag') ?? cached.etag;
      page = etag === cached.etag ? cached : { ...cached, ...(etag === undefined ? {} : { etag }) };
    } else {
      if (response.status !== 200) throw new GithubCiReadError(classifyGithubResponseFailure(response, Date.now()));
      const body = record(decodeGithubJsonResponse(response));
      if (!Array.isArray(body.workflow_runs) || typeof body.total_count !== 'number' || !Number.isSafeInteger(body.total_count) || body.total_count < 0) throw new RangeError('Waiting deployments are incomplete');
      const runs = body.workflow_runs.map(value => {
        const native = record(value);
        const run = { runId: readGithubPositiveDecimal(native.id, 'run ID'),
          ...(native.run_attempt === undefined ? {} : { attempt: readGithubPositiveDecimal(native.run_attempt, 'attempt') }),
          ...(native.updated_at === undefined ? {} : { updatedAt: native.updated_at }),
        };
        if (run.updatedAt !== undefined && typeof run.updatedAt !== 'string') throw new RangeError('Invalid waiting deployment update');
        return { runId: run.runId, ...(run.attempt === undefined ? {} : { attempt: run.attempt }),
          ...(run.updatedAt === undefined ? {} : { updatedAt: run.updatedAt }) };
      });
      const continuation = readValidatedGithubFollowUpPage(response.headers, next, repository.repositoryId);
      if (continuation.kind === 'invalid') throw new RangeError('Waiting deployment continuation is invalid');
      const etag = readTriageResponseHeaderV1(response.headers, 'etag');
      page = { url: next, ...(etag === null ? {} : { etag }), totalCount: body.total_count, runs,
        nextUrl: continuation.kind === 'next' ? continuation.url : null };
      if (cached && pluginJsonValuesEqual(cached, page)) page = cached;
    }
    pages.push(page);
    total ??= page.totalCount;
    if (page.totalCount !== total) throw new RangeError('Waiting deployment population changed during paging');
    for (const run of page.runs) {
      if (candidateIds.has(run.runId)) throw new RangeError('Waiting deployment page overlaps another page');
      candidateIds.add(run.runId);
      candidateCount++;
    }
    next = page.nextUrl;
  }
  // GitHub's filtered search ceiling must never turn an incomplete census into
  // proof that an earlier environment resolved.
  if (input.deliveredRunId === undefined && candidateCount !== total) throw new RangeError('Waiting deployment population is incomplete');
  if (input.deliveredRunId === undefined) {
    for (const previous of input.previousCursors) {
      for (const runId of deploymentCensusDemand(previous, pages).runIds) runIds.add(runId);
    }
  }
  const runs = new Map<string, GithubDeploymentRunReadV1>();
  for (const runId of runIds) {
    context.signal.throwIfAborted();
    try {
      const runResult = await requestGithubCiJson(client, `${root}/${runId}`);
      if (runResult.kind !== 'value') throw new RangeError('Unconditional deployment run returned 304');
      const run = record(runResult.value);
      const nativeRepository = record(run.repository);
      if (readGithubPositiveDecimal(run.id, 'run ID') !== runId
        || readGithubPositiveDecimal(nativeRepository.id, 'repository ID') !== repository.repositoryId) throw new RangeError('Deployment run provenance changed');
      const attempt = readGithubPositiveDecimal(run.run_attempt, 'attempt');
      const pendingResult = await requestGithubCiJson(client, `${root}/${runId}/pending_deployments`);
      if (pendingResult.kind !== 'value') throw new RangeError('Unconditional pending deployments returned 304');
      const pending = decodeGithubPendingDeploymentsV1(pendingResult.value, { repository: { kind: 'github', deployment: 'https://github.com', repository: repository.nameWithOwner }, runId });
      const facts = pending.map(approval => ({ repositoryId: repository.repositoryId, runId, attempt, environmentId: approval.id,
        environmentName: approval.environment.name, eligible: approval.eligible,
        ...(approval.waitUntilMs === undefined ? {} : { waitUntilMs: approval.waitUntilMs }),
        ...(approval.reviewers === undefined ? {} : { reviewers: approval.reviewers }) }));
      runs.set(runId, { kind: 'value', pending: facts });
    } catch (error) {
      context.signal.throwIfAborted();
      runs.set(runId, { kind: 'failed', error });
    }
  }
  context.signal.throwIfAborted();
  return input.deliveredRunId === undefined
    ? { kind: 'census', waitingPages: pages, responseHeaders, runs }
    : { kind: 'exactRun', runId: readGithubPositiveDecimal(input.deliveredRunId, 'run ID'), responseHeaders, runs };
}

/** Projects only this subscriber's demand; unrelated run failures stay local. */
export function projectGithubDeploymentReviewCandidateV1(input: Readonly<{
  previous: GithubDeploymentMonitorCursorV1 | null;
  candidate: GithubDeploymentReviewCandidateV1;
}>) {
  const { candidate } = input;
  const previous = input.previous?.pending ?? [];
  const demand = candidate.kind === 'census' ? deploymentCensusDemand(input.previous, candidate.waitingPages)
    : { waitingPages: input.previous?.waitingPages ?? [], runIds: new Set([candidate.runId]), unchanged: false };
  const responseHeaders = candidate.responseHeaders;
  if (input.previous !== null && demand.unchanged) return { cursor: input.previous, responseHeaders };
  const current = previous.filter(value => !demand.runIds.has(value.runId));
  for (const runId of demand.runIds) {
    const result = candidate.runs.get(runId);
    if (!result) throw new RangeError('Deployment run observation is unavailable');
    if (result.kind === 'failed') throw result.error;
    current.push(...result.pending);
  }
  const pending = reconcileGithubDeploymentNoticeFactsV1(previous, current);
  const cursor: GithubDeploymentMonitorCursorV1 = { kind: 'deploymentReview', v: 1, pending, waitingPages: demand.waitingPages };
  return { cursor, responseHeaders };
}

/** Named background demand, called only by the existing enrolled-source owner. */
export async function observeGithubDeploymentReviewsV1(input: Readonly<{
  source: GithubAutomationRepositoryEventSourceConfigV1;
  previous: GithubDeploymentMonitorCursorV1 | null;
  deliveredRunId?: string;
}>, context: PluginInvocationContext) {
  const candidate = await readGithubDeploymentReviewCandidateV1({ source: input.source, previousCursors: [input.previous],
    ...(input.deliveredRunId === undefined ? {} : { deliveredRunId: input.deliveredRunId }) }, context);
  return projectGithubDeploymentReviewCandidateV1({ previous: input.previous, candidate });
}
