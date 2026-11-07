import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiAnnotationV1, ForgeCiArtifactV1, ForgeCiJobV1, ForgeCiRunV1, ForgeCiSelectionV1, ForgeCiStateV1, ForgeCiStepV1, ForgeCiWorkflowV1 } from '@happier-dev/triage-protocol/ci/v1';
import { FAILING_CONCLUSIONS, NEUTRAL_CONCLUSIONS, readGithubCheckOutcomeV1 } from '../triage/checkOutcome.js';
import { readGithubPositiveDecimal } from '../observations/githubProviderContracts.js';
import { parseGithubRoutingToken, readGithubAbsoluteWebUrl } from '../triage/locator.js';
import type { GithubCheckObservationV1 } from '../triage/checks.js';

export function githubRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RangeError('Invalid GitHub object');
  return value as Readonly<Record<string, unknown>>;
}
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function timeFields(raw: Readonly<Record<string, unknown>>) {
  return { ...(timestamp(raw.started_at ?? raw.run_started_at) === undefined ? {} : { startedAtMs: timestamp(raw.started_at ?? raw.run_started_at) }),
    ...(timestamp(raw.completed_at) === undefined ? {} : { completedAtMs: timestamp(raw.completed_at) }) };
}
export function mapGithubCiState(raw: Readonly<Record<string, unknown>>): ForgeCiStateV1 {
  const status = text(raw.status) ?? 'unknown';
  const conclusion = text(raw.conclusion) ?? null;
  const phase = status === 'completed' ? 'completed' : status === 'in_progress' ? 'running'
    : status === 'queued' || status === 'requested' || status === 'pending' ? 'queued'
      : status === 'waiting' ? 'waiting' : 'unknown';
  if (phase === 'unknown') return { phase, outcome: 'unknown', nativeLabel: status, outcomeBucket: 'unknown' };
  const outcomeBucket = readGithubCheckOutcomeV1({ status, conclusion });
  if (phase !== 'completed') return { phase, outcome: null, nativeLabel: status, outcomeBucket };
  const outcome = conclusion === 'success' || (conclusion !== null && (FAILING_CONCLUSIONS.has(conclusion) || NEUTRAL_CONCLUSIONS.has(conclusion)))
    ? conclusion as Extract<ForgeCiStateV1, { phase: 'completed' }>['outcome'] : 'unknown';
  return { phase, outcome, nativeLabel: conclusion ?? status, outcomeBucket };
}
export function githubRunSelection(repository: ScmHostingRepositoryIdentityV1, runId: string, attempt?: string): ForgeCiSelectionV1 {
  const run = { v: 1 as const, repository, runId: readGithubPositiveDecimal(runId, 'run ID') };
  return attempt === undefined ? { kind: 'run', run }
    : { kind: 'attempt', attempt: { run, attemptId: readGithubPositiveDecimal(attempt, 'attempt'), ...(Number.isSafeInteger(Number(attempt)) ? { number: Number(attempt) } : {}) } };
}
export function mapGithubWorkflow(value: unknown): ForgeCiWorkflowV1 {
  const raw = githubRecord(value);
  if (typeof raw.name !== 'string' || typeof raw.state !== 'string') throw new RangeError('Invalid GitHub workflow');
  const webUrl = readGithubAbsoluteWebUrl(raw.html_url);
  return { id: readGithubPositiveDecimal(raw.id, 'workflow ID'), name: raw.name, nativeState: raw.state,
    ...(typeof raw.path === 'string' ? { path: raw.path } : {}), ...(webUrl === null ? {} : { webUrl }) };
}
export function mapGithubRun(value: unknown, repository: ScmHostingRepositoryIdentityV1): ForgeCiRunV1 {
  const raw = githubRecord(value);
  const runId = readGithubPositiveDecimal(raw.id, 'run ID');
  if (raw.repository !== undefined) {
    const nativeRepository = githubRecord(raw.repository);
    if (typeof nativeRepository.full_name !== 'string' || nativeRepository.full_name.toLowerCase() !== repository.repository.toLowerCase()) throw new RangeError('GitHub run repository mismatch');
  }
  const attempt = raw.run_attempt === undefined ? undefined : readGithubPositiveDecimal(raw.run_attempt, 'attempt');
  const ref = { v: 1 as const, repository, runId };
  const webUrl = readGithubAbsoluteWebUrl(raw.html_url);
  const approvalRequired = raw.status === 'action_required' || raw.status === 'completed' && raw.conclusion === 'action_required';
  const headRepository = typeof raw.head_repository === 'object' && raw.head_repository !== null ? githubRecord(raw.head_repository) : null;
  const sourceName = headRepository?.full_name;
  const actor = typeof raw.actor === 'object' && raw.actor !== null ? githubRecord(raw.actor) : null;
  const forkApproval = approvalRequired && (raw.event === 'pull_request' || raw.event === 'pull_request_target')
    && typeof sourceName === 'string' && parseGithubRoutingToken(sourceName) !== null && sourceName.toLowerCase() !== repository.repository.toLowerCase()
    ? { required: true, sourceRepository: { kind: repository.kind, deployment: repository.deployment, repository: sourceName },
      ...(typeof actor?.login === 'string' && actor.login.length > 0 ? { contributor: actor.login } : {}) } : undefined;
  return { ref, state: mapGithubCiState(raw),
    ...(forkApproval === undefined ? {} : { forkApproval }),
    ...(typeof raw.display_title === 'string' || typeof raw.name === 'string' ? { title: String(raw.display_title ?? raw.name) } : {}),
    ...(typeof raw.run_number === 'number' && Number.isSafeInteger(raw.run_number) ? { number: raw.run_number } : {}),
    ...(typeof raw.head_sha === 'string' ? { headSha: raw.head_sha } : {}),
    ...(typeof raw.head_branch === 'string' ? { headRef: raw.head_branch } : {}),
    ...(timestamp(raw.created_at) === undefined ? {} : { createdAtMs: timestamp(raw.created_at) }), ...timeFields(raw),
    ...(timestamp(raw.updated_at) === undefined ? {} : { updatedAtMs: timestamp(raw.updated_at) }),
    ...(webUrl === null ? {} : { webUrl }),
    ...(raw.workflow_id === undefined ? {} : { workflow: { id: readGithubPositiveDecimal(raw.workflow_id, 'workflow ID'), ...(typeof raw.path === 'string' ? { path: raw.path } : {}) } }),
    ...(attempt === undefined ? {} : { currentAttempt: { run: ref, attemptId: attempt, number: Number(attempt) }, attemptCount: Number(attempt) }) };
}
export function mapGithubJob(value: unknown, repository: ScmHostingRepositoryIdentityV1, selection?: ForgeCiSelectionV1, check?: GithubCheckObservationV1): ForgeCiJobV1 {
  const raw = githubRecord(value);
  const runId = readGithubPositiveDecimal(raw.run_id, 'job run ID');
  const expectedRun = selection?.kind === 'run' ? selection.run : selection?.attempt.run;
  if (expectedRun !== undefined && expectedRun.runId !== runId) throw new RangeError('GitHub job run mismatch');
  const selected = selection?.kind === 'attempt' ? selection : githubRunSelection(repository, runId,
    raw.run_attempt === undefined ? undefined : readGithubPositiveDecimal(raw.run_attempt, 'job attempt'));
  const run = selected.kind === 'run' ? selected.run : selected.attempt.run;
  if (run.runId !== runId || (selected.kind === 'attempt' && (raw.run_attempt === undefined || String(raw.run_attempt) !== selected.attempt.attemptId))) throw new RangeError('GitHub job selection mismatch');
  if (typeof raw.name !== 'string') throw new RangeError('Invalid GitHub job');
  const steps: ForgeCiStepV1[] = Array.isArray(raw.steps) ? raw.steps.map(value => {
    const step = githubRecord(value);
    const id = readGithubPositiveDecimal(step.number, 'step number');
    if (typeof step.name !== 'string') throw new RangeError('Invalid GitHub step');
    const secondPrecision = typeof step.started_at === 'string' && !step.started_at.includes('.')
      && typeof step.completed_at === 'string' && !step.completed_at.includes('.');
    return { id, number: Number(id), name: step.name, state: mapGithubCiState(step), ...timeFields(step),
      ...(secondPrecision ? { timestampPrecision: 'second' as const } : {}) };
  }) : [];
  const webUrl = readGithubAbsoluteWebUrl(raw.html_url);
  let checkRunId: string | undefined;
  if (typeof raw.check_run_url === 'string') {
    const url = new URL(raw.check_run_url);
    const match = /^\/repos\/([^/]+)\/([^/]+)\/check-runs\/([1-9][0-9]*)$/u.exec(url.pathname);
    if (url.origin === 'https://api.github.com' && !url.username && !url.password && !url.search && !url.hash
      && match && `${match[1]}/${match[2]}`.toLowerCase() === repository.repository.toLowerCase()) checkRunId = match[3];
  }
  const checkTarget = check?.actions;
  const checkSelection = checkTarget?.selection;
  const checkRun = checkSelection?.kind === 'run' ? checkSelection.run : checkSelection?.attempt.run;
  const matchingCheck = checkTarget?.checkRunId === checkRunId && checkTarget?.headSha === raw.head_sha
    && checkRun !== undefined && sameScmHostingRepositoryIdentity(checkRun.repository, repository) && checkRun.runId === runId
    && checkSelection?.kind === selected.kind
    && (selected.kind !== 'attempt' || checkSelection?.kind === 'attempt' && checkSelection.attempt.attemptId === selected.attempt.attemptId);
  return { ref: { selection: selected, jobId: readGithubPositiveDecimal(raw.id, 'job ID') }, name: raw.name,
    state: mapGithubCiState(raw), steps: Array.isArray(raw.steps) ? { kind: 'available', values: steps } : { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_job_steps_missing' } },
    ...(typeof raw.runner_name === 'string' ? { runnerName: raw.runner_name } : {}),
    ...(Array.isArray(raw.labels) && raw.labels.every(label => typeof label === 'string') ? { runnerLabels: raw.labels } : {}),
    ...(typeof raw.head_sha === 'string' ? { headSha: raw.head_sha } : {}), ...timeFields(raw),
    ...(webUrl === null ? {} : { webUrl }), ...(checkRunId === undefined ? {} : { checkRunId }),
    ...(checkRunId !== undefined && matchingCheck && check?.annotationsCount !== undefined ? { annotationsCount: check.annotationsCount } : {}) };
}
export function mapGithubArtifact(value: unknown, repository: ScmHostingRepositoryIdentityV1, runId: string): ForgeCiArtifactV1 {
  const raw = githubRecord(value);
  if (typeof raw.name !== 'string') throw new RangeError('Invalid GitHub artifact');
  return { id: readGithubPositiveDecimal(raw.id, 'artifact ID'), run: { v: 1, repository, runId }, name: raw.name,
    availability: raw.expired === true ? 'expired' : raw.expired === false ? 'available' : 'unknown',
    ...(typeof raw.size_in_bytes === 'number' && Number.isSafeInteger(raw.size_in_bytes) && raw.size_in_bytes >= 0 ? { sizeBytes: raw.size_in_bytes } : {}),
    ...(typeof raw.digest === 'string' ? { digest: raw.digest } : {}),
    ...(timestamp(raw.expires_at) === undefined ? {} : { expiresAtMs: timestamp(raw.expires_at) }) };
}

export function mapGithubAnnotation(value: unknown, job: ForgeCiJobV1, checkRunId: string): ForgeCiAnnotationV1 {
  const raw = githubRecord(value);
  if (typeof raw.message !== 'string' || !['notice', 'warning', 'failure'].includes(String(raw.annotation_level))) throw new RangeError('Invalid annotation');
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const range = positive(raw.start_line) && positive(raw.end_line) && raw.end_line >= raw.start_line;
  return { id: `${checkRunId}:${String(raw.path ?? '')}:${String(raw.start_line ?? '')}:${String(raw.end_line ?? '')}:${raw.annotation_level}:${raw.message}`,
    job: job.ref, checkRunId, level: raw.annotation_level === 'failure' ? 'error' : raw.annotation_level as 'notice' | 'warning',
    message: raw.message, ...(typeof raw.title === 'string' ? { title: raw.title } : {}), ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
    ...(range ? { startLine: raw.start_line as number, endLine: raw.end_line as number } : {}),
    ...(range && raw.start_line === raw.end_line && positive(raw.start_column) && positive(raw.end_column) && raw.end_column >= raw.start_column ? { startColumn: raw.start_column, endColumn: raw.end_column } : {}),
    ...(typeof raw.raw_details === 'string' ? { details: raw.raw_details } : {}) };
}
