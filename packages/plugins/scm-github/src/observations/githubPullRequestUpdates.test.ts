import { describe, expect, it } from 'vitest';
import { ConversationPollResultV1Schema,
  type ConversationResolvedEndpointV1 } from '@happier-dev/channels-protocol/v1';
import { pollGithubIssueCommentsForChannels } from './githubIssueCommentPollRuntime.js';
import { createGithubPullRequestUpdatesFixture as fixture, githubPullRequestUpdatesEndpoint as endpoint,
  githubPullRequestUpdatesAt as at, githubPullRequestUpdatesLater as later, githubPullRequestUpdatesActor as user,
} from './testkit/githubPullRequestUpdates.test-support.js';

describe('native PR updates in the incumbent Channels poll', () => {
  it('carries the source-owned resource intent for a retained PR comment', async () => {
    const f = fixture();
    await f.poll();
    const url = 'https://github.com/acme/widgets/pull/1#issuecomment-50';
    f.state.comments = [{ id: 50, body: 'Feedback', html_url: url, created_at: later, updated_at: later,
      issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user }];
    const rows = await f.poll();
    expect(rows.find(row => row.pullRequestUpdate?.event.kind === 'comment')?.pullRequestUpdate?.event)
      .toMatchObject({ url, resource: { kind: 'pullRequest', url } });
  });
  it('paces PR-only demand from all REST reads without substituting the separate GraphQL points budget', async () => {
    const f = fixture();
    f.input.commentDemand = false;
    f.input.feedbackEndpoints = [];
    f.input.ciEndpoints = [endpoint];
    const result = ConversationPollResultV1Schema.parse(await pollGithubIssueCommentsForChannels({
      ...f.input,
      client: { ...f.input.client, request: async request => {
        const response = await f.input.client.request(request);
        return { ...response, headers: new URL(request.url).pathname === '/graphql'
          ? { 'x-ratelimit-remaining': '999', 'x-ratelimit-reset': String(f.input.nowMs / 1_000 + 600) }
          : { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(f.input.nowMs / 1_000 + 600) } };
      } },
    }));
    expect(result).toMatchObject({ kind: 'checkpointOnly', retryHint: { retryAfterMs: 60_000 },
      pullRequestEndpoints: [{ pullRequestState: { state: 'open', fixResolution: { headRevision: f.state.sha } } }] });
    expect(f.requests).toHaveLength(2); // Stable PR state + real checks query; no comment reads.
  });

  it.each([
    { name: 'fully resolved', summary: {}, mergeable: true, checks: [], resolved: true, incomplete: false },
    { name: 'resolved native thread', summary: { reviewThreads: { nodes: [{ id: 'thread-1', isResolved: true }], pageInfo: { hasPreviousPage: false } } }, mergeable: true, checks: [], resolved: true, incomplete: false },
    { name: 'unresolved native thread', summary: { reviewThreads: { nodes: [{ id: 'thread-1', isResolved: false }], pageInfo: { hasPreviousPage: false } } }, mergeable: true, checks: [], resolved: false, incomplete: false },
    { name: 'changes requested', summary: { reviewDecision: 'CHANGES_REQUESTED' }, mergeable: true, checks: [], resolved: false, incomplete: false },
    { name: 'merge conflict', summary: {}, mergeable: false, checks: [], resolved: false, incomplete: false },
    { name: 'unknown conflict', summary: {}, mergeable: null, checks: [], resolved: false, incomplete: true },
    { name: 'paged threads', summary: { reviewThreads: { nodes: [], pageInfo: { hasPreviousPage: true } } }, mergeable: true, checks: [], resolved: false, incomplete: true },
    { name: 'denied threads', summary: { reviewThreads: null }, mergeable: true, checks: [], resolved: false, incomplete: true },
    { name: 'unknown review decision', summary: { reviewDecision: null }, mergeable: true, checks: [], resolved: false, incomplete: true },
    { name: 'approval and queue waiting', summary: { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', mergeQueueEntry: { id: 'queue-1', state: 'QUEUED', position: 2 } }, mergeable: true, checks: [], resolved: true, incomplete: false },
    { name: 'required pending check', summary: {}, mergeable: true, checks: [{ __typename: 'StatusContext', id: 'pending', context: 'Build', state: 'PENDING', isRequired: true }], resolved: true, incomplete: false },
    { name: 'required failure', summary: {}, mergeable: true, checks: [{ __typename: 'StatusContext', id: 'failed', context: 'Build', state: 'FAILURE', isRequired: true }], resolved: false, incomplete: false },
    { name: 'optional failure', summary: {}, mergeable: true, checks: [{ __typename: 'StatusContext', id: 'optional', context: 'Lint', state: 'FAILURE', isRequired: false }], resolved: true, incomplete: false },
    { name: 'unknown requiredness', summary: {}, mergeable: true, checks: [{ __typename: 'StatusContext', id: 'unknown', context: 'Build', state: 'FAILURE', isRequired: null }], resolved: false, incomplete: true },
    { name: 'unknown required outcome', summary: {}, mergeable: true, checks: [{ __typename: 'StatusContext', id: 'unknown', context: 'Build', state: 'FUTURE_STATE', isRequired: true }], resolved: false, incomplete: true },
    { name: 'superseded head', summary: { headRefOid: 'b'.repeat(40) }, mergeable: true, checks: [], resolved: false, incomplete: true },
    { name: 'empty provider head', summary: { headRefOid: '' }, mergeable: true, checks: [], resolved: false, incomplete: true },
  ])('carries $name resolution through the strict Channels observation with no extra requests', async scenario => {
    const f = fixture(); f.input.ciEndpoints = [endpoint];
    f.state.nativeSummary = scenario.summary; f.state.mergeable = scenario.mergeable; f.state.checks = scenario.checks;
    await f.poll();
    f.requests.length = 0;
    f.state.comments = [{ id: 50, body: 'Current feedback', created_at: later, updated_at: later,
      issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user }];
    const rows = await f.poll(); // Uses the real producer and exact strict poll-result schema.
    const observed = rows.find(row => row.pullRequestUpdate?.event.kind === 'comment')?.endpoint;
    expect(observed).toMatchObject({ pullRequestState: { fixResolution: { headRevision: scenario.name === 'superseded head' ? 'b'.repeat(40) : f.state.sha,
      resolved: scenario.resolved, incomplete: scenario.incomplete } } });
    expect(f.requests.filter(url => new URL(url).pathname === '/graphql')).toHaveLength(1);
    expect(f.requests.filter(url => new URL(url).pathname === '/repositories/77/pulls/1')).toHaveLength(1);
    expect(f.requests.some(url => /\/rules\/|\/threads/u.test(url))).toBe(false);
  });

  it('keeps missing and partial native snapshots incomplete without acquiring another rollup', async () => {
    for (const partial of [false, true]) {
      const f = fixture(); f.input.ciEndpoints = partial ? [endpoint] : [];
      f.state.graphqlErrors = partial ? [{ message: 'Field denied', type: 'FORBIDDEN' }] : [];
      await f.poll(); f.requests.length = 0;
      f.state.comments = [{ id: 50, body: 'Current feedback', created_at: later, updated_at: later,
        issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user }];
      const rows = await f.poll();
      expect(rows[0]?.endpoint).toMatchObject({ pullRequestState: { fixResolution: { headRevision: f.state.sha, resolved: false, incomplete: true } } });
      expect(f.requests.filter(url => new URL(url).pathname === '/graphql')).toHaveLength(partial ? 1 : 0);
    }
  });

  it('advances a thread-only resolution through endpoint snapshots without an event, extra read or equal-poll publication', async () => {
    const f = fixture(); f.input.ciEndpoints = [endpoint];
    f.state.nativeSummary = { reviewThreads: { nodes: [{ id: 'thread-1', isResolved: false }], pageInfo: { hasPreviousPage: false } } };
    f.state.checks = [{ __typename: 'StatusContext', id: 'pending', context: 'Build', state: 'PENDING', isRequired: true }];
    let endpoints: ConversationResolvedEndpointV1[] = [endpoint];
    const poll = async () => {
      const result = await pollGithubIssueCommentsForChannels({ ...f.input, pullRequestEndpoints: endpoints });
      ConversationPollResultV1Schema.parse(result);
      if (result.kind !== 'batch' && result.kind !== 'checkpointOnly') throw new Error('Expected successful native poll');
      f.input.checkpoint = result.checkpointAfterBatch;
      endpoints = [...result.pullRequestEndpoints ?? []];
      expect(result.kind === 'batch' ? result.observations : []).toEqual([]);
      const observed = endpoints[0];
      if (observed?.kind !== 'githubPullRequest') throw new Error('Expected the exact PR endpoint.');
      return observed;
    };
    const baseline = await poll();
    expect(baseline).toMatchObject({ pullRequestState: { fixResolution: { headRevision: f.state.sha, resolved: false, incomplete: false } } });
    let publications = 0;
    for (let index = 0; index < 3; index += 1) {
      const equal = await poll();
      if (equal !== baseline) publications += 1;
      expect(equal?.pullRequestState).toBe(baseline?.pullRequestState);
      expect(equal?.pullRequestState?.fixResolution).toBe(baseline?.pullRequestState?.fixResolution);
    }
    expect(publications).toBe(0);
    f.requests.length = 0;
    f.state.nativeSummary = { reviewThreads: { nodes: [{ id: 'thread-1', isResolved: true }], pageInfo: { hasPreviousPage: false } } };
    const changed = await poll();
    expect(changed).toMatchObject({ pullRequestState: { observedAt: f.input.nowMs,
      fixResolution: { headRevision: f.state.sha, resolved: true, incomplete: false } } });
    expect(changed).not.toBe(baseline);
    expect(changed?.pullRequest).toBe(baseline?.pullRequest);
    expect(changed?.pullRequestState).not.toBe(baseline?.pullRequestState);
    expect(changed?.pullRequestState?.fixResolution).not.toBe(baseline?.pullRequestState?.fixResolution);
    expect(f.requests.filter(url => new URL(url).pathname === '/graphql')).toHaveLength(1);
    expect(f.requests.filter(url => new URL(url).pathname === '/repositories/77/pulls/1')).toHaveLength(1);
    expect(await poll()).toBe(changed);
    f.input.ciEndpoints = []; f.input.feedbackEndpoints = []; f.input.commentDemand = false;
    f.requests.length = 0;
    const off = await poll();
    expect(off?.pullRequestState).not.toHaveProperty('fixResolution');
    expect(f.requests.some(url => /\/graphql|\/reviews|\/events|\/pulls\/comments/u.test(url))).toBe(false);
    expect(await poll()).toBe(off);
  });

  it('keeps an open native baseline nonterminal', async () => {
    const f = fixture();
    const result = ConversationPollResultV1Schema.parse(await pollGithubIssueCommentsForChannels(f.input));
    expect(result).toMatchObject({ kind: 'checkpointOnly', pullRequestEndpoints: [{ pullRequestState: { state: 'open' } }] });
  });

  it('retains every native review revision beyond the former 48 KiB checkpoint policy cap', async () => {
    const f = fixture(); await f.poll();
    f.state.reviews = Array.from({ length: Math.ceil(48 * 1024 / 40) }, (_, index) => ({ id: index + 1, body: `review ${index}`, state: 'COMMENTED', submitted_at: later, user }));
    const deliveredIds: string[] = [];
    for (let page = 0; page < Math.ceil(f.state.reviews.length / f.input.limit); page += 1) {
      deliveredIds.push(...(await f.poll()).flatMap(row => row.pullRequestUpdate?.event.kind === 'review' ? [row.pullRequestUpdate.event.id] : []));
    }
    expect(deliveredIds).toEqual(f.state.reviews.map((_, index) => String(index + 1)));
    if (f.input.checkpoint === null || typeof f.input.checkpoint !== 'object') throw new Error('Expected the admitted checkpoint');
    expect(new TextEncoder().encode(JSON.stringify(f.input.checkpoint)).byteLength).toBeGreaterThan(48 * 1024);
    expect(await f.poll()).toEqual([]);
  });

  it('preserves an empty review verdict body while emitting a valid nonempty message', async () => {
    const f = fixture(); await f.poll();
    f.state.reviews = [{ id: 1, body: '', state: 'APPROVED', submitted_at: later, user }];
    const rows = await f.poll();
    expect(rows[0]?.pullRequestUpdate?.event).toMatchObject({ kind: 'review', verdict: 'approved', body: '' });
    expect(rows[0]?.message.text.length).toBeGreaterThan(0);
  });

  it('retires native checkpoint state when the exact PR no longer has subscriber demand', async () => {
    const f = fixture(); await f.poll();
    f.input.pullRequestEndpoints = []; f.input.feedbackEndpoints = []; f.input.commentDemand = false;
    const result = await pollGithubIssueCommentsForChannels(f.input);
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('Expected the remaining connection checkpoint');
    expect(result.checkpointAfterBatch).not.toHaveProperty('pullRequestUpdates');
  });
  it.each(['fork-owner/widgets', null])('preserves measured head repository %s without substituting the base repository', async fullName => {
    const f = fixture(); f.state.headRepositoryFullName = fullName; f.state.headRepositoryId = 88; await f.poll();
    f.state.inline = [{ id: 21, body: 'Fork feedback', created_at: later, updated_at: later, pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/1', path: 'src/file.ts', line: 1, diff_hunk: 'diff', user }];
    const head = (await f.poll())[0]?.pullRequestUpdate?.head;
    if (fullName === null) expect(head).not.toHaveProperty('repository');
    else expect(head).toMatchObject({ repository: { kind: 'github', deployment: 'https://github.com', repository: fullName } });
  });
  it('baselines feedback, preserves equal-time inline bodies and review membership beyond the poll limit, and replays no events', async () => {
    const f = fixture();
    f.state.reviews = [{ id: 1, body: 'historical', state: 'APPROVED', submitted_at: at, user }];
    expect(await f.poll()).toEqual([]);
    f.state.inline = [2, 3].map(id => ({ id, body: `full body ${id} <!-- happier-review:test -->`, created_at: later, updated_at: later, pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/1', pull_request_review_id: 4, path: 'src/file.ts', line: id, diff_hunk: '@@ -1 +1 @@\n+change', user }));
    f.state.reviews.push({ id: 4, body: 'Please address both', state: 'CHANGES_REQUESTED', submitted_at: later, user });
    f.input.limit = 1;
    const first = await f.poll();
    expect(f.requests.filter(url => /\/reviews\/4\/comments/u.test(url))).toHaveLength(0);
    const second = await f.poll();
    const third = await f.poll();
    const events = [...first, ...second, ...third].map(row => row.pullRequestUpdate?.event);
    expect(events.map(event => event?.kind)).toEqual(['inlineComment', 'inlineComment', 'review']);
    expect(events[0]).toMatchObject({ body: 'full body 2 <!-- happier-review:test -->', reviewId: '4', path: 'src/file.ts', line: 2, diffHunk: '@@ -1 +1 @@\n+change' });
    expect(events[2]).toMatchObject({ body: 'Please address both', verdict: 'changesRequested', inlineCommentIds: ['2', '3'] });
    expect(first[0]?.actor).toMatchObject({ principalId: '99', isIntegrationSelf: true, repositoryWriteAccess: true });
    expect(await f.poll()).toEqual([]);
  });

  it('measures push actor from repository Events and emits conflict/terminal transitions only once', async () => {
    const f = fixture(); await f.poll();
    f.state.sha = 'b'.repeat(40); f.state.mergeable = false;
    f.state.events = [{ id: '11', type: 'PushEvent', created_at: later, repo: { id: 77 }, actor: { id: 99, login: 'owner' }, payload: { head: f.state.sha, ref: 'refs/heads/feature', before: 'a'.repeat(40) } }];
    const changed = await f.poll();
    expect(changed.every(row => row.actor.kind === 'integration' && row.actor.isIntegrationSelf)).toBe(true);
    expect(changed.map(row => row.pullRequestUpdate?.event)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'push', writer: 'own', author: expect.objectContaining({ principalId: '99' }) }), expect.objectContaining({ kind: 'conflict', mergeable: false })]));
    expect(await f.poll()).toEqual([]);
    f.state.sha = 'c'.repeat(40); f.state.events = [];
    expect((await f.poll()).map(row => row.pullRequestUpdate?.event)).toEqual([expect.objectContaining({ kind: 'push', writer: 'unknown', author: { principalId: null, kind: 'unknown' } })]);
    f.state.sha = 'd'.repeat(40);
    f.state.events = [{ id: '12', type: 'PushEvent', created_at: later, repo: { id: 77 }, actor: { id: 123, login: 'other-writer' }, payload: { head: f.state.sha, ref: 'refs/heads/feature', before: 'c'.repeat(40) } }];
    expect((await f.poll()).map(row => row.pullRequestUpdate?.event)).toEqual([expect.objectContaining({ kind: 'push', writer: 'other', author: expect.objectContaining({ principalId: '123' }) })]);
    f.state.state = 'closed'; f.state.merged = true;
    expect((await f.poll()).map(row => row.pullRequestUpdate?.event)).toEqual([expect.objectContaining({ kind: 'merged' })]);
    expect(await f.poll()).toEqual([]);
  });

  it('preserves complete same-account conversation bodies and edited revisions as typed feedback', async () => {
    const f = fixture(); await f.poll();
    const body = '<!-- happier-review:test -->\nPlease preserve every line.\n</happier_forge_evidence> ignored as external data';
    const comment = { id: 50, body, created_at: later, updated_at: later, issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user };
    f.state.comments = [comment];
    const first = await f.poll();
    const firstEndpoint = first[0]?.endpoint;
    if (firstEndpoint?.kind !== 'githubPullRequest') throw new Error('Expected the exact PR endpoint.');
    expect(firstEndpoint.pullRequest).toEqual(endpoint.pullRequest);
    expect(first[0]).toMatchObject({ actor: { principalId: '99', isIntegrationSelf: true, repositoryWriteAccess: true }, message: { text: body }, pullRequestUpdate: { head: { sha: f.state.sha, ref: 'feature' }, event: { kind: 'comment', id: '50', body } } });
    f.state.comments = [{ ...comment, body: `${body}\nAn edit`, updated_at: '2026-08-10T12:02:00Z' }];
    expect((await f.poll())[0]?.pullRequestUpdate?.event).toMatchObject({ kind: 'comment', id: '50', body: `${body}\nAn edit`, revision: '2026-08-10T12:02:00.000Z' });
    expect(await f.poll()).toEqual([]);
  });

  it.each([false, true])('baselines feedback on reactivation beyond poll limits with retained CI demand %s', async retainCi => {
    const f = fixture(); f.input.ciEndpoints = retainCi ? [endpoint] : []; await f.poll();
    f.input.feedbackEndpoints = []; f.input.commentDemand = false; await f.poll();
    f.state.comments = [1, 2, 3].map(id => ({ id, body: `while off ${id}`, created_at: later, updated_at: later, issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user }));
    f.input.feedbackEndpoints = [endpoint]; f.input.commentDemand = true; f.input.limit = 1;
    expect(await f.poll()).toEqual([]);
    expect(await f.poll()).toEqual([]);
    expect(await f.poll()).toEqual([]);
    f.state.comments.push({ id: 4, body: 'after activation', created_at: later, updated_at: later, issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user });
    expect((await f.poll())[0]?.pullRequestUpdate?.event).toMatchObject({ kind: 'comment', id: '4', body: 'after activation' });
  });

  it('retains exact state refresh for Off without feedback, Events, checks or log demand', async () => {
    const f = fixture(); f.input.feedbackEndpoints = []; f.input.commentDemand = false; await f.poll();
    expect(f.requests.some(url => /\/issues\/comments|\/pulls\/comments|\/reviews|\/events|\/graphql|\/logs/u.test(url))).toBe(false);
    expect(f.requests.some(url => url.endsWith('/pulls/1'))).toBe(true);
  });

  it('requeries completed timestamp groups when editing an earlier inline row shifts provider pages', async () => {
    const f = fixture(); await f.poll();
    const comments = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, body: `inline ${index + 1}`, created_at: later,
      updated_at: `2026-08-10T12:01:${String((index + 1) * 2).padStart(2, '0')}Z`, pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/1', path: 'src/file.ts', line: 1, diff_hunk: 'diff', user }));
    f.state.inline = comments; f.state.inlinePageSize = 4;
    f.state.afterInlinePage = () => { comments[0]!.updated_at = '2026-08-10T12:01:30Z'; f.state.afterInlinePage = null; };
    const events = (await f.poll()).map(row => row.pullRequestUpdate?.event);
    expect(new Set(events.map(event => event?.id))).toEqual(new Set(comments.map(comment => String(comment.id))));
    expect(await f.poll()).toEqual([]);
  });

  it('traverses equal-time inline feedback through native pages and dedupes the next poll', async () => {
    const f = fixture(); await f.poll();
    f.state.inline = [1, 2].map(id => ({ id, body: 'same timestamp', created_at: later, updated_at: later, pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/1', path: 'src/file.ts', line: 1, diff_hunk: 'diff', user }));
    f.state.inlinePageSize = 1;
    const events = (await f.poll()).map(row => row.pullRequestUpdate?.event);
    expect(events.map(event => event?.id)).toEqual(['1', '2']);
    expect(f.requests.filter(url => new URL(url).pathname.endsWith('/pulls/comments')
      && new URL(url).searchParams.get('page') === '2')).toHaveLength(1);
    expect(await f.poll()).toEqual([]);
  });

  it('emits each native check transition with exact plan-02 failure evidence and acquires no unchanged logs', async () => {
    const f = fixture(); f.input.ciEndpoints = [endpoint]; await f.poll();
    const check = { __typename: 'CheckRun', id: 'check-node-1', databaseId: 101, name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/81', startedAt: at, completedAt: later, isRequired: false,
      checkSuite: { createdAt: at, app: { slug: 'github-actions' }, commit: { oid: f.state.sha }, repository: { nameWithOwner: 'acme/widgets' }, workflowRun: { databaseId: 81, runAttempt: 2 } } };
    f.state.checks = [check];
    const failed = await f.poll();
    const event = failed[0]?.pullRequestUpdate?.event;
    expect(event).toMatchObject({ kind: 'check', state: 'failed', resource: { kind: 'ciRun', url: check.detailsUrl }, logicalCheckId: 'github-check-run:check-node-1', failure: { kind: 'summary', summary: { headSha: f.state.sha,
      selection: { kind: 'attempt', attempt: { run: { runId: '81' }, attemptId: '2' } }, jobs: [{ job: { jobId: '91' }, steps: [{ name: 'Run test' }] }],
    } } });
    expect(event?.kind === 'check' && event.state === 'failed' && event.failure.kind === 'summary' ? event.failure.summary.excerpts.map(excerpt => excerpt.text).join('') : '').toContain('assertion failed');
    const logReads = f.requests.filter(url => url.endsWith('/logs')).length;
    expect(logReads).toBe(1);
    expect(await f.poll()).toEqual([]);
    expect(f.requests.filter(url => url.endsWith('/logs'))).toHaveLength(logReads);
    f.state.checks = [{ ...check, conclusion: 'SUCCESS' }];
    f.state.nativeSummary = { reviewThreads: { nodes: [{ id: 'thread-1', isResolved: false }], pageInfo: { hasPreviousPage: false } } };
    const passed = await f.poll();
    expect(passed.map(row => row.pullRequestUpdate?.event)).toEqual([expect.objectContaining({ kind: 'check', state: 'passed' })]);
    expect(passed[0]?.endpoint).toMatchObject({ pullRequestState: { fixResolution: { headRevision: f.state.sha, resolved: false, incomplete: false } } });
    expect(await f.poll()).toEqual([]);
    f.state.checks = [{ ...check, conclusion: 'CANCELLED' }];
    expect((await f.poll()).map(row => row.pullRequestUpdate?.event)).toEqual([expect.objectContaining({ kind: 'check', state: 'finished' })]);
  });
});
