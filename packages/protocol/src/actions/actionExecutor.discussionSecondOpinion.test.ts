import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec, type SessionTranscriptGetItem } from './actionSpecs.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { DiscussionCreateResultV1Schema, DiscussionOpenedMessageV1Schema, DiscussionInviteInputV1Schema } from '../discussions/actions.js';
import { DiscussionSecondOpinionPreviewV1Schema, resolveDiscussionSecondOpinionSourceGrantsV1 } from '../discussions/secondOpinion.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import type { DiscussionSecondOpinionReviewerV1 } from '../discussions/secondOpinion.js';
import { readDiscussionSecondOpinionModelChildV1 } from '../discussions/secondOpinionActions.js';
import { ArtifactDocumentV1Schema } from '../artifacts/artifactActionsV1.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { resolveApprovalExecutor } from '../approvals/resolveApprovalExecutor.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createWorkflowAccountRunActionOwner } from './executor/workflowRunActions.js';
import { WorkflowRunSummaryV1Schema } from '../workflows/workflowProgressV1.js';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from './actionCatalog.js';
import { readCommittedDiscussionMessage } from './executor/docCollaborationActions.js';
import { areServerProfileIdentifiersEquivalent } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { projectSessionSpawnNewActionResultV1 } from '../sessions/creation/sessionSpawnNewResultV1.js';

const request = {
  intent: 'preview', title: 'Review this answer', question: 'What would you change?',
  source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: 'source' }, messageId: 'answer' } },
  reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: 'reviewer' } } }],
  retry: { creationLocalId: 'create-opinion', quoteLocalId: 'quote-opinion', questionLocalId: 'ask-opinion' },
} as const;

function fixture(options: { needsGrant?: boolean; quoteOnly?: boolean; sourceReady?: boolean; lostCreate?: boolean; lostPost?: boolean;
  reviewer?: DiscussionSecondOpinionReviewerV1; sourcePages?: 'paged' | 'truncated'; lostGrant?: boolean;
  publisherSessionId?: string; publisherDisclosure?: boolean; noReviewers?: boolean;
  discussionSourceGap?: boolean; canGrantSource?: boolean; grantLeavesGap?: boolean; createRefused?: boolean;
  reviewers?: readonly DiscussionSecondOpinionReviewerV1[];
  sourceText?: () => string;
  sourceReadable?: () => boolean;
  sourceMessageCount?: number;
  interceptActionExecution?: ActionExecutorDeps['interceptActionExecution'];
  presentUserActionConfirmation?: ActionExecutorDeps['presentUserActionConfirmation'];
  routeHostChildAction?: ActionExecutorDeps['routeHostChildAction'] } = {}) {
  const events: string[] = [];
  const creates: unknown[] = [], posts: unknown[] = [], invites: unknown[] = [];
  const approvals: ApprovalRequestV2[] = [];
  const speakers = new Map<string, 'when_addressed' | 'reads_only' | 'drafts_for_approval' | 'watches_and_speaks_up'>();
  const births: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
  const reviewer = options.reviewer ?? request.reviewers[0];
  const reviewers = options.reviewers ?? [reviewer];
  const workflowAdmissions: unknown[] = [];
  const sourceCost = { reads: 0, rows: 0 };
  const resolveServerProfileScopeId = (identifier: string) => ['stack_qa', 'home'].includes(identifier) ? 'home' : null;
  let grantReady = !options.needsGrant, createLost = false, postLost = false, grantLost = false;
  const preview = () => DiscussionSecondOpinionPreviewV1Schema.parse({
    source: request.source, sourceContentReady: options.sourceReady ?? true, sourceAudienceAccountIds: grantReady ? ['alice', 'bob'] : ['alice'],
    discussionAudienceAccountIds: options.discussionSourceGap ? ['alice', 'bob'] : ['alice'],
    missingDiscussionSourceAccountIds: options.discussionSourceGap && !grantReady ? ['bob'] : [],
    discussionDisclosure: options.discussionSourceGap && !grantReady ? { ok: false, reason: 'destination_audience_broader' } : { ok: true },
    canGrantSource: options.canGrantSource ?? true,
    ...(options.publisherSessionId ? { publisher: { sessionId: options.publisherSessionId, answerPolicy: 'when_addressed',
      audienceAccountIds: ['alice'], disclosure: options.publisherDisclosure === false
        ? { ok: false, reason: 'destination_audience_broader' } : { ok: true } } } : {}),
    reviewers: options.noReviewers ? [] : reviewers.map(reviewer => ({ ...reviewer, sourceAccess: options.quoteOnly ? 'quote_only' : 'read',
      runtimeAccountId: 'alice', audienceAccountIds: ['alice', 'bob'], missingSourceAccountIds: grantReady ? [] : ['bob'],
      canGrantSource: options.canGrantSource ?? true, disclosure: grantReady ? { ok: true } : { ok: false, reason: 'destination_audience_broader' } })),
  });
  const message = (id: string, seq: number) => DiscussionOpenedMessageV1Schema.parse({
    id, discussionId: 'opinion', localId: id === 'quote' ? request.retry.quoteLocalId : request.retry.questionLocalId, seq,
    authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1, mentionedAccountIds: [],
    content: { v: 1, parts: [{ t: 'text', text: id === 'quote' ? 'Exact source answer' : request.question }] },
    messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'opinion' }, messageId: id },
  });
  const created = () => DiscussionCreateResultV1Schema.parse({ v: 1, serverId: 'home', firstMessage: message('quote', 1), discussion: {
    id: 'opinion', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain', keyReadiness: true, dataEncryptionKey: null,
    anchor: { kind: 'session', sessionId: 'source', messageId: 'answer' }, creationLocalId: request.retry.creationLocalId,
    title: request.title, latestMessage: { id: 'quote', localId: request.retry.quoteLocalId, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
    messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
  } });
  // These are the host's HTTP/transcript transport ports. The real Action
  // executor, schemas, composition and semantic child builders remain intact.
  const deps: ActionExecutorDeps = {
    approvalsCreate: async ({ request: approval }) => {
      approvals.push(ApprovalRequestV2Schema.parse(approval));
      return { artifactId: `opinion-approval-${approvals.length}` };
    },
    approvalsGet: async ({ artifactId }) => approvals[Number(artifactId.split('-').at(-1)) - 1] ?? null,
    // Home currentness is a transport boundary; only this fixture Account and Machine serve it.
    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.accountId === 'alice' && origin.machineId === 'machine',
    approvalsUpdate: async ({ artifactId, request: next }) => {
      const index = Number(artifactId.split('-').at(-1)) - 1;
      const stored = approvals[index];
      if (!stored) throw new Error('Missing approval');
      const transition = decideApprovalRequestTransition(stored, next);
      if (!transition.ok) return transition;
      approvals[index] = ApprovalRequestV2Schema.parse(next);
      return { ok: true };
    },
    discussionAction: async args => {
      events.push(args.actionId);
      if (args.actionId === 'discussion.second_opinion.start') return { ok: true, value: preview() };
      if (args.actionId === 'discussion.create') {
        if (options.createRefused) return { ok: false, errorCode: 'discussion_access_forbidden', error: 'discussion_access_forbidden' };
        creates.push(args.input);
        if (options.lostCreate && !createLost) { createLost = true; return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }; }
        return created();
      }
      if (args.actionId === 'discussion.participants.list') return { discussionId: 'opinion', ownerAccountId: 'alice', access: 'owner', grants: [],
        participants: [...speakers].map(([sessionId, answerPolicy]) => ({ participant: { kind: 'session', sessionId }, answerPolicy, createdAt: 1 })) };
      if (args.actionId === 'discussion.invite') { invites.push(args.input);
        const invite = DiscussionInviteInputV1Schema.parse(args.input);
        if (invite.participant.kind === 'session') speakers.set(invite.participant.sessionId, invite.answerPolicy ?? 'when_addressed');
        return { discussionId: 'opinion', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
        ...(invite.participant.kind === 'model' ? { modelParticipant: {
          participant: { kind: 'model', participantSlotId: invite.participant.participantSlotId }, launch: invite.participant.launch,
          sessionId: null, answerPolicy: 'when_addressed', createdAt: 1,
        } } : {}) }; }
      if (args.actionId === 'discussion.post') {
        posts.push(args.input);
        if (options.lostPost && !postLost) { postLost = true; return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }; }
        return { v: 1, serverId: 'home', message: message('question', 2), messageSeq: 2 };
      }
      throw new Error(`Unexpected HTTP boundary ${args.actionId}`);
    },
    sessionAccessAction: async args => {
      events.push(args.actionId);
      grantReady = !options.grantLeavesGap;
      if (options.lostGrant && !grantLost) { grantLost = true; return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }; }
      return { changed: true, grant: { subject: { kind: 'account', accountId: 'bob' }, accessLevel: 'view', canApprovePermissions: false } };
    },
    sessionSpawnNew: async args => {
      births.push(args);
      return { type: 'success', disposition: 'rejoined', sessionId: reviewers.length > 1 ? `allocated-reviewer-${births.length % reviewers.length}` : 'allocated-reviewer', executionTarget: args.executionTarget,
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
    },
    sessionTranscriptGet: async args => {
      events.push('read-source');
      sourceCost.reads++;
      if (options.sourceReadable?.() === false) return { ok: false, errorCode: 'session_access_denied', errorMessage: 'session_access_denied' };
      if (typeof options.sourceMessageCount === 'number') {
        // The semantic transcript transport owns paging. All Action composition
        // and admission remain real; the source is behind 209 unrelated rows.
        const sourceRows = options.sourceMessageCount;
        const inventory = Array.from({ length: sourceRows }, (_, index): SessionTranscriptGetItem => ({
          id: index === sourceRows - 1 ? 'answer' : `unrelated-${index}`,
          semanticRole: 'assistant', role: 'assistant', kind: 'message', createdAt: 1,
          text: index === sourceRows - 1 ? options.sourceText?.() ?? 'Exact source answer' : 'Unrelated answer',
        }));
        const offset = args.cursor ? Number(args.cursor) : 0;
        const exactId = 'messageId' in args && typeof args.messageId === 'string' ? args.messageId : undefined;
        const items = exactId ? inventory.filter(row => row.id === exactId) : inventory.slice(offset, offset + 20);
        sourceCost.rows += items.length;
        const hasMore = !exactId && offset + items.length < inventory.length;
        return { ok: true, sessionId: 'source', items, hasMore,
          nextCursor: hasMore ? String(offset + items.length) : null,
          diagnostics: { rawRowsScanned: items.length, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
      }
      const firstPage = options.sourcePages === 'paged' && !args.cursor && !args.messageId;
      return { ok: true, sessionId: 'source', items: firstPage ? [] : [{ id: 'answer', semanticRole: 'assistant', role: 'assistant', kind: 'message',
        createdAt: 1, text: 'Exact source answer', ...(options.sourcePages === 'truncated' ? { truncated: true } : {}) }],
        nextCursor: firstPage ? 'next-source-page' : null, hasMore: firstPage,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
    },
  } as ActionExecutorDeps;
  const workflow = createWorkflowAccountRunActionOwner({
    resolveServerProfileScopeId,
    resolveAccountId: async () => 'alice', resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    resolveRunReportPolicy: async () => ({ preset: 'important' }), normalizeAbsolutePath: path => path.startsWith('/') ? path : null,
    definitions: { get: async () => { throw new Error('unexpected_definition'); } },
    randomBytes: () => { throw new Error('plain_needs_no_key'); },
    prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } } }),
    resolveDiscussionOrigin: async ({ origin, context }) => {
      const result = await readCommittedDiscussionMessage({ kind: 'discussion', discussion: origin.discussion, messageId: origin.addressingMessageId }, context,
        async () => ({ v: 1, serverId: 'home', discussionId: 'opinion', messageSeq: 2,
          messages: [message('question', 2)], hasMoreOlder: false, incomplete: false }), undefined,
        (left, right) => areServerProfileIdentifiersEquivalent(left, right, resolveServerProfileScopeId));
      if (!result.ok) throw new Error('invalid_origin');
      return { discussion: origin.discussion, messageId: result.message.id, throughSeq: result.message.seq };
    },
    resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
      resolveSessionTarget: async value => typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof value.serverId === 'string' && typeof value.sessionId === 'string'
        ? { address: { serverId: value.serverId, sessionId: value.sessionId }, machineId: 'machine' } : null,
      readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } }),
    storage: { execute: async operation => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation !== 'admit') throw new Error(`Unexpected storage ${operation.operation}`);
      workflowAdmissions.push(operation);
      return { kind: 'created', run: WorkflowRunSummaryV1Schema.parse({ id: operation.runId, sourceArtifactId: null, ownerAccountId: 'alice', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        origin: { kind: 'direct' }, state: 'queued', revision: 0, machineId: 'machine', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }) };
    } },
  });
  deps.workflowAction = async args => {
    try { return await workflow.execute(args); }
    catch (error) { events.push(`workflow-error:${error instanceof Error ? error.message : String(error)}`); throw error; }
  };
  const executor = createActionExecutor({ ...deps, resolveServerProfileScopeId,
    ...(options.interceptActionExecution ? { interceptActionExecution: options.interceptActionExecution } : {}),
    ...(options.presentUserActionConfirmation ? { presentUserActionConfirmation: options.presentUserActionConfirmation } : {}),
    ...(options.routeHostChildAction ? { routeHostChildAction: options.routeHostChildAction } : {}) });
  const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', bypassApprovals: true,
    callerPermissionMode: 'default' as const,
    actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      'discussion.second_opinion.start': ['ui'], 'discussion.create': ['ui'], 'discussion.invite': ['ui'],
      'discussion.post': ['ui'], 'session.access.grant.set': ['ui'], 'session.transcript.get': ['ui'], 'session.spawn_new': ['ui'],
    } }) };
  return { executor, context, events, creates, posts, preview, births, invites, approvals, workflowAdmissions, sourceCost };
}

describe('Second opinion canonical Action composition', () => {
  it('selects one source for preview and rereads one for fresh Ask among 210 committed messages', async () => {
    const longPath = `/work/${'nested-review-source/'.repeat(96)}answer.ts`;
    let sourceText = Array.from({ length: 2048 }, (_, index) => `Source line ${index}: ${longPath}`).join('\n');
    const f = fixture({ sourceMessageCount: 210, sourceText: () => sourceText });
    expect(await f.executor.execute('discussion.second_opinion.start', request, f.context)).toMatchObject({ ok: true,
      result: { status: 'preview', sourceText } });
    expect(f.creates).toHaveLength(0);
    expect(f.births).toHaveLength(0);
    sourceText += '\nFreshly read source answer';
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask',
      confirmedPreview: f.preview() }, f.context)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0]).toMatchObject({ firstMessage: { content: { parts: [{ t: 'text', text: sourceText }] } } });
    expect(f.sourceCost).toEqual({ reads: 2, rows: 2 });
    expect(f.births).toHaveLength(0);
    expect(f.invites).toHaveLength(1);
    expect(f.posts).toHaveLength(1);
  });
  it('does not use a preview quote after source admission is revoked before Ask', async () => {
    let readable = true;
    const f = fixture({ sourceMessageCount: 210, sourceReadable: () => readable });
    expect(await f.executor.execute('discussion.second_opinion.start', request, f.context)).toMatchObject({ ok: true,
      result: { status: 'preview' } });
    readable = false;
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask',
      confirmedPreview: f.preview() }, f.context)).toMatchObject({ ok: true,
      result: { status: 'pending', errorCode: 'session_access_denied' } });
    expect(f.creates).toEqual([]);
    expect(f.posts).toEqual([]);
  });
  it('previews on CLI under the default policy while retaining explicit Ask and Agent/Voice approval', async () => {
    let nativeConfirmations = 0;
    const f = fixture({ presentUserActionConfirmation: async () => { nativeConfirmations++; return true; } });
    const context = { ...f.context, surface: 'cli' as const, bypassApprovals: false,
      actionCaller: { kind: 'host' as const }, runtimeAccountId: 'alice', actionRequestId: 'cli-preview',
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
    const outcome = await f.executor.execute('discussion.second_opinion.start', request, context);
    expect(outcome, JSON.stringify(outcome))
      .toMatchObject({ ok: true, result: { status: 'preview', sourceText: 'Exact source answer' } });
    expect(f.events).toEqual(['discussion.second_opinion.start', 'read-source']);
    const sameAccountRead = fixture();
    expect(await sameAccountRead.executor.execute('session.transcript.get', { sessionId: 'source', messageId: 'answer' },
      { ...context, authority: 'account_automation' })).toMatchObject({ ok: true,
      result: { items: [{ id: 'answer', text: 'Exact source answer' }] } });
    expect(await f.executor.execute('discussion.second_opinion.start', request,
      { ...context, authority: 'account_automation' })).toMatchObject({ ok: true,
      result: { status: 'preview', sourceText: 'Exact source answer' } });
    for (const surface of ['agent', 'voice'] as const) {
      const automation = await f.executor.execute('discussion.second_opinion.start', request,
        { ...context, surface, authority: 'account_automation' });
      expect(automation).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    }
    expect(f.events).toEqual(['discussion.second_opinion.start', 'read-source', 'discussion.second_opinion.start', 'read-source']);
    const ask = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: f.preview() }, context);
    expect(ask).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(f.approvals.at(-1)).toMatchObject({ actionId: 'discussion.second_opinion.start', actionArgs: { intent: 'ask' } });
    expect(await f.executor.execute('discussion.second_opinion.start', request, { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        'discussion.second_opinion.start': { approvalRequiredSurfaces: ['cli'] },
      } }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await f.executor.execute('discussion.second_opinion.start', request, { ...context, surface: 'ui',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        'discussion.second_opinion.start': { approvalRequiredSurfaces: ['ui'] },
      } }) })).toMatchObject({ ok: true, result: { status: 'preview', sourceText: 'Exact source answer' } });
    expect(nativeConfirmations).toBe(1);
    expect(f.events).toEqual(['discussion.second_opinion.start', 'read-source', 'discussion.second_opinion.start', 'read-source',
      'discussion.second_opinion.start', 'read-source']);
    expect(f.creates).toEqual([]);
  });
  it('previews a people-only Discuss source without requiring an unused reviewer question', async () => {
    const f = fixture({ noReviewers: true });
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, reviewers: [], question: '' }, f.context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'preview', sourceText: 'Exact source answer' } });
    expect(f.creates).toEqual([]);
  });
  it('lets Voice propose ordinary human approval by default, and the user waiver runs it', async () => {
    const approvals: ApprovalRequestV2[] = [];
    const effects: string[] = [];
    const executor = createActionExecutor({
      discussionAction: async ({ actionId }) => { effects.push(actionId); throw new Error('No disclosure before approval'); },
      approvalsCreate: async ({ request: approval }) => {
        approvals.push(ApprovalRequestV2Schema.parse(approval)); return { artifactId: 'voice-opinion-approval' };
      },
    });
    const context = { serverId: 'home', runtimeAccountId: 'alice', actionRequestId: 'voice-request',
      defaultSessionId: 'source', defaultSessionMachineId: 'machine', actionCaller: { kind: 'host' as const },
      surface: 'voice' as const, authority: 'account_automation' as const,
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
    const result = await executor.execute('discussion.second_opinion.start', request, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'voice-opinion-approval' } });
    expect(approvals[0]).toMatchObject({ actionId: 'discussion.second_opinion.start', actionArgs: request, status: 'open' });
    expect(effects).toEqual([]);
    expect(await executor.execute('discussion.second_opinion.start', request, { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'discussion.second_opinion.start': ['voice'] } }) }))
      .not.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(effects.length).toBeGreaterThan(0);
  });
  it('retains Voice source privacy attribution when the actual person approves its preview', async () => {
    let stored: ApprovalRequestV2 | null = null;
    const reads: Array<{ surface: unknown; authority: unknown }> = [];
    const f = fixture();
    const executor = createActionExecutor({
      approvalsCreate: async ({ request: approval }) => { stored = ApprovalRequestV2Schema.parse(approval); return { artifactId: 'voice-preview' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request: next }) => {
        if (!stored) throw new Error('No retained approval');
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(next); return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      discussionAction: async () => ({ ok: true, value: f.preview() }),
      sessionTranscriptGet: async ({ context }) => {
        reads.push({ surface: context.surface, authority: context.authority });
        return { ok: true, sessionId: 'source', items: [{ id: 'answer', createdAt: 1, semanticRole: 'assistant',
          role: 'assistant', kind: 'message', text: 'Exact source answer' }], nextCursor: null, hasMore: false,
          diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
      },
    });
    expect(await executor.execute('discussion.second_opinion.start', request, { serverId: 'home', runtimeAccountId: 'alice',
      actionRequestId: 'voice-preview', actionCaller: { kind: 'host' }, surface: 'voice', authority: 'account_automation',
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(reads).toEqual([]);
    const result = await executor.execute('approval.request.decide', { artifactId: 'voice-preview', decision: 'approve' },
      { serverId: 'home', runtimeAccountId: 'alice', surface: 'ui', authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed',
      execution: { ok: true, result: { status: 'preview' } } } });
    expect(reads).toEqual([{ surface: 'voice', authority: 'present_user' }]);
  });
  it('keeps an approved Agent root at its exact Session publisher instead of rebinding it to the deciding app', async () => {
    let stored: ApprovalRequestV2 | null = null;
    const readStored = () => stored;
    const callers: unknown[] = [];
    const deliveries: Array<{ sessionId: string; message: string }> = [];
    const executor = createActionExecutor({
      sessionSendMessage: async ({ sessionId, message, localId }) => {
        deliveries.push({ sessionId, message }); return { status: 'accepted', localId };
      },
      discussionAction: async ({ context }) => { callers.push(context.actionCaller);
        return { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' }; },
      approvalsCreate: async ({ request: approval }) => { stored = ApprovalRequestV2Schema.parse(approval); return { artifactId: 'agent-preview' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request: next }) => {
        if (!stored) throw new Error('No retained approval');
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(next); return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    expect(await executor.execute('discussion.second_opinion.start', request, { serverId: 'home', runtimeAccountId: 'alice',
      actionRequestId: 'agent-preview', actionCaller: { kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'source', defaultSessionMachineId: 'machine', surface: 'agent', authority: 'account_automation',
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const approval = readStored();
    if (!approval) throw new Error('No retained approval');
    expect(resolveApprovalExecutor(approval)).toEqual({ kind: 'daemon', machineId: 'machine', sessionId: 'source' });
    const result = await executor.execute('approval.request.decide', { artifactId: 'agent-preview', decision: 'approve' },
      { serverId: 'home', runtimeAccountId: 'alice', surface: 'ui', authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed',
      execution: { ok: false, errorCode: 'source_unavailable' } } });
    expect(callers).toEqual([{ kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 }]);
    expect(deliveries).toMatchObject([{ sessionId: 'source' }]);
    expect(JSON.parse(deliveries[0]!.message)).toMatchObject({ artifactId: 'agent-preview', status: 'failed',
      execution: { ok: false, errorCode: 'source_unavailable' } });
  });
  it('previews without grants or create, then explicitly grants and asks through the ordinary Discussion path', async () => {
    const f = fixture({ needsGrant: true });
    const preview = await f.executor.execute('discussion.second_opinion.start', request, f.context);
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, result: { status: 'preview', sourceText: 'Exact source answer' } });
    expect(f.events).toEqual(['discussion.second_opinion.start', 'read-source']);
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: f.preview() }, f.context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'asked', mode: 'ask',
      discussion: { serverId: 'home', discussionId: 'opinion' }, messageRef: { messageId: 'question' }, grantedAccountIds: ['bob'] } });
    expect(f.events.slice(2)).toEqual(['discussion.second_opinion.start', 'read-source', 'session.access.grant.set',
      'discussion.create', 'discussion.invite', 'discussion.post']);
    expect(f.creates[0]).toMatchObject({ creationLocalId: request.retry.creationLocalId,
      anchor: { kind: 'session', sessionId: 'source', messageId: 'answer' },
      firstMessage: { localId: request.retry.quoteLocalId, content: { parts: [{ t: 'text', text: 'Exact source answer' }] } } });
    expect(f.posts[0]).toMatchObject({ localId: request.retry.questionLocalId, replyTarget: { kind: 'message', messageId: 'quote' },
      content: { parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'reviewer' } }, { t: 'text', text: ` ${request.question}` }] } });
  });

  it('honors the previewed source grant for a prospective person', async () => {
    const f = fixture({ needsGrant: true, discussionSourceGap: true });
    const input = { ...request, participants: [{ kind: 'account', accountId: 'bob' }] };
    const shown = await f.executor.execute('discussion.second_opinion.start', input, f.context);
    expect(shown).toMatchObject({ ok: true, result: { status: 'preview', preview: {
      canGrantSource: true, missingDiscussionSourceAccountIds: ['bob'],
    } } });
    expect(f.events).not.toContain('session.access.grant.set');
    expect(resolveDiscussionSecondOpinionSourceGrantsV1(f.preview())).toEqual({ ok: true, accountIds: ['bob'] });
    const asked = await f.executor.execute('discussion.second_opinion.start', {
      ...input, intent: 'ask', confirmedPreview: f.preview(),
    }, f.context);
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, result: { status: 'asked', grantedAccountIds: ['bob'] } });
    expect(f.preview()).toMatchObject({ missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true } });
    expect(f.events.filter(event => event === 'session.access.grant.set')).toHaveLength(1);
    expect(f.creates[0]).toMatchObject({ participants: [{ kind: 'account', accountId: 'bob' }] });
  });

  it('refuses an ungrantable prospective audience before any mutation', async () => {
    const f = fixture({ needsGrant: true, discussionSourceGap: true, canGrantSource: false });
    expect(f.preview()).toMatchObject({ canGrantSource: false, missingDiscussionSourceAccountIds: ['bob'] });
    expect(resolveDiscussionSecondOpinionSourceGrantsV1(f.preview())).toEqual({ ok: false, errorCode: 'discussion_access_forbidden' });
    expect(await f.executor.execute('discussion.second_opinion.start', {
      ...request, intent: 'ask', participants: [{ kind: 'account', accountId: 'bob' }], confirmedPreview: f.preview(),
    }, f.context)).toMatchObject({ ok: false, errorCode: 'discussion_access_forbidden' });
    expect(f.events).not.toContain('session.access.grant.set');
    expect(f.creates).toEqual([]);
  });

  it('does not offer an automatic source grant through people-only Discuss creation', () => {
    const f = fixture({ needsGrant: true, discussionSourceGap: true, noReviewers: true });
    expect(resolveDiscussionSecondOpinionSourceGrantsV1(f.preview())).toEqual({ ok: false, errorCode: 'discussion_access_forbidden' });
  });

  it('admits Ask once and lets the create boundary refuse a grant that did not repair its audience', async () => {
    const f = fixture({ needsGrant: true, discussionSourceGap: true, grantLeavesGap: true, createRefused: true });
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: f.preview() }, f.context))
      .toMatchObject({ ok: true, result: { status: 'pending', stage: 'create', errorCode: 'discussion_access_forbidden' } });
    expect(f.events.filter(event => event === 'session.access.grant.set')).toHaveLength(1);
    expect(f.events.filter(event => event === 'discussion.second_opinion.start')).toHaveLength(1);
    expect(f.creates).toEqual([]);
    expect(f.posts).toEqual([]);
  });

  it.each(['create', 'post'] as const)('rejoins the same resource and question after a lost %s response', async stage => {
    const f = fixture(stage === 'create' ? { lostCreate: true } : { lostPost: true });
    const ask = { ...request, intent: 'ask', confirmedPreview: f.preview() };
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true, result: { status: 'pending', errorCode: 'outcome_unknown' } });
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.creates[0]).toEqual(f.creates[1]);
    if (stage === 'post') expect(f.posts[0]).toEqual(f.posts[1]);
  });

  it('refuses quote-only disclosure and missing source keys before any mutation', async () => {
    const locked = fixture({ sourceReady: false });
    expect(await locked.executor.execute('discussion.second_opinion.start', request, locked.context)).toMatchObject({ ok: false, errorCode: 'encryption_material_unavailable' });
    expect(locked.events).toEqual(['discussion.second_opinion.start']);
    const quote = fixture({ needsGrant: true, quoteOnly: true });
    expect(await quote.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: quote.preview() }, quote.context))
      .toMatchObject({ ok: false, errorCode: 'discussion_access_forbidden' });
    expect(quote.creates).toEqual([]);
    expect(quote.events).not.toContain('session.access.grant.set');
  });

  it.each(['reviewer audience', 'Discussion source gap'])('requires renewed confirmation when the %s expands', async gap => {
    const f = fixture({ ...(gap === 'Discussion source gap' ? { needsGrant: true, discussionSourceGap: true } : {}) });
    const confirmed = f.preview();
    if (gap === 'Discussion source gap') confirmed.missingDiscussionSourceAccountIds = [];
    else confirmed.reviewers[0]!.audienceAccountIds = ['alice'];
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: confirmed }, f.context))
      .toMatchObject({ ok: true, result: { status: 'preview_changed' } });
    expect(f.creates).toEqual([]);
  });
  it('rejoins a committed source grant after its response is lost without inventing another recipient', async () => {
    const f = fixture({ needsGrant: true, discussionSourceGap: true, lostGrant: true });
    const ask = { ...request, intent: 'ask', participants: [{ kind: 'account', accountId: 'bob' }], confirmedPreview: f.preview() };
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true,
      result: { status: 'pending', stage: 'grant', errorCode: 'outcome_unknown' } });
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true,
      result: { status: 'asked' } });
    expect(f.events.filter(event => event === 'session.access.grant.set')).toHaveLength(1);
    expect(f.creates).toHaveLength(1);
  });

  it('finds the exact committed source beyond the first page and never accepts truncated source text', async () => {
    const f = fixture({ sourcePages: 'paged' });
    expect(await f.executor.execute('discussion.second_opinion.start', request, f.context)).toMatchObject({ ok: true,
      result: { status: 'preview', sourceText: 'Exact source answer' } });
    const truncated = fixture({ sourcePages: 'truncated' });
    expect(await truncated.executor.execute('discussion.second_opinion.start', request, truncated.context)).toMatchObject({ ok: false,
      errorCode: 'discussion_content_unavailable' });
    expect(truncated.creates).toEqual([]);
  });

  it('asks a selected model only after its ordinary Session is allocated and targets that exact Session', async () => {
    const reviewer: DiscussionSecondOpinionReviewerV1 = { participantSlotId: 'opinion-reviewer-slot', selection: { kind: 'model', launch: {
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/work' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agents', localId: 'reviewer' } }, permissionMode: 'read-only',
    } } };
    const f = fixture({ reviewer });
    const ask = { ...request, reviewers: [reviewer], intent: 'ask', confirmedPreview: f.preview() };
    const result = await f.executor.execute('discussion.second_opinion.start', ask, f.context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.births).toHaveLength(1);
    expect(f.births[0]).toMatchObject({ discussionParticipant: { discussionId: 'opinion', participantSlotId: 'opinion-reviewer-slot' } });
    expect(f.births[0]?.initialInput).toBeUndefined();
    const publicSpawn = f.births[0]?.admittedInput;
    expect(readDiscussionSecondOpinionModelChildV1(ask, 'machine', publicSpawn)).toMatchObject({
      spawn: { creationKey: 'opinion-reviewer-slot', initialTriggers: [],
        discussionParticipant: { discussionId: 'opinion', participantSlotId: 'opinion-reviewer-slot' } },
    });
    expect(readDiscussionSecondOpinionModelChildV1(ask, 'machine', { ...publicSpawn,
      initialInput: { text: 'unreviewed work' } })).toBeNull();
    expect(f.posts[0]).toMatchObject({ content: { parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'allocated-reviewer' } },
      { t: 'text', text: ` ${request.question}` }] } });
  });
  it('admits the actual publishing Agent Session as a speaker without addressing it or forging a different publisher', async () => {
    const f = fixture({ publisherSessionId: 'source' });
    const context = { ...f.context, actionCaller: { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 } };
    const outcome = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: f.preview() }, context);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.invites[0]).toMatchObject({ participant: { kind: 'session', sessionId: 'source' }, answerPolicy: 'when_addressed' });
    expect(f.posts[0]).toMatchObject({ content: { parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'reviewer' } },
      { t: 'text', text: ` ${request.question}` }] } });
    const foreign = fixture({ publisherSessionId: 'foreign' });
    expect(await foreign.executor.execute('discussion.second_opinion.start', request, context)).toMatchObject({ ok: false,
      errorCode: 'invalid_action_output' });
    expect(foreign.creates).toEqual([]);
  });
  it('withholds source text from an invoking Agent whose own runtime audience was not admitted', async () => {
    const f = fixture({ publisherSessionId: 'source', publisherDisclosure: false });
    const context = { ...f.context, actionCaller: { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 } };
    expect(await f.executor.execute('discussion.second_opinion.start', request, context)).toMatchObject({ ok: false,
      errorCode: 'discussion_access_forbidden' });
    expect(f.events).not.toContain('read-source');
    expect(f.creates).toEqual([]);
  });
  it('opens a revision-qualified Doc passage through its real source Action and refuses a fabricated quote', async () => {
    const ref = { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' };
    const revision = { headerVersion: 1, bodyVersion: 2 };
    const source = { kind: 'doc_passage' as const, passage: { ref, revision, range: { start: 9, end: 18 }, quote: 'Read this' } };
    const artifact = ArtifactDocumentV1Schema.parse({ artifactId: 'doc', ownerAccountId: 'alice', access: 'owner',
      header: { title: 'Notes', kind: 'markdown' }, body: '# Notes\n\nRead this.', revision,
      publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 1 });
    const f = fixture();
    const executor = createActionExecutor({
      discussionAction: async ({ actionId }) => {
        // Doc reads also project current readable passage-thread counts.
        if (actionId === 'discussion.list') return { v: 1, serverId: 'home', discussions: [], nextCursor: null, incomplete: false };
        if (actionId !== 'discussion.second_opinion.start') throw new Error('Preview must not write');
        return { ok: true, value: { ...f.preview(), source: { kind: 'doc_passage', doc: { ref, revision } } } };
      },
      artifactAction: async ({ actionId }) => {
        if (actionId !== 'artifact.get') throw new Error('Preview must not write');
        return { artifact };
      },
    });
    expect(await executor.execute('discussion.second_opinion.start', { ...request, source }, f.context)).toMatchObject({ ok: true,
      result: { status: 'preview', sourceText: 'Read this' } });
    expect(await executor.execute('discussion.second_opinion.start', { ...request,
      source: { ...source, passage: { ...source.passage, quote: 'Invented!' } } }, f.context)).toMatchObject({ ok: false,
      errorCode: 'discussion_content_unavailable' });
  });
  it('exposes one admitted Action with dangerous disclosure defaults on every public surface', () => {
    const parsed = ActionIdSchema.safeParse('discussion.second_opinion.start');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const spec = getActionSpec(parsed.data);
    expect(spec.safety).toBe('danger');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, cli: true, mcp: true, voice: true });
    expect(spec.inputSchema.safeParse(request).success).toBe(true);
  });

  it.each(['home', 'stack_qa'])('previews two reviewers and starts Fresh opinions through the real Workflow admission owner (%s)', async serverId => {
    const reviewers = [request.reviewers[0], { selection: { kind: 'session' as const, session: { serverId: 'home', sessionId: 'other-reviewer' } } }];
    const f = fixture({ reviewers });
    const context = { ...f.context, serverId };
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, reviewers }, context))
      .toMatchObject({ ok: true, result: { status: 'preview', preview: { reviewers: expect.any(Array) } } });
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', reviewers, confirmedPreview: f.preview(),
      project: { machineId: 'machine', directory: '/repo' } }, context);
    expect(result, JSON.stringify({ result, events: f.events })).toMatchObject({ ok: true, result: { status: 'asked', mode: 'fresh_opinions', runId: expect.any(String) } });
    expect(f.workflowAdmissions).toHaveLength(1);
    expect(f.posts).toEqual([expect.objectContaining({ content: { v: 1, parts: [{ t: 'text', text: request.question }] } })]);
  });
  it('routes a Machine child of the approved Account composite before local Workflow admission', async () => {
    const reviewers = [request.reviewers[0], { selection: { kind: 'session' as const,
      session: { serverId: 'home', sessionId: 'other-reviewer' } } }];
    const routed: string[] = [];
    const f = fixture({ reviewers, routeHostChildAction: async ({ actionId, input, context }) => {
      // Source reads retain this fixture's native transcript transport.
      if (actionId !== 'workflow.run.start') return null;
      routed.push(actionId);
      expect(actionId).toBe('workflow.run.start');
      expect(input).toMatchObject({ source: { kind: 'catalog', workflow: 'builtin:fresh-opinions' } });
      expect(context.externalActionTarget).toEqual({ kind: 'machine', machineId: 'machine',
        project: { machineId: 'machine', directory: '/repo' } });
      return { ok: false, errorCode: 'daemon_fixture_unavailable', error: 'daemon_fixture_unavailable' };
    } });
    const context = { ...f.context, surface: 'cli' as const, runtimeAccountId: 'alice',
      defaultSessionMachineId: 'machine', actionRequestId: 'opinion', bypassApprovals: false };
    expect(await f.executor.execute('approval.request.create', {
      actionId: 'discussion.second_opinion.start', summary: 'Ask reviewers', createdBy: { surface: 'cli' },
      actionArgs: { ...request, intent: 'ask', reviewers, confirmedPreview: f.preview(),
        project: { machineId: 'machine', directory: '/repo' } },
    }, context)).toMatchObject({ ok: true, result: { artifactId: 'opinion-approval-1' } });
    expect(resolveApprovalExecutor(f.approvals[0]!)).toEqual({ kind: 'app', placement: 'account' });
    const result = await f.executor.execute('approval.request.decide', {
      artifactId: 'opinion-approval-1', decision: 'approve',
    }, context);
    expect(result).toMatchObject({ ok: true, result: { execution: { ok: true, result: {
      status: 'pending', stage: 'workflow', errorCode: 'daemon_fixture_unavailable' } } } });
    expect(routed).toEqual(['workflow.run.start']);
    expect(f.workflowAdmissions).toEqual([]);
  });
  it('parses a Machine child input once before routing its admitted value', async () => {
    const reviewers = [request.reviewers[0], { selection: { kind: 'session' as const,
      session: { serverId: 'home', sessionId: 'other-reviewer' } } }];
    const routed: string[] = [];
    const f = fixture({ reviewers, routeHostChildAction: async ({ actionId }) => {
      if (actionId !== 'workflow.run.start') return null;
      routed.push(actionId);
      return { ok: false, errorCode: 'daemon_fixture_unavailable', error: 'daemon_fixture_unavailable' };
    } });
    // Observe real admission; no schema behavior is substituted. Approval
    // presentation is outside this child invocation's parse cost contract.
    const parse = vi.spyOn(getActionSpec('workflow.run.start').inputSchema, 'safeParse');
    try {
      const result = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask',
        reviewers, confirmedPreview: f.preview(), project: { machineId: 'machine', directory: '/repo' } }, f.context);
      expect(result).toMatchObject({ ok: true, result: { status: 'pending', stage: 'workflow' } });
      expect(routed).toEqual(['workflow.run.start']);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(f.workflowAdmissions).toEqual([]);
    } finally { parse.mockRestore(); }
  });
  it.each([false, true])('routes only the admitted transformed Machine child (invalid: %s)', async invalid => {
    const reviewers = [request.reviewers[0], { selection: { kind: 'session' as const,
      session: { serverId: 'home', sessionId: 'other-reviewer' } } }];
    const routed: string[] = [];
    const f = fixture({ reviewers,
      interceptActionExecution: async ({ actionId, input }) => ({ status: 'continue',
        input: actionId === 'workflow.run.start' && typeof input === 'object' && input !== null
          ? { ...input, ...(invalid ? { runId: 'invalid' } : { inputs: { admitted: 'transformed' } }) } : input }),
      routeHostChildAction: async ({ actionId, input, context }) => {
        if (actionId !== 'workflow.run.start') return null;
        routed.push(actionId);
        expect(input).toMatchObject({ inputs: { admitted: 'transformed' } });
        expect(context.externalActionTarget).toMatchObject({ kind: 'machine', machineId: 'machine' });
        return { ok: false, errorCode: 'daemon_fixture_unavailable', error: 'daemon_fixture_unavailable' };
      },
    });
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask',
      reviewers, confirmedPreview: f.preview(), project: { machineId: 'machine', directory: '/repo' } }, f.context);
    expect(result).toMatchObject({ ok: true, result: { status: 'pending', stage: 'workflow',
      errorCode: invalid ? 'invalid_parameters' : 'daemon_fixture_unavailable' } });
    expect(routed).toEqual(invalid ? [] : ['workflow.run.start']);
    expect(f.workflowAdmissions).toEqual([]);
  });
  it.each(['local', 'routed'] as const)('gives sibling Machine children stable distinct request identities on %s retry', async placement => {
    const reviewers = ['reviewer-a', 'reviewer-b'].map(participantSlotId => ({ participantSlotId,
      selection: { kind: 'model' as const, launch: { executionTarget: { serverId: 'home', machineId: 'machine' },
        directory: { kind: 'path' as const, path: '/repo' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agents', localId: 'reviewer' } }, permissionMode: 'read-only' as const } } }));
    const routed: Array<{ requestId: string | undefined; input: unknown }> = [];
    const routeHostChildAction: ActionExecutorDeps['routeHostChildAction'] = async ({ actionId, input, context }) => {
      if (actionId !== 'session.spawn_new') return null;
      routed.push({ requestId: context.actionRequestId, input });
      // Host child routing returns the public Action projection, unlike the native spawn transport above.
      return { ok: true, result: projectSessionSpawnNewActionResultV1({ type: 'success', disposition: 'rejoined', sessionId: `allocated-reviewer-${routed.length % reviewers.length}`,
        executionTarget: { serverId: 'home', machineId: 'machine' }, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' } }) };
    };
    const f = fixture({ reviewers, needsGrant: true, ...(placement === 'routed' ? { routeHostChildAction } : {}) });
    const context = { ...f.context, actionRequestId: 'two-model-reviewers' };
    const input = { ...request, intent: 'ask', reviewers, confirmedPreview: f.preview(), project: { machineId: 'machine', directory: '/repo' } };
    for (let retry = 0; retry < 2; retry++) {
      const result = await f.executor.execute('discussion.second_opinion.start', input, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'asked' } });
    }
    const identities = placement === 'routed' ? routed.map(child => child.requestId) : f.births.map(child => child.actionRequestId);
    expect(identities).toHaveLength(4);
    expect(identities[0]).toEqual(expect.any(String));
    expect(identities[0]).not.toBe(context.actionRequestId);
    expect(identities[1]).not.toBe(identities[0]);
    expect(identities.slice(2)).toEqual(identities.slice(0, 2));
  });
  it('requires multi-reviewer Workflow placement before source grants or Discussion mutations', async () => {
    const reviewers = [request.reviewers[0], { selection: { kind: 'session' as const, session: { serverId: 'home', sessionId: 'other-reviewer' } } }];
    const f = fixture({ reviewers });
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', reviewers, confirmedPreview: f.preview() }, f.context))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(f.events).toEqual([]);
    expect(f.creates).toHaveLength(0);
    expect(f.workflowAdmissions).toHaveLength(0);
  });
  it('keeps child policy admission ahead of the host Machine handoff', async () => {
    const reviewers = [request.reviewers[0], { selection: { kind: 'session' as const,
      session: { serverId: 'home', sessionId: 'other-reviewer' } } }];
    const routed: string[] = [];
    const f = fixture({ reviewers, routeHostChildAction: async ({ actionId }) => {
      if (actionId !== 'workflow.run.start') return null;
      routed.push(actionId);
      return { ok: false, errorCode: 'daemon_fixture_unavailable', error: 'daemon_fixture_unavailable' };
    } });
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask',
      reviewers, confirmedPreview: f.preview(), project: { machineId: 'machine', directory: '/repo' } }, {
      ...f.context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { 'workflow.run.start': { enabled: false } } }),
    });
    expect(result).toMatchObject({ ok: true, result: { status: 'pending', stage: 'workflow', errorCode: 'action_disabled' } });
    expect(routed).toEqual([]);
    expect(f.workflowAdmissions).toEqual([]);
  });
});
