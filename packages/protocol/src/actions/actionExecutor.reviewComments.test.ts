import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { bindContextualActionToolInput } from './actionToolContext.js';
import { getActionSpec } from './actionSpecs.js';
import { ApprovalRequestSchema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { ReviewCommentV1Schema } from '../reviews/comments/v1.js';
import { deriveReviewCommentStructuralMutationV1 } from '../reviews/comments/mutation.js';
import { splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1, openStoredReviewCommentV1 } from '../reviews/comments/content.js';
import { executeReviewCommentTransportV1 } from '../reviews/comments/transport.js';
import { ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentCommitMutationRequestV1Schema, type ReviewCommentPreparedRecordV1 } from '../reviews/comments/mutation.js';
import { REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1, ReviewCommentActionInputSchemasV1, ReviewCommentClaimPublicationDispatchResponseV1Schema } from '../reviews/comments/actions.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { ReviewFindingsApplyResultV1Schema } from '../reviews/reviewApplyV1.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

describe('createActionExecutor (review comments)', () => {
  it.each(['accepted', 'missing', 'other-session'] as const)('batches prior-round findings after parallel run scopes: %s', async outcome => {
    const finding = (id: string) => ({ id: `finding-${id}`, title: `Finding ${id}`, summary: `Evidence ${id}`,
      severity: 'high', category: 'correctness', comment: { id: `comment-${id}`, serverRevision: 1, state: 'open',
        workspace: { machineId: 'machine', path: '/repo' } } });
    const comments = ['one', 'two'].map((id, index) => ReviewCommentV1Schema.parse({
      v: 1, id: `comment-${id}`, accountId: 'account', workspace: { machineId: 'machine', path: '/repo' },
      sessionId: outcome === 'other-session' && index === 1 ? 'another-session' : 'origin', runId: 'prior-round',
      findingId: `finding-${id}`, findingIdentity: String(index + 1).repeat(64), body: `Evidence ${id}`,
      bodyVersion: 1, edits: [], flags: {}, dispositions: {}, threadId: `comment-${id}`, transitions: [],
      anchor: { kind: 'file', filePath: 'reader.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
      author: { kind: 'agent', agentId: 'codex', sessionId: 'origin' }, state: 'open', reviewTriageStatus: 'accept',
      serverRevision: 2, createdAt: 1, updatedAt: 1,
    }));
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const scopes: string[] = [];
    const targeted: string[][] = [];
    const singleton: string[] = [];
    const sent: string[] = [];
    const refusal = { ok: false as const, errorCode: 'review_comment_not_found', error: 'review_comment_not_found' };
    const executor = createActionExecutor(createDeps({
      reviewCommentAction: async ({ actionId, input }) => {
        if (actionId === 'reviews.comments.get') {
          singleton.push(ReviewCommentActionInputSchemasV1[actionId].parse(input).commentId);
          return refusal;
        }
        const request = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
        expect(request.includeHistory).toBe(true);
        if (request.commentIds) {
          targeted.push(request.commentIds);
          // Transport pages may return a different order than the requested findings.
          return { items: request.cursor ? [comments[0]] : outcome === 'missing' ? [] : [comments[1]],
            cursor: request.cursor || outcome === 'missing' ? null : 'prior-page' };
        }
        scopes.push(`${request.runId}:${request.cursor ?? 'first'}`);
        if (request.runId === 'run-one' && !request.cursor) { await pending; return { items: [], cursor: 'next' }; }
        return { items: [], cursor: null };
      },
      sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'apply' }; },
    }));
    const running = executor.execute('review.apply', { sessionId: 'origin', reviews: [
      { runId: 'run-one', findings: [finding('one')] }, { runId: 'run-two', findings: [finding('two')] },
    ] }, { surface: 'ui', serverId: 'home' });
    try { await vi.waitFor(() => expect(scopes).toEqual(['run-one:first', 'run-two:first'])); }
    finally { release(); }
    const result = await running;
    expect(scopes).toEqual(['run-one:first', 'run-two:first', 'run-one:next']);
    expect(targeted).toEqual(outcome === 'missing' ? [['comment-one', 'comment-two']]
      : [['comment-one', 'comment-two'], ['comment-one', 'comment-two']]);
    if (outcome === 'accepted') {
      expect(result).toMatchObject({ ok: true });
      expect(singleton).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.indexOf('comment-one')).toBeLessThan(sent[0]!.indexOf('comment-two'));
      expect(sent[0]).toContain('"expectedServerRevision": 2');
    } else {
      expect(result).toMatchObject(outcome === 'missing' ? refusal : { ok: false, errorCode: 'review_comment_permission_denied' });
      expect(singleton).toEqual(outcome === 'missing' ? ['comment-one'] : []);
      expect(sent).toEqual([]);
    }
  });

  it('retains the first run scope refusal when parallel reads settle out of order', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reads: string[] = [];
    const first = { ok: false as const, errorCode: 'review_comment_permission_denied', error: 'first' };
    const executor = createActionExecutor(createDeps({ reviewCommentAction: async ({ input }) => {
      const request = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
      reads.push(request.runId!);
      if (request.runId === 'one') { await pending; return first; }
      return { ok: false, errorCode: 'review_comment_not_found', error: 'second' };
    }, sessionSendMessage: async () => { throw new Error('Must not send partial findings'); } }));
    const running = executor.execute('review.apply', { sessionId: 'origin', reviews: [
      { runId: 'one', findings: [] }, { runId: 'two', findings: [] },
    ] }, { surface: 'ui', serverId: 'home' });
    try { await vi.waitFor(() => expect(reads).toEqual(['one', 'two'])); }
    finally { release(); }
    expect(await running).toEqual(first);
  });

  it.each(['prompt', 'session'] as const)('implements only selected accepted Review roots through the %s destination', async destination => {
    const root = ReviewCommentV1Schema.parse({
      v: 1, id: 'selected', accountId: 'account', reviewId: 'review',
      workspace: { machineId: 'machine', path: '/repo' }, runId: 'run-selected',
      findingId: 'finding-selected', findingIdentity: 'a'.repeat(64),
      body: 'Selected current evidence', bodyVersion: 1, edits: [], flags: {}, dispositions: {},
      threadId: 'selected', transitions: [], anchor: { kind: 'file', filePath: 'reader.ts' },
      snapshot: { kind: 'none', capturedAt: 1 }, author: { kind: 'user', userId: 'person' },
      state: 'open', reviewTriageStatus: 'accept', serverRevision: 2, createdAt: 1, updatedAt: 1,
    });
    let selected = root;
    const unselected = { ...root, id: 'unselected', threadId: 'unselected', findingIdentity: 'b'.repeat(64),
      runId: 'run-unselected', findingId: 'finding-unselected', body: 'Unselected accepted evidence' };
    const inventory = [selected, unselected, ...Array.from({ length: REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1 }, (_, index) => ({
      ...unselected, id: `unselected-${index}`, threadId: `unselected-${index}`,
      findingIdentity: (index + 3).toString(16).padStart(64, '0'),
    }))];
    let pages = 0;
    const sent: string[] = [];
    const executor = createActionExecutor(createDeps({
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      reviewCommentAction: async ({ input }) => {
        pages++;
        const request = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
        const items = inventory.map(item => item.id === selected.id ? selected : item)
          .filter(item => request.commentIds === undefined || request.commentIds.includes(item.id));
        const offset = request.cursor ? Number(request.cursor) : 0;
        const limit = request.limit ?? REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1;
        return { items: items.slice(offset, offset + limit), cursor: offset + limit < items.length ? String(offset + limit) : null };
      },
      sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'selected-apply' }; },
    }));
    const input = { reviewId: 'review', commentIds: ['selected'],
      ...(destination === 'prompt' ? { destination: 'prompt' } : { sessionId: 'origin' }) };
    const context = { surface: 'ui' as const, serverId: 'home' };
    const result = await executor.execute('review.apply', input, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    const prepared = ReviewFindingsApplyResultV1Schema.parse(result.result);
    const prompt = 'prompt' in prepared ? prepared.prompt : sent[0];
    expect(prompt).toContain(root.body);
    expect(prompt).not.toContain(unselected.body);
    expect(sent).toHaveLength(destination === 'session' ? 1 : 0);
    if ('prompt' in prepared) expect(prepared.commentIds).toEqual(['selected']);
    console.info(`[review-apply-selection] inventory=${inventory.length} selected=1 listPages=${pages}`);
    expect(pages).toBe(1);

    const all = await executor.execute('review.apply', { reviewId: 'review', destination: 'prompt' }, context);
    expect(all).toMatchObject({ ok: true, result: { status: 'prepared', commentIds: inventory.map(item => item.id) } });
    await expect(executor.execute('review.apply', { ...input, commentIds: ['another-review-root'] }, context)).resolves.toMatchObject({
      ok: true, result: { status: 'unchanged', commentIds: [] },
    });

    selected = { ...selected, reviewTriageStatus: 'reject', serverRevision: 3 };
    await expect(executor.execute('review.apply', input, context)).resolves.toMatchObject({
      ok: true, result: { status: 'unchanged', commentIds: [] },
    });
    await expect(executor.execute('review.apply', { ...input, commentIds: [] }, context)).resolves.toMatchObject({
      ok: true, result: { status: 'unchanged', commentIds: [] },
    });
    expect(sent).toHaveLength(destination === 'session' ? 1 : 0);
  });

  it('prepares the current accepted Review prompt without sending and excludes a newly rejected comment', async () => {
    let comment = ReviewCommentV1Schema.parse({
      v: 1, id: 'accepted', accountId: 'account', reviewId: 'review', workspace: { machineId: 'machine', path: '/repo' },
      runId: 'review-run', findingId: 'finding', findingIdentity: 'a'.repeat(64),
      body: 'The freshly edited accepted explanation', bodyVersion: 2,
      finding: { id: 'finding', title: 'Preserve current evidence', summary: 'Stale engine summary',
        severity: 'high', category: 'correctness', evidence: 'Current evidence' },
      edits: [], flags: {}, dispositions: {}, threadId: 'accepted', transitions: [],
      anchor: { kind: 'file', filePath: 'reader.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
      author: { kind: 'workflow', runId: 'workflow' }, state: 'open', reviewTriageStatus: 'accept',
      serverRevision: 7, createdAt: 1, updatedAt: 2,
    });
    const executor = createActionExecutor({
      // Substitute only the authorized comment transport. Selection and rendering
      // remain in the same Review owner used by existing-Session Apply.
      reviewCommentAction: async () => ({ items: [comment], cursor: null }),
      sessionSendMessage: async () => { throw new Error('Preparing a prompt must not send a message'); },
      sessionAuthoringOpen: async () => { throw new Error('Preparing a prompt must not open a draft'); },
    });
    const input = { reviewId: 'review', destination: 'prompt' };
    const context = { surface: 'ui' as const, serverId: 'home', defaultSessionId: 'ambient-session' };
    const result = await executor.execute('review.apply', input, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
      result: { status: 'prepared', prompt: expect.any(String), commentIds: ['accepted'] } });
    if (!result.ok) throw new Error(result.error);
    const prepared = ReviewFindingsApplyResultV1Schema.parse(result.result);
    if (!('prompt' in prepared)) throw new Error('Expected the prepared Review prompt');
    expect(prepared.prompt).toContain(comment.body);
    expect(prepared.prompt).toContain('Current evidence');
    expect(prepared.prompt).toContain('"expectedServerRevision": 7');
    expect(prepared.prompt).not.toContain('Stale engine summary');
    comment = { ...comment, reviewTriageStatus: 'reject', serverRevision: 8 };
    await expect(executor.execute('review.apply', input, context)).resolves.toMatchObject({
      ok: true, result: { status: 'unchanged', commentIds: [] },
    });
  });

  it.each(['body-only', 'typed-edited'] as const)('applies accepted durable Review findings beyond the first page exactly once (%s)', async content => {
    const finding = content === 'typed-edited' ? { id: 'finding', title: 'Preserve the typed finding', summary: 'Original engine explanation',
      severity: 'high', category: 'security', evidence: 'Typed engine evidence', patch: 'A complete suggested patch',
      scopeAttribution: 'in_selected_changes', extensions: { 'acme.review-engine': { evidence: 'Plugin evidence' } } } : undefined;
    const comment = ReviewCommentV1Schema.parse({
      v: 1, id: 'accepted', accountId: 'account', reviewId: 'review', workspace: { machineId: 'machine', path: '/repo' },
      runId: 'review-run', findingId: 'finding', findingIdentity: 'a'.repeat(64),
      body: 'The current accepted explanation beyond the first page', bodyVersion: finding ? 2 : 1, finding,
      edits: [], flags: {}, dispositions: {},
      threadId: 'accepted', transitions: [], anchor: { kind: 'file', filePath: 'reader.ts' },
      snapshot: { kind: 'none', capturedAt: 1 }, author: { kind: 'workflow', runId: 'workflow' },
      state: 'open', reviewTriageStatus: 'accept', serverRevision: 7, createdAt: 1, updatedAt: 1,
    });
    const requests: unknown[] = [];
    const sent: string[] = [];
    const executor = createActionExecutor(createDeps({
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      reviewCommentAction: async ({ actionId, input }) => {
        expect(actionId).toBe('reviews.comments.list');
        const request = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
        requests.push(request);
        return request.cursor ? { items: [comment], cursor: null }
          : { items: [{ ...comment, id: 'rejected', threadId: 'rejected', findingIdentity: 'b'.repeat(64),
            body: 'Rejected finding', reviewTriageStatus: 'reject' },
          { ...comment, id: 'reply', parentCommentId: comment.id, body: 'Accepted discussion reply' },
          { ...comment, id: 'general-comment', threadId: 'general-comment', findingIdentity: undefined,
            body: 'Accepted general comment' }], cursor: 'second-page' };
      },
      sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'apply-review' }; },
    }));
    const applied = await executor.execute('review.apply', { sessionId: 'origin', reviewId: 'review' },
      { surface: 'ui', serverId: 'home' });
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
    expect(requests).toEqual([expect.objectContaining({ reviewId: 'review' }),
      expect.objectContaining({ reviewId: 'review', cursor: 'second-page' })]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(comment.body);
    if (finding) {
      const data = sent[0]!.match(/\n(\[[\s\S]*\])$/)?.[1];
      expect(data).toBeDefined();
      expect(JSON.parse(data!)).toMatchObject([{ title: finding.title, summary: comment.body,
        severity: finding.severity, category: finding.category, evidence: finding.evidence, patch: finding.patch,
        scopeAttribution: finding.scopeAttribution, extensions: finding.extensions }]);
    }
    expect(sent[0]).toContain('"expectedServerRevision": 7');
    expect(sent[0]).not.toContain('Rejected finding');
    expect(sent[0]).not.toContain('Accepted discussion reply');
    expect(sent[0]).not.toContain('Accepted general comment');
  });

  it('applies current accepted findings through review scope and the canonical message Action', async () => {
    const finding = { id: 'finding-1', title: 'Unsafe read', summary: 'Check the read', severity: 'high', category: 'correctness' };
    const comment = ReviewCommentV1Schema.parse({
      v: 1, id: 'comment-1', accountId: 'account', workspace: { machineId: 'machine', path: '/repo' },
      sessionId: 'origin', runId: 'review-1', findingId: finding.id, findingIdentity: 'a'.repeat(64),
      body: finding.summary, bodyVersion: 1, edits: [], flags: {}, dispositions: {}, threadId: 'comment-1', transitions: [],
      anchor: { kind: 'file', filePath: 'reader.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
      author: { kind: 'agent', agentId: 'codex', sessionId: 'origin' },
      state: 'open', reviewTriageStatus: 'accept', serverRevision: 7,
      createdAt: 1, updatedAt: 1,
    });
    let current = comment;
    let sibling: typeof comment | null = null;
    const sent: string[] = [];
    const executor = createActionExecutor(createDeps({
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      reviewCommentAction: async ({ input }) => {
        const request = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
        return { items: [current, ...(sibling ? [sibling] : [])].filter(item => item.runId === request.runId), cursor: null };
      },
      sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'apply-1' }; },
    }));
    const input = { sessionId: 'origin', reviews: [{ runId: 'review-1', findings: [finding] }] };
    const context = { surface: 'ui' as const, serverId: 'home' };
    const applied = await executor.execute('review.apply', { ...input, sessionId: { selector: 'self' } },
      { ...context, defaultSessionId: 'origin' });
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
    expect(sent[0]).toContain('"expectedServerRevision": 7');
    expect(sent[0]).toContain('Verify every finding against the current code');
    const disabled = await executor.execute('review.apply', input, { ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.message.send': { enabled: false } } }),
    });
    expect(disabled).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(sent).toHaveLength(1);
    sibling = ReviewCommentV1Schema.parse({ ...comment, id: 'comment-2', threadId: 'comment-2', runId: 'review-2', findingId: 'finding-2', reviewTriageStatus: 'reject' });
    const merged = { ...input, reviews: [...input.reviews, { runId: 'review-2', findings: [{ ...finding, id: 'finding-2' }] }] };
    const undecided = await executor.execute('review.apply', merged, context);
    expect(undecided, JSON.stringify(undecided)).toMatchObject({
      ok: true, result: { status: 'unchanged' },
    });
    expect(sent).toHaveLength(1);
    sibling = { ...sibling, reviewTriageStatus: 'accept', serverRevision: 9 };
    expect(await executor.execute('review.apply', merged, context)).toMatchObject({ ok: true });
    expect(sent[1]).toContain('comment-1');
    expect(sent[1]).toContain('comment-2');
    expect(sent[1]).toContain('"expectedServerRevision": 9');
    // Another surface changed acceptance after the card's initial read.
    current = { ...comment, reviewTriageStatus: 'reject', state: 'dismissed', serverRevision: 8 };
    await expect(executor.execute('review.apply', input, context)).resolves.toMatchObject({
      ok: true, result: { status: 'unchanged', commentIds: [] },
    });
    expect(sent).toHaveLength(2);
    current = { ...comment, sessionId: 'another-session' };
    await expect(executor.execute('review.apply', input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'review_comment_permission_denied',
    });
    expect(sent).toHaveLength(2);
  });

  it('preserves typed review read refusals and never sends a partial verification request', async () => {
    const refusal = { ok: false as const, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
    const sent: string[] = [];
    const executor = createActionExecutor(createDeps({
      reviewCommentAction: async () => refusal,
      sessionSendMessage: async ({ message }) => { sent.push(message); return {}; },
    }));
    await expect(executor.execute('review.apply', { sessionId: 'origin', reviews: [{ runId: 'review-1', findings: [] }] },
      { surface: 'ui', serverId: 'home' })).resolves.toEqual(refusal);
    expect(sent).toEqual([]);
  });

  it.each([
    { surface: 'cli', legacy: false }, { surface: 'agent', legacy: false },
    { surface: 'mcp', legacy: false }, { surface: 'agent', legacy: true },
  ] as const)('re-reads acceptance when the $surface Apply request is approved (legacy actor: $legacy)', async ({ surface, legacy }) => {
    const finding = { id: 'finding', title: 'Unsafe read', summary: 'Check the read', severity: 'high', category: 'correctness' };
    let comment = ReviewCommentV1Schema.parse({
      v: 1, id: 'comment', accountId: 'account', workspace: { machineId: 'machine', path: '/repo' },
      sessionId: 'origin', runId: 'review', findingId: finding.id,
      body: finding.summary, bodyVersion: 1, edits: [], flags: {}, dispositions: {}, threadId: 'comment', transitions: [],
      anchor: { kind: 'file', filePath: 'reader.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
      author: { kind: 'agent', agentId: 'codex', sessionId: 'origin' },
      state: 'open', reviewTriageStatus: 'accept', serverRevision: 1, createdAt: 1, updatedAt: 1,
    });
    let approval: ApprovalRequest | null = null;
    const sent: string[] = [];
    let reads = 0;
    const executor = createActionExecutor(createDeps({
      // Artifact persistence and the authenticated Home/message transports are boundaries.
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: surface === 'cli'
        ? { 'review.apply': { approvalRequiredSurfaces: [surface] } } : {} }),
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      approvalsCreate: async ({ request }) => {
        if (legacy && request.v === 2 && request.executionOriginV1) {
          // Stored approvals from before actor retention still lack that identity.
          const { reviewCommentActor: _actor, ...oldOrigin } = request.executionOriginV1;
          approval = { ...request, executionOriginV1: oldOrigin };
        } else approval = request;
        return { artifactId: 'apply-approval' };
      },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      reviewCommentAction: async ({ reviewCommentPrincipal }) => {
        if (surface !== 'cli') expect(reviewCommentPrincipal).toEqual({ actor: { kind: 'agent', agentId: 'codex', sessionId: 'origin' } });
        reads++; return { items: [comment], cursor: null };
      },
      sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'apply' }; },
    }));
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', serverIdentityId: 'srv_home',
      defaultSessionId: 'origin', defaultSessionMachineId: 'machine',
      runtimeAccountId: 'account', actionRequestId: 'apply-request', actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('review.apply', { sessionId: 'origin', reviews: [{ runId: 'review', findings: [finding] }] },
      { ...context, surface, ...(surface === 'cli' ? {} : { authority: 'account_automation' as const,
        actionCaller: { kind: 'session' as const, sessionId: 'origin', starterDepth: 0, turnDepth: 0 } }),
        reviewCommentPrincipal: { actor: { kind: 'agent', agentId: 'codex', sessionId: 'origin' } } }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approval).toMatchObject({ actionId: 'review.apply' });
    expect(reads).toBe(0);
    comment = { ...comment, reviewTriageStatus: 'reject', serverRevision: 2 };
    const decided = await executor.execute('approval.request.decide', { artifactId: 'apply-approval', decision: 'approve' },
      { ...context, reviewCommentPrincipal: { actor: { kind: 'agent', agentId: 'another-agent', sessionId: 'another-session' } } });
    expect(decided, JSON.stringify(decided)).toMatchObject(legacy
      ? { ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'review_comment_permission_denied' } } }
      : { ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'unchanged' } } } });
    expect(reads).toBe(legacy ? 0 : 1);
    // The requesting Session receives only the approval outcome, never a fix request.
    expect(sent.map(message => JSON.parse(message))).toEqual(surface === 'cli' ? [] : [expect.objectContaining({
      artifactId: 'apply-approval', actionId: 'review.apply', status: legacy ? 'failed' : 'executed',
    })]);
  });

  it('returns claimed correlations to the awaiting plugin after human approval', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const stored: { request: ApprovalRequest | null } = { request: null };
    let signalWaiting: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { signalWaiting = resolve; });
    const plan = ReviewCommentActionInputSchemasV1['reviews.comments.claimPublicationDispatch'].parse({
      target: { providerId: 'external-forge', nativeService: { pluginId: 'acme.forge', localId: 'account' },
        entryRef: { sourceId: 'acme.forge/source', kindId: 'pull-request', collisionScope: 'repo:1', entryId: '1' }, subtarget: null },
      baseRevision: 'base', headRevision: 'head', entries: [], verdict: { kind: 'comment', body: 'Review verdict' },
    });
    const claim = ReviewCommentClaimPublicationDispatchResponseV1Schema.parse({
      disposition: 'dispatch', dispatchToken: 'dispatch-token', publicationPlanId: 'A'.repeat(43), entries: [],
      verdict: { publicationCorrelationId: 'B'.repeat(43) }, instructions: { entries: [], verdict: 'dispatch' }, priorResult: null,
    });
    let dispatched = false;
    const executor = createActionExecutor(createDeps({
      // Artifact persistence and the authenticated Reviews HTTP adapter are
      // boundaries; policy, admission, waiting and replay remain real.
      approvalsCreate: async ({ request }) => { stored.request = request; return { artifactId: 'claim-approval' }; },
      approvalsGet: async () => stored.request,
      approvalsUpdate: async ({ request }) => {
        stored.request = request;
        coordinator.notifyApprovalUpdated({ artifactId: 'claim-approval', request });
        return { ok: true };
      },
      approvalsResolveBlockingDecision: async args => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async args => {
        const pending = coordinator.waitForDecision(args);
        signalWaiting?.();
        const result = await pending;
        return { ...result, request: ApprovalRequestSchema.parse(result.request) };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      reviewCommentAction: async ({ actionId, input }) => {
        expect(actionId).toBe('reviews.comments.claimPublicationDispatch');
        expect(input).toEqual(plan);
        dispatched = true;
        return claim;
      },
    }));
    const pending = executor.execute('reviews.comments.claimPublicationDispatch', plan, {
      surface: 'plugin', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_home',
      runtimeAccountId: 'account', actionRequestId: 'claim-request',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
      actionCaller: { kind: 'plugin', pluginId: 'acme.forge', contributionLocalId: 'publish-review',
        sourceCustody: { kind: 'development', registeredRootId: 'external-forge-root' } },
    });
    try {
      const admission = await Promise.race([
        pending.then(result => ({ kind: 'completed' as const, result })),
        waiting.then(() => ({ kind: 'waiting' as const })),
      ]);
      expect(admission, JSON.stringify(admission)).toEqual({ kind: 'waiting' });
      expect(dispatched).toBe(false);
      expect(ApprovalRequestSchema.parse(stored.request).status).toBe('open');
      await expect(executor.execute('approval.request.decide', { artifactId: 'claim-approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home',
        runtimeAccountId: 'account', actionCaller: { kind: 'host' },
      })).resolves.toMatchObject({ ok: true });
      await expect(pending).resolves.toEqual({ ok: true, result: claim });
      expect(dispatched).toBe(true);
    } finally {
      coordinator.dispose();
      await pending;
    }
  });

  it.each(['reviews.comments.edit', 'reviews.comments.transition'] as const)('executes an approved Session comment mutation through the human Account owner: %s', async actionId => {
    const workspace = { machineId: 'machine', path: '/workspace' };
    let comment = ReviewCommentV1Schema.parse({ v: 1, id: 'comment', accountId: 'account', workspace, sessionId: 'session',
      anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'Original finding',
      bodyVersion: 1, edits: [], author: { kind: 'plugin', pluginId: 'acme.external-review' }, state: 'open', flags: {},
      dispositions: {}, threadId: 'comment', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 });
    let approval: ApprovalRequest | null = null;
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(91) };
    let prepared: ReviewCommentPreparedRecordV1 | undefined;
    const deliveries: string[] = [];
    const read = () => {
      const split = splitReviewCommentV1(comment);
      return { v: 1 as const, structural: split.structural, sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'e2ee', material, randomBytes: length => new Uint8Array(length).fill(92) }) };
    };
    const executor = createActionExecutor(createDeps({
      // Account Artifact persistence and Home authorization are boundaries of the Protocol executor.
      sessionSendMessage: async ({ sessionId, localId }) => {
        deliveries.push(sessionId); return { status: 'accepted', localId };
      },
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      reviewCommentAction: async ({ actionId: commentAction, input, reviewCommentPrincipal }) => {
        if (commentAction !== actionId) throw new Error('Unexpected comment action');
        expect(reviewCommentPrincipal).toBeUndefined();
        // The actual Account transport must select the human actor after approval;
        // the original external-review author must remain immutable.
        return executeReviewCommentTransportV1({ actionId: commentAction, input: ReviewCommentActionInputSchemasV1[commentAction].parse(input),
          context: { accountId: 'account', mode: 'e2ee', material },
          actor: reviewCommentPrincipal?.actor ?? { kind: 'user', userId: 'account' },
          randomBytes: length => new Uint8Array(length), request: async request => {
            if (request.path.endsWith('/prepare')) {
              const body = ReviewCommentPrepareMutationRequestV1Schema.parse(request.body);
              const previous = read();
              const derived = deriveReviewCommentStructuralMutationV1({ accountId: 'account',
                actor: { kind: 'user', userId: 'account' }, current: [previous.structural], mutation: body.mutation,
                runtime: { now: () => 2, createId: prefix => prefix + '-new' } });
              prepared = { ...derived.records[0]!, previous: { structural: previous.structural,
                source: { v: 1, layout: 'canonical_v1', envelope: previous.sensitiveEnvelope } } };
              return { v: 1, receipt: 'receipt', request: body, records: [prepared], replayed: false, failed: [] };
            }
            const body = ReviewCommentCommitMutationRequestV1Schema.parse(request.body);
            const next = { v: 1 as const, structural: prepared!.structural, sensitiveEnvelope: body.records[0]!.sensitiveEnvelope };
            const opened = openStoredReviewCommentV1({ stored: next, mode: 'e2ee', material });
            if (opened.status !== 'available') throw new Error('Unusable comment');
            comment = opened.comment;
            return { v: 1, comments: [next], replayed: false, failed: [] };
          } });
      },
    }));
    const input = actionId === 'reviews.comments.edit'
      ? { workspace, commentId: 'comment', expectedServerRevision: 1, expectedBodyVersion: 1, nextBody: 'Approved edit', clientMutationId: 'edit' }
      : { workspace, commentId: 'comment', expectedServerRevision: 1, expectedState: 'open', toState: 'dismissed', reason: 'Approved dismissal', clientMutationId: 'transition' };
    await expect(executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_home',
      runtimeAccountId: 'account', actionRequestId: 'request', defaultSessionId: 'session', defaultSessionMachineId: 'machine',
      actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      reviewCommentPrincipal: { actor: { kind: 'agent', agentId: 'acme.external/agent', sessionId: 'session' } },
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(comment.serverRevision).toBe(1);
    const result = await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'account', actionCaller: { kind: 'host' },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(deliveries).toEqual(['session']);
    expect(comment).toMatchObject({ serverRevision: 2, author: { kind: 'plugin', pluginId: 'acme.external-review' },
      ...(actionId === 'reviews.comments.edit' ? { body: 'Approved edit', edits: [{ editedBy: { kind: 'user', userId: 'account' } }] }
        : { state: 'dismissed', transitions: [{ transitionedBy: { kind: 'user', userId: 'account' } }] }) });
  });
  it('drains explicitly requested pages under the same host-stamped principal without forwarding the Action-only flag', async () => {
    const signal = new AbortController().signal;
    const requests: unknown[] = [];
    const executor = createActionExecutor(createDeps({ reviewCommentAction: async (request) => {
      requests.push(request);
      return { items: [], cursor: requests.length === 1 ? 'second-page' : null };
    } }));
    await expect(executor.execute('reviews.comments.list', { sessionId: 'origin', allPages: true }, {
      surface: 'rpc', serverId: 'server', signal, actionCaller: { kind: 'workflowRun', runId: 'run' },
    })).resolves.toEqual({ ok: true, result: { items: [], cursor: null } });
    expect(requests).toEqual([undefined, 'second-page'].map((cursor) => ({
      actionId: 'reviews.comments.list', serverId: 'server', signal,
      reviewCommentPrincipal: { actor: { kind: 'workflow', runId: 'run' } },
      // A drain reads the largest page the list contract allows: fewer round trips, same rows.
      input: { sessionId: 'origin', states: [], includeHistory: false, limit: 200, ...(cursor ? { cursor } : {}) },
    })));
  });

  it('does not publish a partial all-pages result when a later page fails', async () => {
    let page = 0;
    const executor = createActionExecutor(createDeps({ reviewCommentAction: async () => ++page === 1
      ? { items: [], cursor: 'next' }
      : { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' },
    }));
    await expect(executor.execute('reviews.comments.list', { sessionId: 'origin', allPages: true }, { surface: 'ui' }))
      .resolves.toEqual({ ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' });
  });

  it('retains ordinary single-page reads and their continuation cursor', async () => {
    const executor = createActionExecutor(createDeps({ reviewCommentAction: async () => ({ items: [], cursor: 'next' }) }));
    await expect(executor.execute('reviews.comments.list', { sessionId: 'origin' }, { surface: 'ui' }))
      .resolves.toEqual({ ok: true, result: { items: [], cursor: 'next' } });
  });

  it.each(['agent', 'mcp'] as const)('reads accepted Review roots through %s without adding the ambient Session filter', async surface => {
    const root = ReviewCommentV1Schema.parse({
      v: 1, id: 'accepted-root', accountId: 'account', reviewId: 'review', roundOrdinal: 1, appearances: [],
      body: 'The accepted human finding delivered by Apply', bodyVersion: 1, edits: [], flags: {}, dispositions: {},
      threadId: 'accepted-root', transitions: [], anchor: { kind: 'file', filePath: 'total.ts' },
      snapshot: { kind: 'none', capturedAt: 1 }, author: { kind: 'user', userId: 'account' },
      state: 'open', reviewTriageStatus: 'accept', serverRevision: 2, createdAt: 1, updatedAt: 1,
    });
    const legacy = ReviewCommentV1Schema.parse({ ...root, reviewId: undefined, roundOrdinal: undefined,
      sessionId: 'session-1', runId: 'run-1', workspace: { machineId: 'machine', path: '/repo' } });
    const stored = (comment: typeof root) => {
      const split = splitReviewCommentV1(comment);
      return { v: 1, structural: split.structural,
        sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' }) };
    };
    let reads = 0;
    const executor = createActionExecutor(createDeps({ reviewCommentAction: async ({ actionId, input, reviewCommentPrincipal }) => {
      if (actionId !== 'reviews.comments.list') throw new Error('Unexpected mutation');
      const request = ReviewCommentActionInputSchemasV1[actionId].parse(input);
      return executeReviewCommentTransportV1({ actionId, input: request,
        actor: reviewCommentPrincipal?.actor ?? { kind: 'user', userId: 'account' },
        context: { accountId: 'account', mode: 'plain', material: null,
          // Substitute the admitted Artifact codec boundary; dispatch, opening and filtering stay real.
          ...(request.reviewId ? { resource: { reviewId: request.reviewId, mode: 'plain' as const,
            open: async envelope => {
              if (envelope.t !== 'plain') throw new Error('Expected plain Artifact content');
              return envelope.v;
            },
            seal: async value => ({ t: 'plain' as const, v: value }),
            commitment: (_purpose, value) => value,
          } } : {}),
        },
        randomBytes: length => new Uint8Array(length),
        // Authenticated HTTP is the boundary. The client must still apply its actual query filters.
        request: async () => {
          reads++;
          return { items: request.reviewId ? [stored(root)] : [stored(legacy),
            stored({ ...legacy, id: 'other-session-root', threadId: 'other-session-root', sessionId: 'other-session' })], cursor: null };
        },
      });
    } }));
    const context = { surface, defaultSessionId: 'session-1', reviewCommentPrincipal: {
      actor: { kind: 'agent' as const, agentId: 'codex', sessionId: 'session-1' },
    } };
    const selected = { reviewId: 'review', commentIds: [root.id] };
    const expected = { ok: true, result: { items: [root], cursor: null } };
    await expect(executor.execute('reviews.comments.list', selected, { surface: 'ui' })).resolves.toEqual(expected);
    // Include the real tool binder: its advertised default must not narrow an explicit Review.
    const toolInput = (input: unknown) => bindContextualActionToolInput({ actionId: 'reviews.comments.list', input,
      context, contextualDefaults: getActionSpec('reviews.comments.list').contextualDefaults });
    await expect(executor.execute('reviews.comments.list', toolInput(selected), context)).resolves.toEqual(expected);
    await expect(executor.execute('reviews.comments.list', toolInput({ reviewId: 'review' }), context)).resolves.toEqual(expected);
    await expect(executor.execute('reviews.comments.list', toolInput({ ...selected, sessionId: 'session-1' }), context))
      .resolves.toEqual({ ok: true, result: { items: [], cursor: null } });
    await expect(executor.execute('reviews.comments.list', toolInput({ runId: 'run-1' }), context))
      .resolves.toEqual({ ok: true, result: { items: [legacy], cursor: null } });
    const beforeRefusal = reads;
    await expect(executor.execute('reviews.comments.list', selected, { ...context, defaultSessionId: 'other-session' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'review_comment_permission_denied' });
    expect(reads).toBe(beforeRefusal);
  });

  it('refuses an agent review operation when the caller scope cannot be established', async () => {
    const reviewCommentAction = vi.fn();
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));
    const result = await executor.execute('reviews.comments.list', { projectId: 'project-1' }, {
      surface: 'agent',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'review_comment_permission_denied' });
    if (result.ok) throw new Error('Expected an Agent authority refusal');
    expect(result.error).not.toBe(result.errorCode);
    expect(reviewCommentAction).not.toHaveBeenCalled();
  });

  it('routes durable review-comment actions through the host review-comment executor', async () => {
    const reviewCommentAction = vi.fn(async () => ({ items: [], cursor: null }));
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));

    const result = await executor.execute(
      'reviews.comments.list',
      { projectId: 'project-1', states: ['open'] },
      { surface: 'ui', serverId: 'server-1' },
    );

    expect(result).toEqual({ ok: true, result: { items: [], cursor: null } });
    expect(reviewCommentAction).toHaveBeenCalledWith({
      actionId: 'reviews.comments.list',
      input: { projectId: 'project-1', states: ['open'], includeHistory: false, limit: 50 },
      serverId: 'server-1',
    });
  });

  it('forwards a host-derived review principal through canonical dispatch', async () => {
    const reviewCommentAction = vi.fn(async () => ({ comment: { id: 'comment-1' } }));
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));
    const reviewCommentPrincipal = {
      actor: { kind: 'agent' as const, agentId: 'acme.review', sessionId: 'session-1' },
    };

    await executor.execute('reviews.comments.create', {
      projectId: 'project-1',
      anchor: { kind: 'line', filePath: 'src/a.ts', line: 1 },
      snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
      body: 'Fix this.',
      clientMutationId: 'mutation-1',
    }, { surface: 'rpc', bypassApprovals: true, reviewCommentPrincipal });

    expect(reviewCommentAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'reviews.comments.create',
      reviewCommentPrincipal,
    }));
  });

  it('derives the review principal from the host-stamped plugin caller', async () => {
    const reviewCommentAction = vi.fn(async () => ({ items: [], cursor: null }));
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));
    const signal = new AbortController().signal;

    await expect(executor.execute(
      'reviews.comments.list',
      { projectId: 'project-1' },
      {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.review' },
        signal,
      },
    )).resolves.toEqual({ ok: true, result: { items: [], cursor: null } });

    expect(reviewCommentAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'reviews.comments.list',
      reviewCommentPrincipal: {
        actor: { kind: 'plugin', pluginId: 'acme.review' },
      },
      signal,
    }));
  });

  it('rejects a plugin-surface review action without a host-stamped caller', async () => {
    const reviewCommentAction = vi.fn();
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));

    await expect(executor.execute(
      'reviews.comments.list',
      { projectId: 'project-1' },
      { surface: 'plugin' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(reviewCommentAction).not.toHaveBeenCalled();
  });

  it('rejects a caller-supplied or cross-plugin review principal', async () => {
    const reviewCommentAction = vi.fn();
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));

    await expect(executor.execute(
      'reviews.comments.list',
      { projectId: 'project-1' },
      {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.review' },
        reviewCommentPrincipal: {
          actor: { kind: 'plugin', pluginId: 'other.review' },
        },
      },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'review_comment_permission_denied',
      error: expect.not.stringMatching(/^review_comment_permission_denied$/u),
    });
    expect(reviewCommentAction).not.toHaveBeenCalled();
  });
});
