import { describe, expect, it } from 'vitest';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1 } from '@happier-dev/triage-protocol/v1';
import { ForgeCiActionResultSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createStubGithubTransport, createTestGithubApiClient } from '../triage/testkit/githubTriage.test-support.js';
import { readGithubCiOperation, readSelectedGithubJob } from './reads.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
const sha = 'a'.repeat(40);
const nativeRepository = { id: 4210, full_name: repository.repository };
const nativeRun = { id: 81, run_attempt: 2, head_sha: sha, head_branch: 'topic', repository: nativeRepository };
const jobsPath = '/actions/runs/81/attempts/2/jobs';
const job = (id: number) => ({ id, run_id: 81, run_attempt: 2, head_sha: sha, name: 'build', status: 'completed', conclusion: 'failure', steps: [] });

describe('native CI exact repository pagination', () => {
  it('reads the requested 25 runs, then exactly the next 25 through the returned cursor', async () => {
    // Owner decision (board 12:05Z): the runs list opens with 25 runs and pages on demand.
    const runs = (offset: number) => Array.from({ length: 25 }, (_, index) => ({ ...nativeRun, id: 100 + offset + index }));
    const next = 'https://api.github.com/repositories/4210/actions/runs?per_page=25&page=2';
    const transport = createStubGithubTransport({ respond: request => request.url === next
      ? { status: 200, body: { workflow_runs: runs(25) } }
      : { status: 200, headers: { link: `<${next}>; rel="next"` }, body: { workflow_runs: runs(0) } } });
    const client = await createTestGithubApiClient(transport);
    const first = ForgeCiActionResultSchemasV1.listRuns.parse(await readGithubCiOperation('listRuns', { repository, filters: {}, pageSize: 25 }, client));
    if (first.kind !== 'value' || first.value.continuation === null) throw new Error('Expected a first page with a cursor');
    expect({ requests: transport.requests.length, runs: first.value.rows.length }).toEqual({ requests: 1, runs: 25 });
    expect(new URL(transport.requests[0]!.url).searchParams.get('per_page')).toBe('25');
    const second = ForgeCiActionResultSchemasV1.listRuns.parse(await readGithubCiOperation('listRuns',
      { repository, filters: {}, pageSize: 25, cursor: first.value.continuation }, client));
    if (second.kind !== 'value') throw new Error('Expected the next page');
    expect({ requests: transport.requests.length, runs: second.value.rows.length }).toEqual({ requests: 2, runs: 25 });
  });

  it('follows the admitted numeric repository Link unchanged and retains exact filters without metadata reads', async () => {
    const next = `https://api.github.com/repositories/4210/actions/runs?page=2&head_sha=${sha}&branch=topic&per_page=100`;
    const transport = createStubGithubTransport({ respond: request => {
      if (request.url === next) return { status: 200, body: { workflow_runs: [{ ...nativeRun, id: 82 }] } };
      return { status: 200, headers: { link: `<${next}>; rel="next"` }, body: { workflow_runs: [nativeRun] } };
    } });
    const client = await createTestGithubApiClient(transport);
    const input = { repository, filters: { branch: 'topic', headSha: sha } };
    const first = ForgeCiActionResultSchemasV1.listRuns.parse(await readGithubCiOperation('listRuns', input, client));
    expect(first).toMatchObject({ kind: 'value', value: { incomplete: null, continuation: expect.any(String) } });
    if (first.kind !== 'value' || first.value.continuation === null) throw new Error('Expected continuation');
    const second = await readGithubCiOperation('listRuns', { ...input, cursor: first.value.continuation }, client);
    expect(second).toMatchObject({ kind: 'value', value: { rows: [{ ref: { runId: '82' } }], continuation: null } });
    expect(transport.requests.map(request => request.url)).toEqual([
      `https://api.github.com/repos/octo-org/example-app/actions/runs?branch=topic&head_sha=${sha}&per_page=100`, next,
    ]);

    const before = transport.requests.length;
    const forged = encodeTriagePagingTokenV1({ ...decodeTriagePagingTokenV1(first.value.continuation), repositoryId: '999' });
    for (const changed of [{ ...input, filters: { branch: 'other', headSha: sha }, cursor: first.value.continuation }, { ...input, cursor: forged! }]) {
      expect(await readGithubCiOperation('listRuns', changed, client)).toMatchObject({ kind: 'unavailable' });
    }
    const otherTransport = createStubGithubTransport({ respond: request => {
      expect(request.url).toBe(next);
      return { status: 200, body: { workflow_runs: [{ ...nativeRun, id: 82 }] } };
    } });
    const other = await createTestGithubApiClient(otherTransport);
    expect(await readGithubCiOperation('listRuns', { ...input, cursor: first.value.continuation }, other))
      .toMatchObject({ kind: 'value', value: { rows: [{ ref: { runId: '82' } }], continuation: null } });
    expect(otherTransport.requests).toHaveLength(1);
    expect(transport.requests).toHaveLength(before);
  });

  it.each([
    'https://api.github.com/repositories/999/actions/runs?per_page=100&page=2',
    'https://api.github.com/repositories/4210/actions/runs?per_page=100&page=2&branch=other',
    'https://example.com/repositories/4210/actions/runs?per_page=100&page=2',
  ])('refuses a foreign repository, query or origin: %s', async next => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 200, headers: { link: `<${next}>; rel="next"` }, body: { workflow_runs: [nativeRun] } }) });
    const client = await createTestGithubApiClient(transport);
    expect(await readGithubCiOperation('listRuns', { repository, filters: {} }, client))
      .toMatchObject({ kind: 'value', value: { incomplete: 'pagination', continuation: null } });
    expect(transport.requests).toHaveLength(1);
  });

  it('admits repository metadata only when absent from a collection, then resumes without another metadata read', async () => {
    const next = 'https://api.github.com/repositories/4210/actions/workflows?per_page=100&page=2';
    const transport = createStubGithubTransport({ respond: request => {
      if (request.url === 'https://api.github.com/repos/octo-org/example-app') return { status: 200, body: nativeRepository };
      if (request.url === next) return { status: 200, body: { workflows: [{ id: 13, name: 'CI', state: 'active' }] } };
      return { status: 200, headers: { link: `<${next}>; rel="next"` }, body: { workflows: [{ id: 12, name: 'CI', state: 'active' }] } };
    } });
    const client = await createTestGithubApiClient(transport);
    const first = ForgeCiActionResultSchemasV1.listWorkflows.parse(await readGithubCiOperation('listWorkflows', { repository }, client));
    expect(first).toMatchObject({ kind: 'value', value: { incomplete: null, continuation: expect.any(String) } });
    if (first.kind !== 'value' || first.value.continuation === null) throw new Error('Expected continuation');
    expect(await readGithubCiOperation('listWorkflows', { repository, cursor: first.value.continuation }, client))
      .toMatchObject({ kind: 'value', value: { rows: [{ id: '13' }], continuation: null } });
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://api.github.com/repos/octo-org/example-app/actions/workflows?per_page=100',
      'https://api.github.com/repos/octo-org/example-app', next,
    ]);
  });

  it.each(['exact', 'wrong-run', 'wrong-attempt', 'wrong-head', 'wrong-job'])('reads a selected job once with exact run, attempt, SHA and job membership: %s', async membership => {
    const next = `https://api.github.com/repositories/4210${jobsPath}?per_page=100&page=2`;
    const selected = { ...job(2000), ...(membership === 'wrong-run' ? { run_id: 99 } : {}),
      ...(membership === 'wrong-attempt' ? { run_attempt: 1 } : {}), ...(membership === 'wrong-head' ? { head_sha: 'b'.repeat(40) } : {}),
      ...(membership === 'wrong-job' ? { id: 2001 } : {}) };
    const transport = createStubGithubTransport({ respond: request => {
      if (request.url.endsWith('/actions/runs/81/attempts/2')) return { status: 200, body: nativeRun };
      if (request.url.endsWith('/actions/jobs/2000')) return { status: 200, body: selected };
      if (request.url === next) return { status: 200, body: { jobs: [selected] } };
      if (request.url.includes(jobsPath)) return { status: 200, headers: { link: `<${next}>; rel="next"` }, body: { jobs: Array.from({ length: 100 }, (_, index) => job(1000 + index)) } };
      return undefined;
    } });
    const client = await createTestGithubApiClient(transport);
    const result = readSelectedGithubJob(client, { repository, runId: '81', attempt: '2', jobId: '2000' });
    if (membership === 'exact') await expect(result).resolves.toMatchObject({ ref: { jobId: '2000', selection: { kind: 'attempt', attempt: { attemptId: '2', run: { runId: '81' } } } }, headSha: sha });
    else await expect(result).rejects.toThrow();
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.url).toBe('https://api.github.com/repos/octo-org/example-app/actions/jobs/2000');
  });
});
