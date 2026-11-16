import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestSchema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { ReviewCommentV1Schema } from '../reviews/comments/v1.js';
import { deriveReviewCommentStructuralMutationV1 } from '../reviews/comments/mutation.js';
import { splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1, openStoredReviewCommentV1 } from '../reviews/comments/content.js';
import { executeReviewCommentTransportV1 } from '../reviews/comments/transport.js';
import { ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentCommitMutationRequestV1Schema, type ReviewCommentPreparedRecordV1 } from '../reviews/comments/mutation.js';
import { ReviewCommentActionInputSchemasV1, ReviewCommentClaimPublicationDispatchResponseV1Schema } from '../reviews/comments/actions.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

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

  it('re-reads acceptance when the semantic Apply request is approved', async () => {
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
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'review.apply': { approvalRequiredSurfaces: [context.surface] } } }),
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'apply-approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      reviewCommentAction: async () => { reads++; return { items: [comment], cursor: null }; },
      sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'apply' }; },
    }));
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', serverIdentityId: 'srv_home',
      defaultSessionId: 'origin', defaultSessionMachineId: 'machine',
      runtimeAccountId: 'account', actionRequestId: 'apply-request', actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('review.apply', { sessionId: 'origin', reviews: [{ runId: 'review', findings: [finding] }] },
      { ...context, surface: 'cli' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approval).toMatchObject({ actionId: 'review.apply' });
    expect(reads).toBe(0);
    comment = { ...comment, reviewTriageStatus: 'reject', serverRevision: 2 };
    const decided = await executor.execute('approval.request.decide', { artifactId: 'apply-approval', decision: 'approve' }, context);
    expect(decided, JSON.stringify(decided))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'unchanged' } } } });
    expect(reads).toBe(1);
    expect(sent).toEqual([]);
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
      input: { sessionId: 'origin', states: [], includeHistory: false, limit: 50, ...(cursor ? { cursor } : {}) },
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

  it('binds an agent read to its host-stamped review scope and defaults the own session', async () => {
    const reviewCommentAction = vi.fn(async () => ({ items: [], cursor: null }));
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));
    const reviewCommentPrincipal = {
      actor: { kind: 'agent' as const, agentId: 'codex', sessionId: 'session-1' },
    };

    await expect(executor.execute('reviews.comments.list', { runId: 'review-1' }, {
      surface: 'agent', defaultSessionId: 'session-1', reviewCommentPrincipal,
    })).resolves.toMatchObject({ ok: true });

    expect(reviewCommentAction).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ sessionId: 'session-1', runId: 'review-1' }),
      reviewCommentPrincipal,
    }));
  });

  it('refuses an agent review operation when the caller scope cannot be established', async () => {
    const reviewCommentAction = vi.fn();
    const executor = createActionExecutor(createDeps({ reviewCommentAction }));
    await expect(executor.execute('reviews.comments.list', { projectId: 'project-1' }, {
      surface: 'agent',
    })).resolves.toMatchObject({ ok: false, errorCode: 'review_comment_permission_denied' });
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
      error: 'review_comment_permission_denied',
    });
    expect(reviewCommentAction).not.toHaveBeenCalled();
  });
});
