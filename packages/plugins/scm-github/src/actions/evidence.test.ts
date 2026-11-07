import { expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/plugin-sdk/actions';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ForgeCiActionResultSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiFailureContextReadRequestV1 } from '@happier-dev/forge-ci/runtime';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createStubGithubTransport, createTestGithubApiClient } from '../triage/testkit/githubTriage.test-support.js';
import { readGithubFailureContext, readGithubJobLog } from './evidence.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
const sha = 'a'.repeat(40);
const selectedAttempt = { kind: 'attempt', attempt: { run: { v: 1, repository, runId: '81' }, attemptId: '2' } } as const;
const nativeRun = { id: 81, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'failure', repository: { full_name: repository.repository } };

async function registeredFailureContext(input: JsonValue, respond: Parameters<typeof createStubGithubTransport>[0]['respond']) {
  // GitHub HTTP/credential materialization is the external boundary; activation,
  // Action admission, native mapping, log indexing and summary fitting stay real.
  const transport = createStubGithubTransport({ respond,
    nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic' } } });
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
  try {
    const registration = kit.registration('actions', 'github/actions/failure-context-read');
    if (typeof registration !== 'function') throw new Error('Failure-context Action is not registered');
    const result = ForgeCiActionResultSchemasV1.readFailureContext.parse(await registration(input, transport.context));
    return { result, transport };
  } finally { await kit.dispose(); }
}

it('reads selected failed and unknown evidence without caller limits through the registered native Action', async () => {
  const step = (number: number, conclusion: string, start: number, end: number) => ({ number, name: `step-${number}`, status: 'completed', conclusion,
    started_at: `1970-01-01T00:00:0${start}.000Z`, completed_at: `1970-01-01T00:00:0${end}.000Z` });
  const jobs = [
    { id: 91, run_id: 81, run_attempt: 2, head_sha: sha, name: 'failed', status: 'completed', conclusion: 'failure',
      steps: [step(1, 'failure', 1, 2), step(2, 'new-conclusion', 1, 2), step(3, 'success', 3, 4)] },
    { id: 92, run_id: 81, run_attempt: 2, head_sha: sha, name: 'unknown', status: 'completed', conclusion: 'new-conclusion', steps: [step(4, 'new-conclusion', 5, 6)] },
    { id: 93, run_id: 81, run_attempt: 2, head_sha: sha, name: 'passed', status: 'completed', conclusion: 'success', steps: [step(5, 'success', 7, 8)] },
  ];
  const respond: Parameters<typeof createStubGithubTransport>[0]['respond'] = request => {
    if (request.url.endsWith('/actions/runs/81/attempts/2')) return { status: 200, body: nativeRun };
    if (request.url.includes('/attempts/2/jobs')) return { status: 200, body: { total_count: jobs.length, jobs } };
    if (request.url.endsWith('/actions/jobs/91/logs')) return { status: 200, rawBody: new TextEncoder().encode('unassigned evidence\n1970-01-01T00:00:01.500Z ambiguous failure\n1970-01-01T00:00:03.500Z passed evidence') };
    if (request.url.endsWith('/actions/jobs/92/logs')) return { status: 200, rawBody: new TextEncoder().encode('1970-01-01T00:00:05.500Z unknown evidence') };
    if (request.url.endsWith('/actions/jobs/93/logs')) return { status: 200, rawBody: new TextEncoder().encode('1970-01-01T00:00:07.500Z selected passed evidence') };
    return undefined;
  };
  const { result, transport } = await registeredFailureContext(createForgeCiFailureContextReadRequestV1({ repository, selection: selectedAttempt }), respond);
  if (result.kind !== 'value') throw new Error('Expected selected failure evidence');
  expect(result.value.selection).toMatchObject(selectedAttempt);
  expect(result.value.jobs.map(job => job.job.jobId)).toEqual(['91', '92']);
  expect(result.value.jobs[0]?.steps.map(step => step.stepId)).toEqual(['1', '2']);
  expect(result.value.excerpts.map(excerpt => excerpt.text).join('\n')).toContain('unknown evidence');
  expect(result.value.excerpts.map(excerpt => excerpt.text).join('\n')).toContain('unassigned evidence');
  expect(result.value.excerpts.map(excerpt => excerpt.text).join('\n')).not.toContain('passed evidence');
  expect(result.value.ambiguous).toEqual(expect.arrayContaining(['91:unattributed_lines', '91:ambiguous_step_windows']));
  expect(transport.requests.filter(request => request.url.endsWith('/logs')).map(request => new URL(request.url).pathname))
    .toEqual(['/repos/octo-org/example-app/actions/jobs/91/logs', '/repos/octo-org/example-app/actions/jobs/92/logs']);
  const explicit = await registeredFailureContext(createForgeCiFailureContextReadRequestV1({ repository, selection: selectedAttempt, jobs: ['93'],
    excerpt: { contextLines: 0, tailLines: 0, failedOnly: false, stepIds: ['5'] }, maxSerializedBytes: 20_000 }), respond);
  expect(explicit.result).toMatchObject({ kind: 'value', value: { jobs: [{ job: { jobId: '93' }, steps: [{ stepId: '5' }] }],
    excerpts: [{ text: 'selected passed evidence' }] } });
  if (explicit.result.kind !== 'value') throw new Error('Expected explicit selection');
  expect(new TextEncoder().encode(JSON.stringify(explicit.result.value)).byteLength).toBeLessThanOrEqual(20_000);
  expect(explicit.transport.requests.filter(request => request.url.endsWith('/logs'))).toHaveLength(1);
});

it.each([undefined, EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES * 2])('fits the full native Action carrier with annotation missing facts before fitting (summary budget %s)', async maxSerializedBytes => {
  const { result } = await registeredFailureContext(createForgeCiFailureContextReadRequestV1({ repository, selection: selectedAttempt,
    ...(maxSerializedBytes === undefined ? {} : { maxSerializedBytes, excerpt: { contextLines: 0, tailLines: 0, failedOnly: true } }) }), request => {
    if (request.url.endsWith('/actions/runs/81/attempts/2')) return { status: 200, body: nativeRun };
    if (request.url.includes('/attempts/2/jobs')) return { status: 200, body: { total_count: 1, jobs: [
      { id: 91, run_id: 81, run_attempt: 2, head_sha: sha, name: 'failed', status: 'completed', conclusion: 'failure',
        check_run_url: 'https://api.github.com/repos/octo-org/example-app/check-runs/101',
        steps: [{ number: 1, name: 'test', status: 'completed', conclusion: 'failure' }] },
    ] } };
    if (request.url.endsWith('/actions/jobs/91/logs')) return { status: 200,
      rawBody: new TextEncoder().encode('\\'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2)) };
    if (request.url.includes('/check-runs/101/annotations')) return { status: 503, body: { message: 'unavailable' } };
    return undefined;
  });
  if (result.kind !== 'value') throw new Error('Expected fitted evidence');
  expect(result.value.missing).toContain('91:annotations_unavailable');
  expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(result)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
  expect(result.value.omitted).toContain('evidence_truncated_to_action_carrier');
  expect(result.value.excerpts[0]?.text.length).toBeGreaterThan(0);
});

it('never acquires failure evidence from a job at another commit', async () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
  const transport = createStubGithubTransport({ respond: request => {
    if (request.url.endsWith('/actions/runs/81/attempts/2')) return { status: 200, body: { id: 81, run_attempt: 2, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure', repository: { full_name: repository.repository } } };
    if (request.url.includes('/attempts/2/jobs')) return { status: 200, body: { total_count: 1, jobs: [
      { id: 91, run_id: 81, run_attempt: 2, head_sha: 'b'.repeat(40), name: 'build', status: 'completed', conclusion: 'failure', steps: [] },
    ] } };
    if (request.url.endsWith('/logs')) return { status: 200, rawBody: new TextEncoder().encode('wrong commit\n') };
    return undefined;
  } });
  const client = await createTestGithubApiClient(transport);
  const result = await readGithubFailureContext(client, { repository, selection: { kind: 'attempt', attempt: { run: { v: 1, repository, runId: '81' }, attemptId: '2' } },
    excerpt: { contextLines: 0, tailLines: 1, failedOnly: true }, maxSerializedBytes: 20000 });
  expect(result).toMatchObject({ kind: 'unavailable' });
  expect(transport.requests.some(request => request.url.endsWith('/logs'))).toBe(false);
});

it('pages completed original log bytes without whole-log serialization or retention and binds cursors to log identity and selection', async () => {
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
  const sha = 'a'.repeat(40);
  const text = Array.from({ length: 400 }, (_, i) => `line-${i} 🧭\r\n`).join('');
  let mediaReads = 0;
  const transport = createStubGithubTransport({ respond: request => {
    if (request.url.endsWith('/actions/runs/81/attempts/2')) return { status: 200, body: { id: 81, run_attempt: 2, head_sha: sha, repository: { full_name: repository.repository } } };
    const selectedJob = /\/actions\/jobs\/(91|92)$/u.exec(request.url);
    if (selectedJob) return { status: 200, body:
      { id: Number(selectedJob[1]), run_id: 81, run_attempt: 2, head_sha: sha, name: 'build', status: 'completed', conclusion: 'failure', steps: [] } };
    if (/\/actions\/jobs\/(91|92)\/logs$/u.test(request.url)) {
      mediaReads++;
      return { status: 200, rawBody: new TextEncoder().encode(text) };
    }
    return undefined;
  } });
  const client = await createTestGithubApiClient(transport);
  const input = { repository, runId: '81', attempt: '2', jobId: '91', selection: { kind: 'all' }, maxSerializedBytes: 3000 } as const;
  let cursor: string | undefined;
  let original = '';
  let pages = 0;
  // Instrument the built-in serializer without replacing its implementation.
  const stringify = vi.spyOn(JSON, 'stringify');
  try { do {
    const previousReads = mediaReads;
    const result = await readGithubJobLog(client, { ...input, ...(cursor === undefined ? {} : { cursor }) });
    expect(mediaReads).toBe(previousReads + 1);
    expect(stringify.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
      && 'kind' in value && value.kind === 'available' && 'text' in value && value.text === text)).toHaveLength(0);
    const admitted = ForgeCiActionResultSchemasV1.readJobLog.parse(result);
    expect(admitted.kind).toBe('value');
    if (admitted.kind !== 'value' || admitted.value.kind !== 'available') throw new Error('Completed log is unavailable');
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(admitted)).toBeLessThanOrEqual(3000);
    const value = admitted.value;
    original += 'fragments' in value ? value.fragments.map(fragment => fragment.text).join('') : value.text;
    pages += 1;
    if (pages === 1) {
      expect(value.complete).toBe(false);
      expect(value.continuation).toEqual(expect.any(String));
      const wrong = await readGithubJobLog(client, { ...input, selection: { kind: 'tail', lines: 1 }, cursor: value.continuation! });
      expect(wrong).toMatchObject({ kind: 'unavailable', failure: { code: 'github_log_continuation_invalid' } });
      const changedLog = await readGithubJobLog(client, { ...input, jobId: '92', cursor: value.continuation! });
      expect(changedLog).toMatchObject({ kind: 'unavailable', failure: { code: 'github_log_continuation_invalid' } });
      const other = ForgeCiActionResultSchemasV1.readJobLog.parse(await readGithubJobLog(client, { ...input, jobId: '92' }));
      if (other.kind !== 'value' || other.value.kind !== 'available') throw new Error('Expected the other completed log');
      expect(other.value.logId).not.toBe(value.logId);
    }
    cursor = value.continuation ?? undefined;
    if (cursor === undefined) expect(value.complete).toBe(true);
  } while (cursor !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(original).toBe(text);
  } finally { stringify.mockRestore(); }
});
