import { buildForgeCiFailureSummaryV1, buildForgeCiLogIndexV1, decodeForgeCiLogBytesV1, projectForgeCiLogPageV1 } from '@happier-dev/forge-ci/runtime';
import type { ForgeCiActionInputByOperationV1, ForgeCiAnnotationV1, ForgeCiJobV1, ForgeCiLogV1 } from '@happier-dev/triage-protocol/ci/v1';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubApiMediaClientV1 } from '../observations/githubApiClient.js';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { classifyGithubResponseFailure } from '../observations/githubResponseFailure.js';
import { githubRunSelection, mapGithubJob, mapGithubRun } from './mapping.js';
import { GithubCiReadError, githubCiCursorQuery, githubCiRepositoryUrl, githubCiRunRepositoryId, githubCiUnavailable, readExactGithubRun, readGithubCiPage, readGithubCiAnnotationsPage, readSelectedGithubJob } from './reads.js';

async function acquireLog(client: GithubApiMediaClientV1, job: ForgeCiJobV1): Promise<ForgeCiLogV1> {
  if (job.state.phase !== 'completed') return { kind: 'pending', job: job.ref };
  const run = job.ref.selection.kind === 'run' ? job.ref.selection.run : job.ref.selection.attempt.run;
  const response = await client.requestMedia({ url: githubCiRepositoryUrl(run.repository, 'actions', 'jobs', job.ref.jobId, 'logs'), media: 'json' });
  if (response.status === 410) return { kind: 'expired', job: job.ref };
  if (response.status !== 200) throw new GithubCiReadError(classifyGithubResponseFailure(response, Date.now()));
  return { kind: 'available', job: job.ref, logId: `${run.runId}:${job.ref.selection.kind === 'attempt' ? job.ref.selection.attempt.attemptId : 'current'}:${job.ref.jobId}`,
    text: decodeForgeCiLogBytesV1([response.body]), startLine: 1, startByte: 0, complete: true, continuation: null };
}

export async function readGithubJobLog(client: GithubApiMediaClientV1, input: ForgeCiActionInputByOperationV1['readJobLog']) {
  const job = await readSelectedGithubJob(client, input);
  const log = await acquireLog(client, job);
  if (log.kind !== 'available') return { kind: 'value', value: log };
  const index = buildForgeCiLogIndexV1({ log, steps: job.steps.kind === 'available' ? job.steps.values : [] });
  // Completed native logs are immutable; bind their identity and selection without serializing the body.
  const query = githubCiCursorQuery(client, 'github-ci-log-page-v1', [log.logId, JSON.stringify(input.selection)]);
  const cursor = input.cursor === undefined ? undefined : decodeTriagePagingTokenV1(input.cursor);
  if (input.cursor !== undefined && (cursor?.query !== query || typeof cursor.lineIndex !== 'number' || typeof cursor.utf16Offset !== 'number')) return githubCiUnavailable('github_log_continuation_invalid');
  return projectForgeCiLogPageV1({ index, selection: input.selection,
    ...(cursor === undefined || cursor === null ? {} : { position: { lineIndex: cursor.lineIndex as number, utf16Offset: cursor.utf16Offset as number } }),
    ...(input.maxSerializedBytes === undefined ? {} : { maxSerializedBytes: input.maxSerializedBytes }),
    mintContinuation: position => encodeTriagePagingTokenV1({ query, ...position }),
  });
}

export async function readGithubFailureContext(client: GithubApiMediaClientV1, input: ForgeCiActionInputByOperationV1['readFailureContext']) {
  const selected = input.selection;
  const ref = selected.kind === 'run' ? selected.run : selected.attempt.run;
  const attempt = selected.kind === 'attempt' ? selected.attempt.attemptId : undefined;
  if (!sameScmHostingRepositoryIdentity(input.repository, ref.repository)) return githubCiUnavailable('github_ci_selection_mismatch');
  const raw = await readExactGithubRun(client, input.repository, ref.runId, attempt);
  const repositoryId = githubCiRunRepositoryId(raw);
  const run = mapGithubRun(raw, input.repository);
  const selection = githubRunSelection(input.repository, ref.runId, String(raw.run_attempt));
  const jobs: ForgeCiJobV1[] = [];
  let cursor: string | undefined;
  do {
    const page = await readGithubCiPage(client, new URL(githubCiRepositoryUrl(input.repository, 'actions', 'runs', ref.runId, 'attempts', String(raw.run_attempt), 'jobs')), { cursor }, 'jobs', value => {
      const job = mapGithubJob(value, input.repository, selection);
      if (run.headSha === undefined || job.headSha !== run.headSha) throw new RangeError('GitHub failure job head mismatch');
      return job;
    }, false, repositoryId);
    if (page.kind !== 'value') return page;
    jobs.push(...page.value.rows.filter(job => input.jobs === undefined
      ? job.state.outcomeBucket === 'failed' || job.state.outcomeBucket === 'unknown' : input.jobs.includes(job.ref.jobId)));
    if (page.value.omittedRowCount > 0 || page.value.incomplete !== null) return githubCiUnavailable('github_failure_jobs_incomplete');
    cursor = page.value.continuation ?? undefined;
  } while (cursor !== undefined);
  if (input.jobs?.some(id => !jobs.some(job => job.ref.jobId === id))) return githubCiUnavailable('github_failure_job_selection_invalid');
  const logs = [];
  const annotations: ForgeCiAnnotationV1[] = [];
  const unavailable: string[] = [];
  for (const job of jobs) {
    try {
      const log = await acquireLog(client, job);
      if (log.kind === 'available') logs.push(buildForgeCiLogIndexV1({ log, steps: job.steps.kind === 'available' ? job.steps.values : [] }));
    } catch { /* The shared summary reports this exact job's unavailable log and keeps readable peers. */ }
    if (job.checkRunId !== undefined && job.annotationsCount !== 0) {
      let annotationCursor: string | undefined;
      do {
        try {
          const page = await readGithubCiAnnotationsPage(client, job, { cursor: annotationCursor }, repositoryId);
          if (page.kind !== 'value') { unavailable.push(`${job.ref.jobId}:annotations_unavailable`); break; }
          annotations.push(...page.value.rows);
          if (page.value.incomplete !== null || page.value.omittedRowCount > 0) unavailable.push(`${job.ref.jobId}:annotations_incomplete`);
          annotationCursor = page.value.continuation ?? undefined;
        } catch { unavailable.push(`${job.ref.jobId}:annotations_unavailable`); break; }
      } while (annotationCursor !== undefined);
    }
  }
  // This is typed evidence only. L05A's configured handoff and canonical prompt
  // renderer own framing and delivery; this Action cannot send or start a Session.
  return buildForgeCiFailureSummaryV1({ run, selection, jobs, logs, annotations, missing: unavailable,
    excerpt: input.excerpt, maxSerializedBytes: input.maxSerializedBytes,
  });
}
