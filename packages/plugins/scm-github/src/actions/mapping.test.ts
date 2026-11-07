import { expect, it } from 'vitest';
import { ForgeCiActionResultSchemasV1, ForgeCiJobV1Schema, ForgeCiStateV1Schema } from '@happier-dev/triage-protocol/ci/v1';
import { mapGithubCiState, mapGithubJob, mapGithubRun } from './mapping.js';
import type { GithubCheckObservationV1 } from '../triage/checks.js';

it('preserves GitHub whole-second step precision without rounding higher-precision endpoints', () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/forge-qa-sandbox' } as const;
  const native = { id: 120968048785, run_id: 40126196389, name: 'forge-qa-test-two', status: 'completed', conclusion: 'failure',
    steps: [{ number: 2, name: 'forge-qa matrix test', status: 'completed', conclusion: 'failure',
      started_at: '2026-10-24T19:38:19Z', completed_at: '2026-10-24T19:38:19Z' }] };
  const coarse = mapGithubJob(native, repository);
  expect(coarse.steps).toMatchObject({ kind: 'available', values: [{ timestampPrecision: 'second',
    startedAtMs: Date.parse(native.steps[0]!.started_at), completedAtMs: Date.parse(native.steps[0]!.completed_at) }] });
  expect(ForgeCiJobV1Schema.parse(coarse)).toEqual(coarse);
  const precise = mapGithubJob({ ...native, steps: [{ ...native.steps[0],
    started_at: '2026-10-24T19:38:19.100Z', completed_at: '2026-10-24T19:38:19.200Z' }] }, repository);
  expect(precise.steps.kind === 'available' && precise.steps.values[0]).not.toHaveProperty('timestampPrecision');
});

it('retains the run update fact without inventing completion or changing native job end times', () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/forge-qa-sandbox' } as const;
  const native = { id: 40126196389, status: 'completed', conclusion: 'failure',
    run_started_at: '2026-10-24T19:38:10Z', updated_at: '2026-10-24T19:38:28Z' };
  const run = mapGithubRun(native, repository);
  expect(run).toMatchObject({ startedAtMs: Date.parse(native.run_started_at), updatedAtMs: Date.parse(native.updated_at) });
  expect(run).not.toHaveProperty('completedAtMs');
  expect(ForgeCiActionResultSchemasV1.readRun.parse({ kind: 'value', value: run })).toEqual({ kind: 'value', value: run });
  expect(mapGithubRun({ ...native, updated_at: 'not-a-timestamp' }, repository)).not.toHaveProperty('updatedAtMs');
  const job = mapGithubJob({ id: 120968048785, run_id: native.id, name: 'forge-qa-test-two', status: 'completed', conclusion: 'failure',
    started_at: '2026-10-24T19:38:18Z', completed_at: '2026-10-24T19:38:21Z', updated_at: native.updated_at }, repository);
  expect(job).toHaveProperty('completedAtMs', Date.parse('2026-10-24T19:38:21Z'));
  expect(job).not.toHaveProperty('updatedAtMs');
});

it('preserves unknown native status as the canonical unknown state rather than an active null outcome', () => {
  const state = mapGithubCiState({ status: 'future_status', conclusion: null });
  expect(ForgeCiStateV1Schema.parse(state)).toEqual({ phase: 'unknown', outcome: 'unknown', nativeLabel: 'future_status', outcomeBucket: 'unknown' });
});

it('projects admitted fork approval provenance without turning a generic deployment wait into fork approval', () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
  const native = { id: 81, run_attempt: 2, head_sha: 'a'.repeat(40), event: 'pull_request', status: 'action_required',
    actor: { login: 'contributor' }, repository: { full_name: repository.repository }, head_repository: { full_name: 'contributor/example-app' } };
  expect(mapGithubRun(native, repository)).toMatchObject({ headSha: native.head_sha, forkApproval: {
    required: true, contributor: 'contributor', sourceRepository: { ...repository, repository: 'contributor/example-app' },
  } });
  expect(mapGithubRun({ ...native, status: 'waiting' }, repository)).not.toHaveProperty('forkApproval');
  expect(mapGithubRun({ ...native, head_repository: { full_name: 'OCTO-ORG/Example-App' } }, repository)).not.toHaveProperty('forkApproval');
});

it('admits the exact Check Run relation across GitHub repository-name casing', () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'Octo-Org/Example-App' } as const;
  const job = mapGithubJob({ id: 91, run_id: 81, run_attempt: 2, name: 'build', status: 'completed', conclusion: 'failure', steps: [],
    check_run_url: 'https://api.github.com/repos/octo-org/example-app/check-runs/701' }, repository);
  expect(job.checkRunId).toBe('701');
});

it('joins known annotation counts by verified Actions provenance rather than equating a GraphQL node ID with a database ID', () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
  const selection = { kind: 'attempt' as const, attempt: { run: { v: 1 as const, repository, runId: '81' }, attemptId: '2' } };
  const sha = 'a'.repeat(40);
  const raw = { id: 91, run_id: 81, run_attempt: 2, head_sha: sha, name: 'build', status: 'completed', conclusion: 'failure', steps: [],
    check_run_url: 'https://api.github.com/repos/octo-org/example-app/check-runs/701' };
  const check: GithubCheckObservationV1 = { key: 'github-check-run:CR_graphql_node', resourceKind: 'check-run', name: 'build',
    status: 'completed', conclusion: 'failure', detailsUrl: null, startedAtMs: null, completedAtMs: null, logExcerpt: null,
    annotationsCount: 12, actions: { selection, checkRunId: '701', headSha: sha } };
  expect(mapGithubJob(raw, repository, selection, check).annotationsCount).toBe(12);
  expect(mapGithubJob(raw, repository, selection, { ...check, actions: { ...check.actions!, headSha: 'b'.repeat(40) } })).not.toHaveProperty('annotationsCount');
  const otherAttempt = { kind: 'attempt' as const, attempt: { ...selection.attempt, attemptId: '1' } };
  expect(mapGithubJob(raw, repository, selection, { ...check, actions: { ...check.actions!, selection: otherAttempt } })).not.toHaveProperty('annotationsCount');
});
