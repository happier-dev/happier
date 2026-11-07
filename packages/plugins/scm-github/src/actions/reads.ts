import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import { readTriageResponseHeaderV1, encodeTriagePagingTokenV1, decodeTriagePagingTokenV1, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeCiActionInputByOperationV1, ForgeCiJobV1, ForgeCiRunFiltersV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { decodeGithubJsonResponse, type GithubApiClientV1 } from '../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { readGithubPositiveDecimal } from '../observations/githubProviderContracts.js';
import { buildGithubApiUrl, buildGithubRepositoryKey, parseGithubRoutingToken } from '../triage/locator.js';
import { createGithubRepositoryReader, decodeGithubRepositoryMetadata } from '../triage/repositories.js';
import { readValidatedGithubFollowUpPage } from '../triage/scan/link.js';
import { githubRecord, githubRunSelection, mapGithubAnnotation, mapGithubArtifact, mapGithubJob, mapGithubRun, mapGithubWorkflow } from './mapping.js';

export const githubCiUnavailable = (code: string) => ({ kind: 'unavailable' as const, failure: { class: 'unsupportedContract' as const, code } });
export class GithubCiReadError extends Error {
  constructor(readonly failure: TriageSourceFailureV1) { super(failure.code); }
}
// Every page is admitted under the current credential; cursors bind only their
// exact query, selection and native identity across client lifetimes.
export function githubCiCursorQuery(_client: GithubApiClientV1, domain: string, values: readonly string[]): string {
  return computeCanonicalDomainSeparatedDigest(domain, values);
}
export function githubCiRunRepositoryId(run: Readonly<Record<string, unknown>>): string | undefined {
  return decodeGithubRepositoryMetadata(run.repository)?.repositoryId;
}
export function githubCiRepositoryUrl(repository: ScmHostingRepositoryIdentityV1, ...segments: string[]): string {
  if (repository.kind !== 'github' || repository.deployment !== 'https://github.com') throw new RangeError('Unsupported GitHub deployment');
  const route = parseGithubRoutingToken(repository.repository);
  if (route === null) throw new RangeError('Invalid GitHub repository');
  return buildGithubApiUrl(['repos', route.owner, route.name, ...segments]);
}
export async function requestGithubCiJson(client: GithubApiClientV1, url: string, validator?: string) {
  const response = await client.request({ url, ...(validator === undefined ? {} : { headers: { 'If-None-Match': validator } }) });
  const etag = readTriageResponseHeaderV1(response.headers, 'etag');
  if (response.status === 304) return { kind: 'notModified' as const, ...(etag === null ? {} : { validator: etag }) };
  if (response.status !== 200) throw new GithubCiReadError(classifyGithubResponseFailure(response, Date.now()));
  return { kind: 'value' as const, value: decodeGithubJsonResponse(response), response, ...(etag === null ? {} : { validator: etag }) };
}
export async function readExactGithubRun(client: GithubApiClientV1, repository: ScmHostingRepositoryIdentityV1, runId: string, attempt?: string) {
  const id = readGithubPositiveDecimal(runId, 'run ID');
  const response = await requestGithubCiJson(client, githubCiRepositoryUrl(repository, 'actions', 'runs', id,
    ...(attempt === undefined ? [] : ['attempts', readGithubPositiveDecimal(attempt, 'attempt')])));
  if (response.kind !== 'value') throw new RangeError('Unconditional GitHub read returned 304');
  const raw = githubRecord(response.value);
  if (readGithubPositiveDecimal(raw.id, 'run ID') !== id) throw new RangeError('GitHub run identity mismatch');
  if (attempt !== undefined && String(raw.run_attempt) !== attempt) throw new RangeError('GitHub attempt mismatch');
  const nativeRepository = githubRecord(raw.repository);
  if (typeof nativeRepository.full_name !== 'string' || nativeRepository.full_name.toLowerCase() !== repository.repository.toLowerCase()) throw new RangeError('GitHub repository mismatch');
  return raw;
}

export function applyGithubCiRunFilters(url: URL, filters: ForgeCiRunFiltersV1): void {
  const keys = { actor: 'actor', branch: 'branch', event: 'event', state: 'status', created: 'created', excludePullRequests: 'exclude_pull_requests', checkSuiteId: 'check_suite_id', headSha: 'head_sha' } as const;
  // These are native API filter tokens, not a second outcome classifier.
  if (filters.state !== undefined && !['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending'].includes(filters.state)) throw new RangeError('Unsupported GitHub status filter');
  for (const key of Object.keys(keys) as Array<keyof typeof keys>) {
    const value = filters[key];
    if (value !== undefined) url.searchParams.set(keys[key], String(value));
  }
}

/** GitHub's documented page maximum, for collections a reader consumes whole. */
const GITHUB_CI_PAGE_SIZE_V1 = 100;
/** One provider page only; the public source-private codec binds the continuation to its exact query. */
export async function readGithubCiPage<T>(client: GithubApiClientV1, baseUrl: URL, input: Readonly<{ cursor?: string; validator?: string }>,
  arrayKey: string | null, map: (value: unknown) => T, filteredRuns = false, admittedRepositoryId?: string,
  perPage = GITHUB_CI_PAGE_SIZE_V1) {
  baseUrl.searchParams.set('per_page', String(perPage));
  const query = baseUrl.toString();
  let requestedUrl = query;
  let repositoryId = admittedRepositoryId ?? null;
  if (input.cursor !== undefined) {
    const cursor = decodeTriagePagingTokenV1(input.cursor);
    if (cursor?.query !== query || typeof cursor.url !== 'string'
      || (cursor.repositoryId !== null && (typeof cursor.repositoryId !== 'string' || !/^[1-9][0-9]*$/u.test(cursor.repositoryId)))
      || (admittedRepositoryId !== undefined && cursor.repositoryId !== admittedRepositoryId)
      || cursor.proof !== githubCiCursorQuery(client, 'github-ci-page-v1', [query, cursor.repositoryId ?? '', cursor.url])
      || readValidatedGithubFollowUpPage({ link: `<${cursor.url}>; rel="next"` }, query, cursor.repositoryId).kind !== 'next') throw new RangeError('Invalid GitHub CI continuation');
    repositoryId = cursor.repositoryId;
    requestedUrl = cursor.url;
  }
  const page = Number(new URL(requestedUrl).searchParams.get('page') ?? '1');
  const result = await requestGithubCiJson(client, requestedUrl, input.validator);
  if (result.kind !== 'value') return result;
  const body = arrayKey === null ? result.value : githubRecord(result.value)[arrayKey];
  if (!Array.isArray(body)) throw new RangeError('Invalid GitHub CI page');
  const rows: T[] = [];
  let omittedRowCount = 0;
  for (const row of body) { try { rows.push(map(row)); } catch { omittedRowCount += 1; } }
  const namedRepository = /^\/repos\/([^/]+)\/([^/]+)\//u.exec(baseUrl.pathname);
  const route = namedRepository === null ? null : parseGithubRoutingToken(`${namedRepository[1]}/${namedRepository[2]}`);
  if (repositoryId === null && arrayKey === 'workflow_runs' && route !== null) {
    for (const row of body) {
      const metadata = typeof row === 'object' && row !== null && !Array.isArray(row) ? decodeGithubRepositoryMetadata(githubRecord(row).repository) : null;
      if (metadata?.repositoryKey === buildGithubRepositoryKey(route)) { repositoryId = metadata.repositoryId; break; }
    }
  }
  let next = readValidatedGithubFollowUpPage(result.response.headers, requestedUrl, repositoryId);
  // Workflows/jobs/etc. do not carry repository metadata. Admit it only when
  // their Link needs that missing alias proof, then carry it through the cursor.
  if (next.kind === 'invalid' && repositoryId === null && route !== null) {
    const metadata = await createGithubRepositoryReader({ client, now: Date.now }).read(route);
    if (metadata.kind === 'readable' && metadata.repositoryKey === buildGithubRepositoryKey(route)) {
      repositoryId = metadata.repositoryId;
      next = readValidatedGithubFollowUpPage(result.response.headers, requestedUrl, repositoryId);
    }
  }
  let continuation: string | null = null;
  let incomplete: 'pagination' | 'provider_ceiling' | null = null;
  if (next.kind === 'invalid') incomplete = 'pagination';
  if (next.kind === 'next') {
    continuation = encodeTriagePagingTokenV1({ query, repositoryId, url: next.url,
      proof: githubCiCursorQuery(client, 'github-ci-page-v1', [query, repositoryId ?? '', next.url]) });
    if (continuation === null) incomplete = 'pagination';
  }
  // GitHub bounds filtered workflow-run listings at 1,000 entries. Keep the data
  // already read and expose the boundary; never invent an all-history total.
  if (filteredRuns && page * perPage >= 1000 && (continuation !== null || (arrayKey !== null && Number(githubRecord(result.value).total_count) > page * perPage))) {
    continuation = null; incomplete = 'provider_ceiling';
  }
  return { kind: 'value' as const, value: { rows, omittedRowCount, projectionTruncated: false, continuation, incomplete },
    ...(result.validator === undefined ? {} : { validator: result.validator }) };
}

export async function readSelectedGithubJob(client: GithubApiClientV1, input: Readonly<{ repository: ScmHostingRepositoryIdentityV1; runId: string; attempt?: string; jobId: string }>, admittedRun?: Readonly<Record<string, unknown>>): Promise<ForgeCiJobV1> {
  const run = admittedRun ?? await readExactGithubRun(client, input.repository, input.runId, input.attempt);
  const attempt = readGithubPositiveDecimal(run.run_attempt, 'attempt');
  const selection = githubRunSelection(input.repository, input.runId, attempt);
  const result = await requestGithubCiJson(client, githubCiRepositoryUrl(input.repository, 'actions', 'jobs', readGithubPositiveDecimal(input.jobId, 'job ID')));
  if (result.kind !== 'value') throw new RangeError('Unexpected conditional job read');
  const job = mapGithubJob(result.value, input.repository, selection);
  if (job.ref.jobId !== input.jobId) throw new RangeError('GitHub job identity mismatch');
  if (job.headSha === undefined || job.headSha !== run.head_sha) throw new RangeError('GitHub job head mismatch');
  return job;
}

type ReadOperation = 'listWorkflows' | 'readWorkflow' | 'listRuns' | 'readRun' | 'listJobs' | 'readJob' | 'listArtifacts' | 'listEnvironments' | 'listAnnotations';
export function readGithubCiAnnotationsPage(client: GithubApiClientV1, job: ForgeCiJobV1, input: Readonly<{ cursor?: string; validator?: string }>, repositoryId?: string) {
  if (job.checkRunId === undefined) throw new RangeError('Selected job has no verified Check Run');
  const run = job.ref.selection.kind === 'run' ? job.ref.selection.run : job.ref.selection.attempt.run;
  const checkRunId = job.checkRunId;
  return readGithubCiPage(client, new URL(githubCiRepositoryUrl(run.repository, 'check-runs', checkRunId, 'annotations')), input, null,
    raw => mapGithubAnnotation(raw, job, checkRunId), false, repositoryId);
}
export async function readGithubCiOperation<K extends ReadOperation>(operation: K, input: ForgeCiActionInputByOperationV1[K], client: GithubApiClientV1): Promise<unknown> {
  try {
    const repository = input.repository;
    // The operation branch narrows the schema-owned operands, not a local union.
    switch (operation) {
      case 'listWorkflows': return await readGithubCiPage(client, new URL(githubCiRepositoryUrl(repository, 'actions', 'workflows')), input, 'workflows', mapGithubWorkflow);
      case 'readWorkflow': {
        const operands = input as ForgeCiActionInputByOperationV1['readWorkflow'];
        const result = await requestGithubCiJson(client, githubCiRepositoryUrl(repository, 'actions', 'workflows', readGithubPositiveDecimal(operands.workflowId, 'workflow ID')), operands.validator);
        if (result.kind !== 'value') return result;
        const workflow = mapGithubWorkflow(result.value);
        if (workflow.id !== operands.workflowId) throw new RangeError('Workflow identity mismatch');
        return { kind: 'value', value: workflow, ...(result.validator === undefined ? {} : { validator: result.validator }) };
      }
      case 'readRun': {
        const operands = input as ForgeCiActionInputByOperationV1['readRun'];
        const result = await requestGithubCiJson(client, githubCiRepositoryUrl(repository, 'actions', 'runs', readGithubPositiveDecimal(operands.runId, 'run ID'), ...(operands.attempt === undefined ? [] : ['attempts', readGithubPositiveDecimal(operands.attempt, 'attempt')])), operands.validator);
        if (result.kind !== 'value') return result;
        const run = mapGithubRun(result.value, repository);
        if (run.ref.runId !== operands.runId || (operands.attempt !== undefined && run.currentAttempt?.attemptId !== operands.attempt)) throw new RangeError('Run identity mismatch');
        return { kind: 'value', value: run, ...(result.validator === undefined ? {} : { validator: result.validator }) };
      }
      case 'listRuns': {
        const operands = input as ForgeCiActionInputByOperationV1['listRuns'];
        const url = new URL(githubCiRepositoryUrl(repository, 'actions', ...(operands.workflowId === undefined ? [] : ['workflows', readGithubPositiveDecimal(operands.workflowId, 'workflow ID')]), 'runs'));
        applyGithubCiRunFilters(url, operands.filters);
        return await readGithubCiPage(client, url, operands, 'workflow_runs', raw => {
          const run = mapGithubRun(raw, repository);
          if ((operands.filters.headSha !== undefined && run.headSha !== operands.filters.headSha)
            || (operands.filters.branch !== undefined && run.headRef !== operands.filters.branch)
            || (operands.workflowId !== undefined && run.workflow?.id !== operands.workflowId)) throw new RangeError('GitHub run query provenance mismatch');
          return run;
        }, Object.keys(operands.filters).some(key => key !== 'excludePullRequests'), undefined,
        operands.pageSize ?? GITHUB_CI_PAGE_SIZE_V1);
      }
      case 'listJobs': {
        const operands = input as ForgeCiActionInputByOperationV1['listJobs'];
        const selection = githubRunSelection(repository, operands.runId, operands.attempt);
        return await readGithubCiPage(client, new URL(githubCiRepositoryUrl(repository, 'actions', 'runs', readGithubPositiveDecimal(operands.runId, 'run ID'), ...(operands.attempt === undefined ? [] : ['attempts', readGithubPositiveDecimal(operands.attempt, 'attempt')]), 'jobs')), operands, 'jobs', raw => mapGithubJob(raw, repository, selection));
      }
      case 'readJob': {
        const operands = input as ForgeCiActionInputByOperationV1['readJob'];
        const result = await requestGithubCiJson(client, githubCiRepositoryUrl(repository, 'actions', 'jobs', readGithubPositiveDecimal(operands.jobId, 'job ID')), operands.validator);
        if (result.kind !== 'value') return result;
        const job = mapGithubJob(result.value, repository);
        if (job.ref.jobId !== operands.jobId) throw new RangeError('Job identity mismatch');
        return { kind: 'value', value: job, ...(result.validator === undefined ? {} : { validator: result.validator }) };
      }
      case 'listArtifacts': {
        const operands = input as ForgeCiActionInputByOperationV1['listArtifacts'];
        return await readGithubCiPage(client, new URL(githubCiRepositoryUrl(repository, 'actions', 'runs', readGithubPositiveDecimal(operands.runId, 'run ID'), 'artifacts')), operands, 'artifacts', raw => mapGithubArtifact(raw, repository, operands.runId));
      }
      case 'listEnvironments': {
        const operands = input as ForgeCiActionInputByOperationV1['listEnvironments'];
        if (operands.search !== undefined) return githubCiUnavailable('github_environment_search_unsupported');
        return await readGithubCiPage(client, new URL(githubCiRepositoryUrl(repository, 'environments')), operands, 'environments', value => {
          const raw = githubRecord(value); if (typeof raw.name !== 'string') throw new RangeError('Invalid environment');
          return { id: readGithubPositiveDecimal(raw.id, 'environment ID'), name: raw.name };
        });
      }
      case 'listAnnotations': {
        const operands = input as ForgeCiActionInputByOperationV1['listAnnotations'];
        const run = await readExactGithubRun(client, repository, operands.runId, operands.attempt);
        const job = await readSelectedGithubJob(client, operands, run);
        if (job.checkRunId !== operands.checkRunId) throw new RangeError('Check Run does not belong to selected job');
        return await readGithubCiAnnotationsPage(client, job, operands, githubCiRunRepositoryId(run));
      }
    }
  } catch (error) {
    return { kind: 'unavailable', failure: error instanceof GithubCiReadError ? error.failure : error instanceof RangeError ? { class: 'unsupportedContract', code: 'github_ci_target_invalid' } : classifyGithubTransportFailure(error) };
  }
}
