import { describe, expect, it } from 'vitest';
import { readPullRequestComparison } from '../../../../../apps/cli/src/scm/comparisons/readPullRequestComparisonPage';
import { getGitlabSourceEntryAction } from './operations.js';
import { listGitlabChanges } from './detailOperations.js';
import { GitlabChangesResultV1Schema } from './detail/contracts.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import {
  createStubGitlabTransport, gitlabTestConfiguredInstance, gitlabNextLinkHeader,
  GITLAB_TEST_COLLISION_SCOPE, GITLAB_TEST_ORIGIN,
  type RecordedGitlabRequest, type StubGitlabResponse,
} from './testkit/gitlabTriage.test-support.js';

const repository = 'group/subgroup/project';
const localRef = { kindId: 'merge-request', collisionScope: GITLAB_TEST_COLLISION_SCOPE, entryId: '7' };
const input = { v: 1, instance: gitlabTestConfiguredInstance(), localRef, routingToken: repository, limit: 1, comparison: true };
const beforeOid = 'a'.repeat(40), baseOid = 'b'.repeat(40), headOid = 'c'.repeat(40);
const metadata = { id: 700, project_id: 3, iid: 7, references: { full: `${repository}!7` },
  web_url: `${GITLAB_TEST_ORIGIN}/${repository}/-/merge_requests/7`, title: 'Change behavior', state: 'opened', sha: headOid, changes_count: '2',
  diff_refs: { base_sha: beforeOid, start_sha: baseOid, head_sha: headOid } };
const patch = '@@ -1 +1 @@\n-old\n+new\n';
const file = (path: string, overrides: Record<string, unknown> = {}) => ({ old_path: path, new_path: path,
  new_file: false, renamed_file: false, deleted_file: false, collapsed: false, too_large: false, diff: patch, ...overrides });
const ok = (body: unknown, headers = {}): StubGitlabResponse => ({ status: 200, headers, body });
const nextUrl = `${GITLAB_TEST_ORIGIN}/api/v4/projects/${encodeURIComponent(repository)}/merge_requests/7/diffs?page=2&per_page=1`;

function transport(options: { metadata?: (read: number) => unknown; page?: (request: RecordedGitlabRequest) => StubGitlabResponse } = {}) {
  let read = 0;
  return createStubGitlabTransport({ respond: request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/merge_requests/7')) return ok(options.metadata?.(++read) ?? metadata);
    if (url.pathname.endsWith('/user')) return ok({ id: 41, username: 'viewer' });
    if (url.pathname.endsWith('/diffs')) return options.page?.(request) ?? (url.searchParams.get('page') === '2'
      ? ok([file('second.ts')]) : ok([file('first.ts')], gitlabNextLinkHeader(nextUrl)));
    return undefined;
  } });
}

describe('merge request comparison evidence', () => {
  it('stops a repeated file page from an external forge even when its total is unknown', async () => {
    let pages = 0;
    const source = { kind: 'pullRequest' as const, locator: { providerId: 'external.forge', repository: 'deployment/project', number: 7,
      sourceAction: { action: { pluginId: 'external.forge', localId: 'comparison' }, input: {} } } };
    const captured = await readPullRequestComparison({ source, readPage: async () => {
      pages++;
      if (pages > 2) throw new Error('Repeated source page was requested again');
      return { kind: 'changedFiles', rows: [{ path: 'prefix.ts', status: 'modified', diffAvailable: true,
        evidence: { state: 'available', patch } }], omittedRowCount: 0, projectionTruncated: false, continuation: `cursor-${pages}`,
        comparison: { locator: { providerId: source.locator.providerId, repository: source.locator.repository, number: 7 },
          beforeOid, baseOid, headOid, totalFileCount: null, enumeratedFileCount: pages, freshness: 'current',
          inventory: 'incomplete', content: 'complete', reasons: ['pages_pending'] } };
    } });
    expect(pages).toBe(2);
    expect(captured).toMatchObject({ state: 'incomplete', files: [{ path: 'prefix.ts' }] });
    expect(captured.reasons).toContain('Duplicate pull-request path: prefix.ts');
  });
  it('opens the shared host comparison through evidence Actions but refuses metadata-only subtraction', async () => {
    const stub = transport();
    const entry = await getGitlabSourceEntryAction({ v: 1, instance: input.instance, localRef,
      lastKnownLocator: { v: 1, routingToken: repository } }, stub.context);
    expect(entry.kind).toBe('present');
    if (entry.kind !== 'present' || entry.comparisonSource?.kind !== 'pullRequest') throw new Error('comparison source missing');
    const source = entry.comparisonSource;
    expect(source.locator).toMatchObject({ providerId: 'gitlab', repository: `${GITLAB_TEST_ORIGIN}/${repository}`, number: 7, baseOid, headOid });
    const captured = await readPullRequestComparison({ source, readPage: async ({ sourceAction, continuation }) => {
      const result = await listGitlabChanges({ ...sourceAction.input, limit: 1, ...(continuation ? { continuation } : {}) }, stub.context);
      return GitlabChangesResultV1Schema.parse(result);
    } });
    expect(captured).toMatchObject({ state: 'complete', freshness: 'current', before: beforeOid, after: headOid,
      pullRequest: { url: metadata.web_url } });
    expect(captured.files.map(row => row.path)).toEqual(['first.ts', 'second.ts']);
    expect(captured.files[1]?.unifiedDiff).toContain(patch);
    const withoutEvidenceMode = await readPullRequestComparison({ source, readPage: ({ sourceAction }) => {
      const displayInput = { ...sourceAction.input, comparison: undefined };
      return listGitlabChanges(displayInput, stub.context);
    } });
    expect(withoutEvidenceMode).toMatchObject({ state: 'unavailable', files: [] });
  });

  it('keeps same-named merge requests on separate deployments in separate comparison scopes', async () => {
    const repositories: string[] = [];
    for (const origin of ['https://first.example', 'https://second.example']) {
      const collisionScope = `gitlab:${Buffer.from(origin).toString('base64url')}:3`;
      const instance = gitlabTestConfiguredInstance({ localInstanceKey: origin });
      const stub = createStubGitlabTransport({ origin, respond: request => new URL(request.url).pathname.endsWith('/user')
        ? ok({ id: 41, username: 'viewer' }) : ok(metadata) });
      const entry = await getGitlabSourceEntryAction({ v: 1, instance, localRef: { ...localRef, collisionScope },
        lastKnownLocator: { v: 1, routingToken: repository } }, stub.context);
      if (entry.kind !== 'present' || entry.comparisonSource?.kind !== 'pullRequest') throw new Error('comparison source missing');
      repositories.push(entry.comparisonSource.locator.repository);
    }
    expect(repositories).toEqual(['https://first.example/group/subgroup/project', 'https://second.example/group/subgroup/project']);
  });

  it.each(['base_sha', 'start_sha', 'head_sha'] as const)('refuses a changed %s without mixing pages', async endpoint => {
    const stub = transport({ metadata: read => read > 2
      ? { ...metadata, ...(endpoint === 'head_sha' ? { sha: 'd'.repeat(40) } : {}),
        diff_refs: { ...metadata.diff_refs, [endpoint]: 'd'.repeat(40) } } : metadata });
    const first = await listGitlabChanges(input, stub.context);
    expect(first.kind).toBe('changedFiles');
    if (first.kind !== 'changedFiles') throw new Error('comparison missing');
    const next = await listGitlabChanges({ ...input, continuation: first.continuation }, stub.context);
    expect(next).toMatchObject({ kind: 'changedFiles', rows: [], comparison: { freshness: 'stale', inventory: 'incomplete' } });
  });

  it('detects a head change during a single page read', async () => {
    const stub = transport({ metadata: read => read > 1 ? { ...metadata, sha: 'd'.repeat(40),
      diff_refs: { ...metadata.diff_refs, head_sha: 'd'.repeat(40) } } : metadata });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles',
      comparison: { freshness: 'stale', inventory: 'incomplete' } });
  });

  it.each([
    { flags: { diff: undefined }, state: 'unavailable' },
    { flags: { diff: '' }, state: 'unavailable' },
    { flags: { collapsed: true }, state: 'truncated' },
    { flags: { too_large: true }, state: 'truncated' },
    { flags: { collapsed: undefined, too_large: undefined }, state: 'truncated' },
  ])('keeps a file with unavailable or unproven patch evidence: %j', async ({ flags, state }) => {
    const stub = transport({ metadata: () => ({ ...metadata, changes_count: '1' }), page: () => ok([file('retained.ts', flags)]) });
    const result = GitlabChangesResultV1Schema.parse(await listGitlabChanges(input, stub.context));
    expect(result).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'retained.ts', evidence: { state } }],
      comparison: { inventory: 'complete', content: 'incomplete' } });
  });

  it.each(['space\tand\nnewline.ts', ' '])('preserves the exact path %j and cannot follow a continuation into another resource', async (path) => {
    const stub = transport({ page: () => ok([file(path)], gitlabNextLinkHeader(
      `${GITLAB_TEST_ORIGIN}/api/v4/projects/other/merge_requests/7/diffs?page=2&per_page=1`)) });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles',
      rows: [{ path }], incomplete: 'pagination', comparison: { inventory: 'incomplete' } });
  });

  it('retains all rows but never calls a capped provider count complete', async () => {
    const stub = transport({ metadata: () => ({ ...metadata, changes_count: '1000+' }), page: () => ok([file('retained.ts')]) });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'retained.ts' }],
      comparison: { totalFileCount: null, inventory: 'incomplete', reasons: expect.arrayContaining(['file_count_unavailable']) } });
  });

  it('lets the shared host keep readable files when a source cannot attest an exact total', async () => {
    const stub = transport({ metadata: () => ({ ...metadata, changes_count: '1000+' }), page: () => ok([file('retained.ts')]) });
    const entry = await getGitlabSourceEntryAction({ v: 1, instance: input.instance, localRef,
      lastKnownLocator: { v: 1, routingToken: repository } }, stub.context);
    if (entry.kind !== 'present' || entry.comparisonSource?.kind !== 'pullRequest') throw new Error('comparison source missing');
    const captured = await readPullRequestComparison({ source: entry.comparisonSource,
      readPage: ({ sourceAction }) => listGitlabChanges(sourceAction.input, stub.context) });
    expect(captured).toMatchObject({ state: 'incomplete', freshness: 'current',
      pullRequest: { title: metadata.title }, files: [{ path: 'retained.ts' }] });
    expect(captured.reasons).toContain('file_count_unavailable');
  });

  it('keeps inventory when patch text cannot cross the Action response envelope', async () => {
    const stub = transport({ metadata: () => ({ ...metadata, changes_count: '1' }), page: () => ok([
      file('retained.ts', { diff: `${patch}${'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES)}` }),
    ]) });
    const result = GitlabChangesResultV1Schema.parse(await listGitlabChanges(input, stub.context));
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(result).toMatchObject({ kind: 'changedFiles', omittedRowCount: 0,
      rows: [{ path: 'retained.ts', evidence: { state: 'unavailable', reason: 'transport_limit' } }],
      comparison: { inventory: 'complete', content: 'incomplete' } });
  });

  it('does not claim clean evidence when the provider stops before the reported file count', async () => {
    const stub = transport({ page: () => ok([file('retained.ts')]) });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles',
      comparison: { inventory: 'incomplete', reasons: expect.arrayContaining(['file_count_mismatch']) } });
  });

  it('refuses an unpopulated or internally inconsistent endpoint tuple', async () => {
    for (const diff_refs of [{}, { ...metadata.diff_refs, head_sha: 'd'.repeat(40) }]) {
      const stub = transport({ metadata: () => ({ ...metadata, diff_refs }) });
      expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'unavailable' });
      expect(stub.requests.some(request => new URL(request.url).pathname.endsWith('/diffs'))).toBe(false);
    }
  });

  it('keeps the existing display Changes contract when evidence was not requested', async () => {
    const stub = transport();
    const { comparison: _comparison, ...displayInput } = input;
    expect(GitlabChangesResultV1Schema.parse(await listGitlabChanges(displayInput, stub.context)))
      .toMatchObject({ kind: 'changes', rows: [{ path: 'first.ts' }] });
    expect(stub.requests.some(request => new URL(request.url).pathname.endsWith('/merge_requests/7'))).toBe(false);
  });

  it('keeps the first page readable when a later page is rate limited', async () => {
    const stub = transport({ page: request => new URL(request.url).searchParams.get('page') === '2'
      ? { status: 429, headers: { 'retry-after': '60' } } : ok([file('first.ts')], gitlabNextLinkHeader(nextUrl)) });
    const first = await listGitlabChanges(input, stub.context);
    if (first.kind !== 'changedFiles') throw new Error('comparison missing');
    expect(await listGitlabChanges({ ...input, continuation: first.continuation }, stub.context)).toMatchObject({
      kind: 'changedFiles', rows: [], comparison: { inventory: 'incomplete', content: 'incomplete', failure: { class: 'rateLimit' } },
    });
  });
});
