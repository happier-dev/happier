import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  createStubGitlabTransport,
  gitlabTestConfiguredInstance,
  GITLAB_TEST_COLLISION_SCOPE,
  type RecordedGitlabRequest,
  type StubGitlabResponse,
} from '../testkit/gitlabTriage.test-support.js';
import {
  publishGitlabIssueComment,
  publishGitlabMergeRequestReview,
  publishGitlabMergeRequestReviewComment,
  publishGitlabMergeRequestThreadReply,
} from './operations.js';

const ROUTING_TOKEN = 'group/project';
const ITEM_URL = `https://gitlab.com/api/v4/projects/${encodeURIComponent(ROUTING_TOKEN)}/merge_requests/7`;
const DRAFTS_URL = `${ITEM_URL}/draft_notes`;
const DRAFTS_LIST_URL = `${DRAFTS_URL}?per_page=100`;
const NOTES_LIST_URL = `${ITEM_URL}/notes?per_page=100`;
const DISCUSSIONS_URL = `${ITEM_URL}/discussions`;
const DISCUSSIONS_LIST_URL = `${DISCUSSIONS_URL}?per_page=100`;
const ISSUE_URL = `https://gitlab.com/api/v4/projects/${encodeURIComponent(ROUTING_TOKEN)}/issues/7`;
const ISSUE_NOTES_URL = `${ISSUE_URL}/notes`;
const ISSUE_NOTES_LIST_URL = `${ISSUE_NOTES_URL}?per_page=100`;
const OBSERVED_HEAD = 'a'.repeat(40);
const OBSERVED_BASE = 'b'.repeat(40);
const OBSERVED_START = 'c'.repeat(40);
const ENTRY_CORRELATION = 'E'.repeat(43);
const VERDICT_CORRELATION = 'V'.repeat(43);
const SUMMARY_ENTRY_CORRELATION = 'S'.repeat(43);
const PLAN_ID = 'P'.repeat(43);

const LOCAL_REF = Object.freeze({
  kindId: 'merge-request',
  entryId: '7',
  collisionScope: GITLAB_TEST_COLLISION_SCOPE,
});

function mergeRequestBody(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    iid: 7,
    project_id: 3,
    state: 'opened',
    draft: false,
    sha: OBSERVED_HEAD,
    updated_at: '2026-08-28T08:00:00.000Z',
    references: { full: 'group/project!7' },
    diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD, start_sha: OBSERVED_START },
    ...overrides,
  };
}

function issueBody(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    iid: 7,
    project_id: 3,
    state: 'opened',
    updated_at: '2026-08-28T08:00:00.000Z',
    references: { full: 'group/project#7' },
    ...overrides,
  };
}

function plan(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    target: {
      providerId: 'gitlab',
      configuredAccountId: 'account-under-test',
      entryRef: {
        sourceId: 'happier.scm.forge.gitlab/gitlab-forge',
        kindId: 'merge-request',
        collisionScope: GITLAB_TEST_COLLISION_SCOPE,
        entryId: '7',
      },
      subtarget: null,
    },
    baseRevision: OBSERVED_BASE,
    headRevision: OBSERVED_HEAD,
    entries: [{
      happierCommentId: 'comment-1',
      expectedServerRevision: 1,
      anchor: { kind: 'line', filePath: 'src/index.ts', line: 12, side: 'after' },
      snapshot: {
        kind: 'text',
        selectedLines: ['const answer = 42;'],
        beforeContext: [],
        afterContext: [],
        selectedLinesHash: 'selected',
        contextWindowHash: 'context',
        capturedAt: 1,
        fileLength: 20,
        source: 'committed',
        isUncommitted: false,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
        diffContext: {
          side: 'after',
          baseSha: OBSERVED_BASE,
          headSha: OBSERVED_HEAD,
          startSha: OBSERVED_START,
        },
        commitSha: OBSERVED_HEAD,
      },
      body: 'Please explain this constant.',
    }],
    verdict: { kind: 'approve', body: 'Ready.' },
    ...overrides,
  };
}

function actionInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    localRef: LOCAL_REF,
    routingToken: ROUTING_TOKEN,
    publicationPlan: plan(),
    ...overrides,
  };
}

function createTransport(
  respond: (request: RecordedGitlabRequest) => StubGitlabResponse | undefined,
  options: Readonly<{ claimError?: Error; settlementError?: Error }> = {},
) {
  let claimCount = 0;
  const settlements: unknown[] = [];
  const transport = createStubGitlabTransport({ respond });
  (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
    async execute(actionId: string, actionInput: unknown) {
      expect(actionId).toBe('reviews.comments.claimPublicationDispatch');
      claimCount += 1;
      if (typeof actionInput === 'object' && actionInput !== null && 'settlement' in actionInput) {
        settlements.push(actionInput.settlement);
      }
      if (options.settlementError !== undefined
        && typeof actionInput === 'object'
        && actionInput !== null
        && 'settlement' in actionInput
        && actionInput.settlement !== undefined) {
        throw options.settlementError;
      }
      if (options.claimError !== undefined) throw options.claimError;
      const hasVerdict = typeof actionInput === 'object'
        && actionInput !== null
        && 'verdict' in actionInput
        && actionInput.verdict !== null;
      return {
        disposition: 'dispatch',
        dispatchToken: 'dispatch-token-1',
        publicationPlanId: PLAN_ID,
        entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION }],
        verdict: hasVerdict ? { publicationCorrelationId: VERDICT_CORRELATION } : null,
        instructions: { entries: ['dispatch'], verdict: hasVerdict ? 'dispatch' : null },
        priorResult: null,
      };
    },
  };
  return { ...transport, claimCount: () => claimCount, settlements };
}

function bodyOf(request: RecordedGitlabRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

function discussion(id: number, body: string, individualNote = false) {
  return {
    id: `thread-${id}`,
    individual_note: individualNote,
    notes: [{ id, body, type: individualNote ? null : 'DiscussionNote' }],
  };
}

describe('gitlab/merge-request/submit-review', () => {
  it.each(['claim', 'settlement'] as const)('retains typed %s failure identity beside publication truth', async (phase) => {
    const error = new PluginError({ code: 'review_claim_denied', retryable: false, details: { requestId: 'request-gitlab-publication' } });
    const transport = phase === 'settlement' ? settlementFailureTransport(error) : createTransport((request) => {
      if (request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      return undefined;
    }, { claimError: error });
    const publication = publishGitlabMergeRequestReview(actionInput({ publicationPlan: plan({ verdict: null }) }), transport.context);
    if (phase === 'claim') {
      await expect(publication).rejects.toMatchObject({ code: error.code, details: { requestId: 'request-gitlab-publication' } });
      return;
    }
    const result = await publication;
    expect(result).toMatchObject({ kind: 'settled', failure: { code: error.code, requestId: 'request-gitlab-publication' } });
    if (phase === 'settlement') expect(result).toMatchObject({ publication: { entries: [{ outcome: { kind: 'published', externalRef: '91' } }] } });
    expect(transport.requests.at(-1)).toMatchObject({ method: 'GET', url: ITEM_URL });
  });

  it.each([
    { verdict: 'approve', losePublishAnswer: false, verdictResult: 'published' },
    { verdict: 'approve', losePublishAnswer: true, verdictResult: 'published' },
    { verdict: 'requestChanges', losePublishAnswer: false, verdictResult: 'published' },
    { verdict: 'requestChanges', losePublishAnswer: false, verdictResult: 'failed' },
    { verdict: 'requestChanges', losePublishAnswer: false, verdictResult: 'uncertain' },
  ] as const)('confirms inline DiscussionNotes and submits $verdict last ($verdictResult, lost publish answer: $losePublishAnswer)', async ({ verdict, losePublishAnswer, verdictResult }) => {
    let draftCreates = 0;
    const pending = new Map<number, Record<string, unknown>>();
    const published: Array<{ id: number; body: string; type: 'DiscussionNote' | null }> = [];
    const transport = createTransport((request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      // GitLab Discussions API, "Understand note types in the API":
      // DiscussionNotes are excluded from Notes, but Discussions includes both.
      if (request.method === 'GET' && request.url === NOTES_LIST_URL) {
        return { status: 200, body: published.filter((note) => note.type === null) };
      }
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
        return { status: 200, body: published.map((note) => ({
          id: `thread-${note.id}`, individual_note: note.type === null, notes: [note],
        })) };
      }
      if (request.method === 'POST' && request.url === DRAFTS_URL) {
        draftCreates += 1;
        const id = 80 + draftCreates;
        pending.set(id, bodyOf(request));
        return { status: 201, body: { id } };
      }
      if (request.method === 'PUT' && request.url.startsWith(`${DRAFTS_URL}/`)) {
        const id = Number(request.url.split('/').at(-2));
        const draft = pending.get(id)!;
        pending.delete(id);
        published.push({ id: id + 10, body: String(draft.note), type: draft.position ? 'DiscussionNote' : null });
        if (losePublishAnswer && draft.position) throw new Error('simulated publish response loss');
        return { status: 204, bodyText: '' };
      }
      if (request.method === 'POST' && request.url === `${ITEM_URL}/approve`) return { status: 201, body: { approved: true } };
      if (request.method === 'POST' && request.url === 'https://gitlab.com/api/graphql') {
        expect(bodyOf(request)).toMatchObject({ variables: { projectPath: ROUTING_TOKEN, iid: '7' } });
        expect(bodyOf(request).query).toEqual(expect.stringContaining('mergeRequestRequestChanges'));
        if (verdictResult === 'failed') return { status: 200, body: { data: { mergeRequestRequestChanges: { errors: ['Cannot request changes'], mergeRequest: null } } } };
        if (verdictResult === 'uncertain') return { status: 200, body: { data: { mergeRequestRequestChanges: { errors: [], mergeRequest: null } } } };
        return { status: 200, body: { data: { mergeRequestRequestChanges: { errors: [], mergeRequest: { id: 'gid://gitlab/MergeRequest/7' } } } } };
      }
      return undefined;
    });

    const result = await publishGitlabMergeRequestReview(actionInput({ publicationPlan: plan({ verdict: { kind: verdict, body: 'Ready.' } }) }), transport.context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        publicationPlanId: PLAN_ID,
        entries: [{ outcome: { kind: 'published', externalRef: '91' } }],
        verdict: { outcome: { kind: verdictResult, externalRef: '92' } },
      },
    });
    expect(transport.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${ITEM_URL}`,
      `GET ${DRAFTS_LIST_URL}`,
      `GET ${DISCUSSIONS_LIST_URL}`,
      `POST ${DRAFTS_URL}`,
      `PUT ${DRAFTS_URL}/81/publish`,
      `GET ${DISCUSSIONS_LIST_URL}`,
      `POST ${DRAFTS_URL}`,
      `PUT ${DRAFTS_URL}/82/publish`,
      `GET ${NOTES_LIST_URL}`,
      verdict === 'approve' ? `POST ${ITEM_URL}/approve` : 'POST https://gitlab.com/api/graphql',
      `GET ${ITEM_URL}`,
    ]);
    expect(transport.claimCount()).toBe(2);
    expect(published).toHaveLength(2);
    expect(bodyOf(transport.requests[3])).toMatchObject({
      note: `Please explain this constant.\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`,
      position: {
        base_sha: OBSERVED_BASE,
        head_sha: OBSERVED_HEAD,
        start_sha: OBSERVED_START,
        position_type: 'text',
        old_path: 'src/index.ts',
        new_path: 'src/index.ts',
        new_line: 12,
      },
    });
    expect(transport.requests.some((request) => request.url.includes('bulk_publish'))).toBe(false);
  });

  it('reports every preexisting draft before claim', async () => {
    const drafts = createTransport((request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) {
        return { status: 200, body: [{ id: 31, note: 'Human draft' }, { id: 32, note: 'Older Happier draft\n\n<!-- happier-review-comment:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -->' }] };
      }
      return undefined;
    });
    const first = await publishGitlabMergeRequestReview(actionInput(), drafts.context);
    expect(first).toMatchObject({
      kind: 'rejected', reason: 'preexisting_drafts', preexistingDraftCount: 2,
      preexistingDraftIds: ['31', '32'],
    });
    expect(drafts.claimCount()).toBe(0);
    expect(drafts.requests.some((request) => request.method !== 'GET')).toBe(false);
  });

  it('reconciles an inline entry and ordinary summary across discussion pages without any provider write', async () => {
    const nextUrl = `${DISCUSSIONS_LIST_URL}&page=2`;
    const summaryBody = `Ready.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`;
    const transport = createStubGitlabTransport({ respond(request) {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'GET' && request.url === NOTES_LIST_URL) {
        return { status: 200, body: [{ id: 92, body: summaryBody }] };
      }
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
        return { status: 200, body: [discussion(90, 'Unrelated discussion')], headers: { Link: `<${nextUrl}>; rel="next"` } };
      }
      if (request.method === 'GET' && request.url === nextUrl) {
        return { status: 200, body: [
          discussion(91, `Entry\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`),
          discussion(92, summaryBody, true),
        ] };
      }
      return undefined;
    } });
    Object.assign(transport.context.services, { actions: { async execute() {
      return {
        disposition: 'reconcile', dispatchToken: null, publicationPlanId: PLAN_ID,
        entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION }],
        verdict: { publicationCorrelationId: VERDICT_CORRELATION },
        instructions: { entries: ['reconcile'], verdict: 'reconcile' }, priorResult: null,
      };
    } } });
    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ verdict: { kind: 'comment', body: 'Ready.' } }),
    }), transport.context);
    expect(result).toMatchObject({ kind: 'settled', publication: {
      entries: [{ outcome: { kind: 'published', externalRef: '91' } }],
      verdict: { outcome: { kind: 'published', externalRef: '92' } },
    } });
    expect(transport.requests.some((request) => request.method !== 'GET')).toBe(false);
    expect(transport.requests.some((request) => request.url === nextUrl)).toBe(true);
  });

  it('folds a diff-less entry into the explicit verdict summary without losing cardinality', async () => {
    let inlinePublished = false;
    let summaryPublished = false;
    let draftCreates = 0;
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'GET' && request.url === NOTES_LIST_URL) {
        return { status: 200, body: summaryPublished ? [{
            id: 92,
            body: `Repository-level finding\n\n<!-- happier-review-comment:v1:${SUMMARY_ENTRY_CORRELATION} -->\n\nReady.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
          }] : [] };
      }
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
        return { status: 200, body: inlinePublished ? [discussion(91, `Inline\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`)] : [] };
      }
      if (request.method === 'POST' && request.url === DRAFTS_URL) {
        draftCreates += 1;
        return { status: 201, body: { id: draftCreates === 1 ? 81 : 82 } };
      }
      if (request.method === 'PUT' && request.url.startsWith(`${DRAFTS_URL}/`)) {
        if (request.url === `${DRAFTS_URL}/81/publish`) inlinePublished = true;
        else summaryPublished = true;
        return { status: 204, bodyText: '' };
      }
      if (request.method === 'POST' && request.url === `${ITEM_URL}/approve`) return { status: 201, body: {} };
      return undefined;
    } });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'dispatch', publicationPlanId: PLAN_ID,
          dispatchToken: 'dispatch-token-1',
          entries: [
            { happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION },
            { happierCommentId: 'comment-2', publicationCorrelationId: SUMMARY_ENTRY_CORRELATION },
          ],
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: ['dispatch', 'dispatch'], verdict: 'dispatch' },
          priorResult: null,
        };
      },
    };
    const diffLess = {
      ...plan().entries[0],
      happierCommentId: 'comment-2',
      anchor: { kind: 'finding', runId: 'run-1', findingId: 'finding-1' },
      body: 'Repository-level finding',
    };
    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: [plan().entries[0], diffLess] }),
    }), transport.context);
    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [
          { outcome: { kind: 'published', externalRef: '91' } },
          { outcome: { kind: 'published', externalRef: '92' } },
        ],
        verdict: { outcome: { kind: 'published', externalRef: '92' } },
      },
    });
    const summaryWrite = transport.requests.filter((request) => request.method === 'POST' && request.url === DRAFTS_URL)[1];
    expect(bodyOf(summaryWrite).note).toContain(`<!-- happier-review-comment:v1:${SUMMARY_ENTRY_CORRELATION} -->`);
    expect(bodyOf(summaryWrite).note).toContain(`<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`);
  });

  it('rejects a diff-less entry with no explicit verdict before claim or provider write', async () => {
    const transport = createTransport((request) => request.method === 'GET' && request.url === ITEM_URL
      ? { status: 200, body: mergeRequestBody() }
      : undefined);
    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({
        entries: [{
          ...plan().entries[0],
          anchor: { kind: 'finding', runId: 'run-1', findingId: 'finding-1' },
        }],
        verdict: null,
      }),
    }), transport.context);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'unsupported_anchor' });
    expect(transport.claimCount()).toBe(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('paginates every preexisting draft before refusing publication', async () => {
    const secondPage = `${DRAFTS_URL}?page=2&per_page=100`;
    const transport = createTransport((request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) {
        return {
          status: 200,
          headers: { Link: `<${secondPage}>; rel="next"` },
          body: [{ id: 31, note: 'First page' }],
        };
      }
      if (request.method === 'GET' && request.url === secondPage) {
        return { status: 200, body: [{ id: 32, note: 'Second page' }] };
      }
      return undefined;
    });
    const result = await publishGitlabMergeRequestReview(actionInput(), transport.context);
    expect(result).toMatchObject({
      kind: 'rejected', reason: 'preexisting_drafts', preexistingDraftCount: 2,
      preexistingDraftIds: ['31', '32'],
    });
    expect(transport.claimCount()).toBe(0);
  });

  it('reconciles an undecodable successful create by exact marker without retrying the POST', async () => {
    let draftReads = 0;
    let notesReads = 0;
    let createCount = 0;
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) {
        draftReads += 1;
        return { status: 200, body: draftReads === 1 ? [] : [{
          id: 81, note: `Created\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`,
        }] };
      }
      if (request.method === 'GET' && request.url === NOTES_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
        notesReads += 1;
        return { status: 200, body: notesReads === 1 ? [] : [
          discussion(91, `Published\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`),
          ...(notesReads >= 3 ? [discussion(92, `Second\n\n<!-- happier-review-comment:v1:${SUMMARY_ENTRY_CORRELATION} -->`)] : []),
        ] };
      }
      if (request.method === 'POST' && request.url === DRAFTS_URL) {
        createCount += 1;
        return createCount === 1 ? { status: 201 } : { status: 201, body: { id: 82 } };
      }
      if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/81/publish`) {
        throw new Error('simulated publish response loss');
      }
      if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/82/publish`) return { status: 200, body: {} };
      return undefined;
    } });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'dispatch', publicationPlanId: PLAN_ID,
          dispatchToken: 'dispatch-token-1',
          entries: [
            { happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION },
            { happierCommentId: 'comment-2', publicationCorrelationId: SUMMARY_ENTRY_CORRELATION },
          ],
          verdict: null,
          instructions: { entries: ['dispatch', 'dispatch'], verdict: null },
          priorResult: null,
        };
      },
    };
    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({
        entries: [
          plan().entries[0],
          { ...plan().entries[0], happierCommentId: 'comment-2', body: 'Second' },
        ],
        verdict: null,
      }),
    }), transport.context);
    expect(result).toMatchObject({ kind: 'settled', publication: { entries: [
      { outcome: { kind: 'published', externalRef: '91' } },
      { outcome: { kind: 'published', externalRef: '92' } },
    ] } });
    expect(transport.requests.filter((request) => request.method === 'POST' && request.url === DRAFTS_URL)).toHaveLength(2);
    expect(transport.requests.filter((request) => request.method === 'PUT' && request.url === `${DRAFTS_URL}/81/publish`)).toHaveLength(1);
  });

  it('stops with uncertain and skips the verdict when a lost publish answer has no marker', async () => {
    const transport = createTransport((request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'POST' && request.url === DRAFTS_URL) return { status: 201, body: { id: 81 } };
      if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/81/publish`) {
        throw new Error('simulated publish response loss');
      }
      return undefined;
    });
    const result = await publishGitlabMergeRequestReview(actionInput(), transport.context);
    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [{ outcome: { kind: 'uncertain' } }],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(transport.requests.some((request) => request.url.endsWith('/approve'))).toBe(false);
  });

  it.each([
    ['unsupported anchor', {
      ...plan().entries[0],
      anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'h1' },
    }],
    ['stale diff snapshot', {
      ...plan().entries[0],
      snapshot: {
        ...plan().entries[0]!.snapshot,
        diffContext: { ...plan().entries[0]!.snapshot.diffContext, baseSha: 'd'.repeat(40) },
      },
    }],
  ])('retains a confirmed publication with an %s without another provider write', async (_label, entry) => {
    const priorResult = {
      publicationPlanId: PLAN_ID,
      entries: [{
        happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION,
        outcome: { kind: 'published', externalRef: '91' },
      }],
      verdict: { kind: 'notRequested' },
    };
    const settlements: unknown[] = [];
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && [DRAFTS_LIST_URL, DISCUSSIONS_LIST_URL].includes(request.url)) {
        return { status: 200, body: [] };
      }
      return undefined;
    } });
    // The host Actions service owns the persisted publication claim outside this plugin process.
    Object.assign(transport.context.services, { actions: { async execute(_actionId: string, input: unknown) {
      if (typeof input === 'object' && input !== null && 'settlement' in input) settlements.push(input.settlement);
      return {
        disposition: 'reconcile', dispatchToken: null, publicationPlanId: PLAN_ID,
        entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION }],
        verdict: null, instructions: { entries: ['confirmed'], verdict: null }, priorResult,
      };
    } } });

    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: [entry], verdict: null }),
    }), transport.context);

    expect(result).toMatchObject({ kind: 'settled', publication: priorResult });
    expect(settlements).toContainEqual({ dispatchToken: null, result: priorResult });
    expect(transport.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it.each([
    [false, { kind: 'uncertain' }],
    [true, { kind: 'published', externalRef: '91' }],
  ])('reconciles a reused entry while dispatching only the new verdict (marker found: %s)', async (markerFound, entryOutcome) => {
    let summaryPublished = false;
    const settlements: unknown[] = [];
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: markerFound
        ? [discussion(91, `Existing\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`)] : [] };
      if (request.method === 'POST' && request.url === DRAFTS_URL) return { status: 201, body: { id: 82 } };
      if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/82/publish`) {
        summaryPublished = true;
        return { status: 204, bodyText: '' };
      }
      if (request.method === 'GET' && request.url === NOTES_LIST_URL) return { status: 200, body: summaryPublished
        ? [{ id: 92, body: `Ready.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->` }] : [] };
      return undefined;
    } });
    Object.assign(transport.context.services, { actions: { async execute(_actionId: string, input: unknown) {
      if (typeof input === 'object' && input !== null && 'settlement' in input) settlements.push(input.settlement);
      // The store lends a prior Review's published entry to a new verdict with this mixed instruction shape.
      return { disposition: 'dispatch', dispatchToken: 'dispatch-token-1', publicationPlanId: PLAN_ID,
        entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION }],
        verdict: { publicationCorrelationId: VERDICT_CORRELATION },
        instructions: { entries: ['reconcile'], verdict: 'dispatch' }, priorResult: null };
    } } });

    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ verdict: { kind: 'comment', body: 'Ready.' } }),
    }), transport.context);

    expect(result).toMatchObject({ kind: 'settled', publication: {
      entries: [{ outcome: entryOutcome }], verdict: { outcome: { kind: 'published', externalRef: '92' } },
    } });
    expect(settlements).toContainEqual(expect.objectContaining({ result: expect.objectContaining({
      entries: [expect.objectContaining({ outcome: entryOutcome })],
    }) }));
    const writes = transport.requests.filter((request) => request.method === 'POST');
    expect(writes.map((request) => bodyOf(request))).toEqual([{
      note: `Ready.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
    }]);
  });

  it('rejects a moved base before claiming and settles an unsupported fresh anchor without writing', async () => {
    const transport = createTransport((request) => request.method === 'GET' && request.url === ITEM_URL
      ? { status: 200, body: mergeRequestBody({ diff_refs: { base_sha: 'd'.repeat(40), head_sha: OBSERVED_HEAD, start_sha: OBSERVED_START } }) }
      : undefined);

    const moved = await publishGitlabMergeRequestReview(actionInput(), transport.context);
    expect(moved).toMatchObject({ kind: 'rejected', reason: 'base_advanced' });
    expect(transport.claimCount()).toBe(0);
    expect(transport.requests).toHaveLength(1);

    const unsupportedTransport = createTransport((request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      return undefined;
    });
    const unsupported = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({
        entries: [{ ...plan().entries[0], anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'h1' } }],
      }),
    }), unsupportedTransport.context);
    expect(unsupported).toMatchObject({ kind: 'rejected', reason: 'unsupported_anchor' });
    expect(unsupportedTransport.settlements).toContainEqual({
      dispatchToken: 'dispatch-token-1',
      result: {
        publicationPlanId: PLAN_ID,
        entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION,
          outcome: { kind: 'failed', code: 'unsupported_anchor' } }],
        verdict: { publicationCorrelationId: VERDICT_CORRELATION, outcome: { kind: 'skippedPriorFailure' } },
      },
    });
    expect(unsupportedTransport.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it('stops at the first failed draft creation and reports the exact skipped suffix without a verdict write', async () => {
    const twoEntries = [
      plan().entries[0],
      { ...plan().entries[0], happierCommentId: 'comment-2', body: 'Second.' },
    ];
    let createCount = 0;
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
        if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: [] };
        if (request.method === 'POST' && request.url === DRAFTS_URL) {
          createCount += 1;
          return createCount === 1 ? { status: 201, body: { id: 81 } } : { status: 422, body: { message: 'invalid position' } };
        }
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        return undefined;
      },
    });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'dispatch', publicationPlanId: PLAN_ID,
          dispatchToken: 'dispatch-token-1',
          entries: [
            { happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION },
            { happierCommentId: 'comment-2', publicationCorrelationId: 'F'.repeat(43) },
          ],
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: ['dispatch', 'dispatch'], verdict: 'dispatch' },
          priorResult: null,
        };
      },
    };

    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: twoEntries }),
    }), transport.context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [
          { outcome: { kind: 'uncertain' } },
          { outcome: { kind: 'failed' } },
        ],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    });
    expect(transport.requests.some((request) => request.method === 'PUT')).toBe(false);
    expect(transport.requests.some((request) => request.url.endsWith('/approve'))).toBe(false);
  });

  it('reconciles an existing exact draft marker and never creates it twice', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) {
          return { status: 200, body: [{ id: 81, note: `Earlier text\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->` }] };
        }
        if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: [] };
        return undefined;
      },
    });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'reconcile', publicationPlanId: PLAN_ID,
          dispatchToken: null,
          entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION }],
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: ['reconcile'], verdict: 'reconcile' },
          priorResult: null,
        };
      },
    };

    const result = await publishGitlabMergeRequestReview(actionInput({
      acknowledgedPreexistingDraftIds: ['81'],
    }), transport.context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [{ outcome: { kind: 'failed', code: 'gitlab-publication-draft-pending' } }],
      },
    });
    expect(transport.requests.filter((request) => request.method === 'POST' && request.url === DRAFTS_URL)).toHaveLength(0);
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  function settlementFailureTransport(settlementError: Error) {
    let notesReads = 0;
    return createTransport((request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
        notesReads += 1;
        return { status: 200, body: notesReads === 1 ? [] : [discussion(91,
          `Published\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->`,
        )] };
      }
      if (request.method === 'POST' && request.url === DRAFTS_URL) return { status: 201, body: { id: 81 } };
      if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/81/publish`) return { status: 200, body: {} };
      return undefined;
    }, { settlementError });
  }

  it('keeps the confirmed external outcome and still observes when settlement fails', async () => {
    const transport = settlementFailureTransport(new Error('canonical settlement unavailable'));

    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ verdict: null }),
    }), transport.context);

    // The comment IS published on GitLab. Losing Happier's record of it may not
    // discard the proven reference, and the mandatory post-mutation observation
    // still runs.
    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'published', externalRef: '91' } }] },
      failure: { code: 'gitlab-publication-settlement-unavailable' },
    });
    expect(result).toMatchObject({ observed: { headSha: OBSERVED_HEAD } });
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(transport.requests.at(-1)).toMatchObject({ method: 'GET', url: ITEM_URL });
  });

  it('preserves cancellation raised by the canonical settlement', async () => {
    const cancellation = Object.assign(new Error('the caller went away'), { name: 'AbortError' });
    const transport = settlementFailureTransport(cancellation);

    await expect(publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ verdict: null }),
    }), transport.context)).rejects.toBe(cancellation);
  });

  it('retries only the denied approval and never republishes its verdict summary', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
        if (request.method === 'GET' && request.url === NOTES_LIST_URL) {
          return { status: 200, body: [{
            id: 92, body: `Ready.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
          }] };
        }
        if (request.method === 'POST' && request.url === `${ITEM_URL}/approve`) {
          return { status: 201, body: { approved: true } };
        }
        return undefined;
      },
    });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'dispatch', publicationPlanId: PLAN_ID, entries: [],
          dispatchToken: 'dispatch-token-2',
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: [], verdict: 'dispatch' },
          // The first attempt published this summary and was then denied the
          // approval outright. The claim owner permits exactly that one effect
          // to be dispatched again.
          priorResult: {
            publicationPlanId: PLAN_ID,
            entries: [],
            verdict: {
              publicationCorrelationId: VERDICT_CORRELATION,
              outcome: { kind: 'failed', code: 'forbidden', externalRef: '92' },
            },
          },
        };
      },
    };

    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: [], verdict: { kind: 'approve', body: 'Ready.' } }),
    }), transport.context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: 'published', externalRef: '92' } } },
    });
    expect(transport.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${ITEM_URL}`,
      `GET ${DRAFTS_LIST_URL}`,
      `GET ${NOTES_LIST_URL}`,
      `POST ${ITEM_URL}/approve`,
      `GET ${ITEM_URL}`,
    ]);
  });

  it('publishes the verdict summary draft it already created instead of creating a second', async () => {
    let notesReads = 0;
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) {
          return { status: 200, body: [{
            id: 82, note: `Ready.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
          }] };
        }
        if (request.method === 'GET' && request.url === NOTES_LIST_URL) {
          notesReads += 1;
          return { status: 200, body: notesReads === 1 ? [] : [{
            id: 92, body: `Ready.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
          }] };
        }
        if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/82/publish`) return { status: 200, body: {} };
        if (request.method === 'POST' && request.url === `${ITEM_URL}/approve`) {
          return { status: 201, body: { approved: true } };
        }
        return undefined;
      },
    });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'dispatch', publicationPlanId: PLAN_ID, entries: [],
          dispatchToken: 'dispatch-token-3',
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: [], verdict: 'dispatch' },
          priorResult: {
            publicationPlanId: PLAN_ID,
            entries: [],
            verdict: {
              publicationCorrelationId: VERDICT_CORRELATION,
              outcome: { kind: 'failed', code: 'gitlab-verdict-draft-publish-failed' },
            },
          },
        };
      },
    };

    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: [], verdict: { kind: 'approve', body: 'Ready.' } }),
      acknowledgedPreexistingDraftIds: ['82'],
    }), transport.context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: 'published', externalRef: '92' } } },
    });
    expect(transport.requests.filter((request) => (
      request.method === 'POST' && request.url === DRAFTS_URL
    ))).toHaveLength(0);
    expect(transport.requests.filter((request) => request.method === 'PUT'))
      .toHaveLength(1);
  });

  it.each([
    ['comment', 'published'],
    ['approve', 'uncertain'],
  ] as const)('reconciles a published %s summary without repeating a markerless verdict', async (kind, expected) => {
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
        if (request.method === 'GET' && request.url === NOTES_LIST_URL) return { status: 200, body: [{
          id: 92, body: `Summary\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
        }] };
        return undefined;
      },
    });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'reconcile', publicationPlanId: PLAN_ID, entries: [],
          dispatchToken: null,
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: [], verdict: 'reconcile' },
          priorResult: null,
        };
      },
    };
    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: [], verdict: { kind, body: 'Summary' } }),
    }), transport.context);
    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: expected, externalRef: '92' } } },
    });
    expect(transport.requests.some((request) => request.method !== 'GET')).toBe(false);
  });

  it.each([
    { boundary: 'raw transport loss', error: new Error('simulated approval response loss'), outcome: 'uncertain' },
    { boundary: 'host reported answer loss', error: new PluginError({ code: 'outcome_unknown' }), outcome: 'uncertain' },
    { boundary: 'credential refusal before dispatch', error: new PluginError({ code: 'credential_unavailable' }), outcome: 'failed' },
  ] as const)('keeps a confirmed summary ref without repeating approve after $boundary', async ({ error, outcome }) => {
    let notesReads = 0;
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DRAFTS_LIST_URL) return { status: 200, body: [] };
        if (request.method === 'GET' && request.url === NOTES_LIST_URL) {
          notesReads += 1;
          return { status: 200, body: notesReads === 1 ? [] : [{
            id: 92, body: `Summary\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION} -->`,
          }] };
        }
        if (request.method === 'POST' && request.url === DRAFTS_URL) return { status: 201, body: { id: 82 } };
        if (request.method === 'PUT' && request.url === `${DRAFTS_URL}/82/publish`) return { status: 200, body: {} };
        if (request.method === 'POST' && request.url === `${ITEM_URL}/approve`) {
          throw error;
        }
        return undefined;
      },
    });
    (transport.context.services as unknown as { actions: { execute: Function } }).actions = {
      async execute() {
        return {
          disposition: 'dispatch', publicationPlanId: PLAN_ID, entries: [],
          dispatchToken: 'dispatch-token-1',
          verdict: { publicationCorrelationId: VERDICT_CORRELATION },
          instructions: { entries: [], verdict: 'dispatch' },
          priorResult: null,
        };
      },
    };
    const result = await publishGitlabMergeRequestReview(actionInput({
      publicationPlan: plan({ entries: [], verdict: { kind: 'approve', body: 'Summary' } }),
    }), transport.context);
    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: outcome, externalRef: '92' } } },
    });
    expect(transport.requests.filter((request) => request.url.endsWith('/approve'))).toHaveLength(1);
  });
});

function installSingleClaim(
  transport: ReturnType<typeof createStubGitlabTransport>,
  options: Readonly<{
    disposition?: 'dispatch' | 'reconcile'; commentId?: string;
    instruction?: 'dispatch' | 'reconcile' | 'confirmed' | 'held'; priorResult?: unknown;
  }> = {},
) {
  const settlements: unknown[] = [];
  Object.assign(transport.context.services, { actions: {
    async execute(_actionId: string, input: unknown) {
      if (typeof input === 'object' && input !== null && 'settlement' in input) settlements.push(input.settlement);
      const disposition = options.disposition ?? 'dispatch';
      return {
        disposition,
        dispatchToken: disposition === 'dispatch' ? 'dispatch-token-1' : null,
        publicationPlanId: PLAN_ID,
        entries: [{
          happierCommentId: options.commentId ?? 'comment-1',
          publicationCorrelationId: ENTRY_CORRELATION,
        }],
        verdict: null,
        instructions: { entries: [options.instruction ?? disposition], verdict: null },
        priorResult: options.priorResult ?? null,
      };
    },
  } });
  return settlements;
}

describe('GitLab single-comment publication Actions', () => {
  it.each([
    ['unsupported anchor', { ...plan().entries[0], anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'h1' } }],
    ['stale diff snapshot', { ...plan().entries[0], snapshot: {
      ...plan().entries[0]!.snapshot,
      diffContext: { ...plan().entries[0]!.snapshot.diffContext, baseSha: 'd'.repeat(40) },
    } }],
  ])('rejoins a confirmed standalone comment with %s without a provider write', async (_label, entry) => {
    const priorResult = { publicationPlanId: PLAN_ID,
      entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION,
        outcome: { kind: 'published', externalRef: '101' } }], verdict: { kind: 'notRequested' } };
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: [] };
      return undefined;
    } });
    const settlements = installSingleClaim(transport, { disposition: 'reconcile', instruction: 'confirmed', priorResult });

    const result = await publishGitlabMergeRequestReviewComment(actionInput({
      publicationPlan: plan({ entries: [entry], verdict: null }),
    }), transport.context);

    expect(result).toMatchObject({ kind: 'settled', publication: priorResult });
    expect(settlements).toContainEqual({ dispatchToken: null, result: priorResult });
    expect(transport.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it('settles an unsupported fresh standalone comment as failed without a provider write', async () => {
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: [] };
      return undefined;
    } });
    const settlements = installSingleClaim(transport);
    const result = await publishGitlabMergeRequestReviewComment(actionInput({ publicationPlan: plan({
      entries: [{ ...plan().entries[0], anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'h1' } }], verdict: null,
    }) }), transport.context);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'unsupported_anchor' });
    expect(settlements).toContainEqual({ dispatchToken: 'dispatch-token-1', result: {
      publicationPlanId: PLAN_ID,
      entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: ENTRY_CORRELATION,
        outcome: { kind: 'failed', code: 'unsupported_anchor' } }], verdict: { kind: 'notRequested' },
    } });
    expect(transport.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it('refuses review-comment and thread-reply publication on a closed merge request before claim', async () => {
    for (const run of [
      (transport: ReturnType<typeof createTransport>) => publishGitlabMergeRequestReviewComment({
        v: 1,
        instance: gitlabTestConfiguredInstance(),
        localRef: LOCAL_REF,
        routingToken: ROUTING_TOKEN,
        publicationPlan: plan({ verdict: null }),
      }, transport.context),
      (transport: ReturnType<typeof createTransport>) => publishGitlabMergeRequestThreadReply({
        v: 1,
        instance: gitlabTestConfiguredInstance(),
        localRef: LOCAL_REF,
        routingToken: ROUTING_TOKEN,
        discussionId: 'discussion-1',
        publicationPlan: plan({
          target: { ...plan().target, subtarget: { kindId: 'review-thread', targetId: 'discussion-1' } },
          baseRevision: null,
          headRevision: null,
          verdict: null,
        }),
      }, transport.context),
    ]) {
      const transport = createTransport((request) => request.method === 'GET' && request.url === ITEM_URL
        ? { status: 200, body: mergeRequestBody({ state: 'closed' }) }
        : undefined);
      const result = await run(transport);
      expect(result).toMatchObject({ kind: 'rejected', reason: 'state_changed' });
      expect(transport.claimCount()).toBe(0);
      expect(transport.requests).toHaveLength(1);
    }
  });

  it('publishes an exact revisioned range discussion with both GitLab paths', async () => {
    let reads = 0;
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
          reads += 1;
          return { status: 200, body: reads === 1 ? [] : [{
            id: 'discussion-new',
            notes: [{ id: 101, body: `Published\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->` }],
          }] };
        }
        if (request.method === 'POST' && request.url === DISCUSSIONS_URL) return { status: 201, body: { id: 'discussion-new' } };
        return undefined;
      },
    });
    installSingleClaim(transport);
    const entry = {
      ...plan().entries[0],
      anchor: { kind: 'range', filePath: 'src/index.ts', startLine: 12, endLine: 14, side: 'after' },
    };
    const result = await publishGitlabMergeRequestReviewComment({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: LOCAL_REF,
      routingToken: ROUTING_TOKEN,
      publicationPlan: plan({ entries: [entry], verdict: null }),
    }, transport.context);
    expect(result).toMatchObject({ kind: 'settled', publication: { entries: [{ outcome: { kind: 'published', externalRef: '101' } }] } });
    const write = transport.requests.find((request) => request.method === 'POST');
    expect(bodyOf(write)).toMatchObject({ position: {
      old_path: 'src/index.ts', new_path: 'src/index.ts',
      base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD, start_sha: OBSERVED_START,
      line_range: {
        start: { type: 'new', new_line: 12, line_code: 'c5fb850250c7443c48a6c12b5cf6916773da31f1_0_12' },
        end: { type: 'new', new_line: 14, line_code: 'c5fb850250c7443c48a6c12b5cf6916773da31f1_0_14' },
      },
    } });
  });

  it('keeps duplicate exact discussion markers uncertain and emits no provider write', async () => {
    const transport = createStubGitlabTransport({ respond: (request) => {
      if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
      if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) return { status: 200, body: [{
        id: 'discussion-a',
        notes: [
          { id: 101, body: `First\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->` },
          { id: 102, body: `Second\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->` },
        ],
      }] };
      return undefined;
    } });
    installSingleClaim(transport);

    const result = await publishGitlabMergeRequestReviewComment({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: LOCAL_REF,
      routingToken: ROUTING_TOKEN,
      publicationPlan: plan({ verdict: null }),
    }, transport.context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'uncertain' } }] },
    });
    expect(transport.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('binds one reply to its exact review-thread subtarget', async () => {
    let reads = 0;
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ITEM_URL) return { status: 200, body: mergeRequestBody() };
        if (request.method === 'GET' && request.url === DISCUSSIONS_LIST_URL) {
          reads += 1;
          return { status: 200, body: [{
            id: 'discussion-1',
            notes: reads === 1
              ? [{ id: 9, body: 'Existing' }]
              : [{ id: 9, body: 'Existing' }, { id: 102, body: `Reply\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->` }],
          }] };
        }
        if (request.method === 'POST' && request.url === `${DISCUSSIONS_URL}/discussion-1/notes`) return { status: 201, body: { id: 102 } };
        return undefined;
      },
    });
    installSingleClaim(transport);
    const publicationPlan = plan({
      target: { ...plan().target, subtarget: { kindId: 'review-thread', targetId: 'discussion-1' } },
      baseRevision: null,
      headRevision: null,
      verdict: null,
    });
    const result = await publishGitlabMergeRequestThreadReply({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: LOCAL_REF,
      routingToken: ROUTING_TOKEN,
      discussionId: 'discussion-1',
      publicationPlan,
    }, transport.context);
    expect(result).toMatchObject({ kind: 'settled', publication: { entries: [{ outcome: { kind: 'published', externalRef: '102' } }] } });
  });

  it('publishes and parses an issue comment through the issue observation boundary', async () => {
    let reads = 0;
    const transport = createStubGitlabTransport({
      respond: (request) => {
        if (request.method === 'GET' && request.url === ISSUE_URL) return { status: 200, body: issueBody() };
        if (request.method === 'GET' && request.url === ISSUE_NOTES_LIST_URL) {
          reads += 1;
          return { status: 200, body: reads === 1 ? [] : [{ id: 103, body: `Issue\n\n<!-- happier-review-comment:v1:${ENTRY_CORRELATION} -->` }] };
        }
        if (request.method === 'POST' && request.url === ISSUE_NOTES_URL) return { status: 201, body: { id: 103 } };
        return undefined;
      },
    });
    installSingleClaim(transport);
    const issueRef = { ...LOCAL_REF, kindId: 'issue' };
    const publicationPlan = plan({
      target: {
        ...plan().target,
        entryRef: { ...plan().target.entryRef, kindId: 'issue' },
      },
      baseRevision: null,
      headRevision: null,
      verdict: null,
    });
    const result = await publishGitlabIssueComment({
      v: 1,
      instance: gitlabTestConfiguredInstance(),
      localRef: issueRef,
      routingToken: ROUTING_TOKEN,
      publicationPlan,
    }, transport.context);
    expect(result).toMatchObject({
      kind: 'settled',
      observed: { iid: '7', state: 'opened' },
      publication: { entries: [{ outcome: { kind: 'published', externalRef: '103' } }] },
    });
  });
});
