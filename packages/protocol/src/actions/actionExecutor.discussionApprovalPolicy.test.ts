import { ActionIdSchema } from './actionIds.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { resolveApprovalExecutor } from '../approvals/resolveApprovalExecutor.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import type { DiscussionAnswerPolicyV1 } from '../discussions/participants.js';
import { DiscussionAccessGrantMutationResponseV1Schema } from '../discussions/access.js';
import { DiscussionCreateResultV1Schema } from '../discussions/actions.js';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from './actionExecutor.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { deriveWorkflowSessionInputLocalIdV2 } from '../sessions/messages/sessionInputAdmission.js';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '../sessions/messages/sessionMessageReplyV1.js';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '../workflows/workflowInvocationIdentityV1.js';

const input = { discussionId: 'discussion', localId: 'answer', content: { v: 1 as const,
  parts: [{ t: 'text' as const, text: 'Private draft answer' }] }, replyTarget: { kind: 'message' as const, messageId: 'question' } };
const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_home',
  runtimeAccountId: 'alice', actionRequestId: 'original-answer', defaultSessionId: 'receiver', defaultSessionMachineId: 'machine',
  actionCaller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 },
  actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
    'discussion.post': ['agent'], 'discussion.reply': ['agent'],
  } }) };

function harness(initialPolicy: DiscussionAnswerPolicyV1 = 'drafts_for_approval', overrides: Partial<ActionExecutorDeps> = {}) {
  let policy: DiscussionAnswerPolicyV1 | null = initialPolicy;
  let stored: ApprovalRequestV2 | null = null;
  let policyReads = 0;
  const publications: ActionExecutorContext[] = [];
  // Only HTTP/persistence/current-machine boundaries are replaced. The real
  // Action admission, V2 parser, decision/CAS transition and replay run below.
  const deps: Partial<ActionExecutorDeps> = {

    // Replace the receiving Session transport; admission/replay stay real.
    sessionSendMessage: async ({ localId }) => ({ status: 'accepted', localId }),
    discussionAction: async ({ actionId, context: executionContext }) => {
      if (actionId === 'discussion.participants.list') { policyReads++; return { discussionId: 'discussion', ownerAccountId: 'alice',
        access: 'owner', grants: [], participants: policy === null ? [] : [{ participant: { kind: 'session', sessionId: 'receiver' },
          answerPolicy: policy, createdAt: 1 }] }; }
      publications.push(executionContext);
      return { v: 1, serverId: 'home', messageSeq: 2, message: {
        id: 'answer-message', discussionId: 'discussion', localId: 'answer', seq: 2, authorAccountId: null,
        accountActor: null, producerV1: null, content: input.content, mentionedAccountIds: [], createdAt: 2,
        messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'answer-message' },
      } };
    },
    approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'private-draft' }; },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }) => {
      if (!stored) throw new Error('Missing approval');
      const transition = decideApprovalRequestTransition(stored, request);
      if (!transition.ok) return transition;
      stored = ApprovalRequestV2Schema.parse(request);
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
    ...overrides,
  };
  const executor = createActionExecutor(deps as ActionExecutorDeps);
  return { executor, deps, publications, stored: () => stored, policyReads: () => policyReads,
    setPolicy: (next: DiscussionAnswerPolicyV1 | null) => { policy = next; },
    replaceApproval: (request: ApprovalRequestV2) => { stored = ApprovalRequestV2Schema.parse(request); },
    approve: () => {
      if (!stored) throw new Error('Missing approval');
      const next = ApprovalRequestV2Schema.parse({ ...stored, status: 'approved', updatedAtMs: stored.updatedAtMs + 1,
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: stored.updatedAtMs + 1 } });
      expect(decideApprovalRequestTransition(stored, next)).toMatchObject({ ok: true });
      stored = next;
    } };
}

describe('Discussion direct-user creation policy', () => {
  it('prepares participant policy once for the same admitted dispatch and reads it afresh for a new request', async () => {
    const state = harness('when_addressed');
    const prepared = await state.executor.prepare('discussion.reply', input, context);
    if (prepared.kind !== 'ready') throw new Error('Expected an admitted reply');
    expect(state.policyReads()).toBe(1);
    state.setPolicy('reads_only');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true });
    expect(state.policyReads()).toBe(1);
    expect(state.publications).toHaveLength(1);
    expect(await state.executor.execute('discussion.reply', input, context))
      .toMatchObject({ ok: false, errorCode: 'discussion_answer_policy_denied' });
    expect(state.policyReads()).toBe(2);
    expect(state.publications).toHaveLength(1);
  });
  it.each(['session', 'host'] as const)('hands a private Post decision to its daemon before recording consent on the reviewing client (%s)', async caller => {
    const daemon = harness('drafts_for_approval', {  });
    const publisher: ActionExecutorContext = caller === 'host' ? { ...context, actionCaller: { kind: 'host' },
      discussionReplyReturn: { serverId: 'srv_home', requestLocalId: 'original-input', acceptedTurnId: 'original-turn' } } : context;
    expect(await daemon.executor.execute('discussion.reply', input, publisher))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    let receivedStatus: string | undefined;
    let localWrites = 0;
    const client = createActionExecutor({
      approvalsGet: daemon.deps.approvalsGet,
      approvalsUpdate: async args => { localWrites += 1; return await daemon.deps.approvalsUpdate!(args); },
      isApprovalExecutionOriginCurrent: daemon.deps.isApprovalExecutionOriginCurrent,
      sessionSendMessage: daemon.deps.sessionSendMessage,
      // The host transport is the process boundary. Both sides retain the real
      // approval admission/CAS/replay owner and the same persisted Artifact.
      approvalRequestApprovedReplay: async ({ artifactId, request, decision, context: decidingContext }) => {
        receivedStatus = request.status;
        return await daemon.executor.execute('approval.request.decide', { artifactId, decision: decision ?? 'approve' }, decidingContext);
      },
    });
    const result = await client.execute('approval.request.decide', { artifactId: 'private-draft', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'alice' });
    expect(receivedStatus).toBe('open');
    expect(result).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(localWrites).toBe(0);
    expect(daemon.stored()).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(await client.execute('approval.request.decide', { artifactId: 'private-draft', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'alice' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(daemon.publications).toHaveLength(1);
  });
  it.each(['reject', 'cancel'] as const)('lets the ordinary approval owner %s a person-attributed non-Session Workflow return without Session settlement', async decision => {
    const settlements: unknown[] = [];
    const state = harness('when_addressed', {
      sessionMessageReply: async request => { settlements.push(request); return { ok: false, errorCode: 'unexpected_session_settlement' }; } });
    state.setPolicy(null);
    const producer = { v: 1 as const, kind: 'workflow' as const, runId: 'run', invocationRecordId: 'leaf', invocationAttempt: '0',
      execution: { kind: 'action' as const, actionId: 'plugin:external/check' }, outcome: 'answer' as const };
    const localId = deriveWorkflowDiscussionReplyLocalIdV1(producer);
    const host: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home',
      serverIdentityId: 'srv_home', runtimeAccountId: 'alice', defaultSessionMachineId: 'machine',
      actionCaller: { kind: 'workflowRun', runId: 'run', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
      actionRequestId: localId, actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }),
      actionRequestAttributionV1: { requestRef: 'person-input', requester: { serverId: 'home', accountId: 'alice' },
        persona: { serverId: 'home', sessionId: 'receiver' }, origin: null },
      discussionReplyReturn: { kind: 'workflow_invocation', serverId: 'srv_home', producer,
        origin: { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 } } };
    expect(await state.executor.execute('discussion.reply', { ...input, localId }, host))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await state.executor.execute('approval.request.decide', { artifactId: 'private-draft', decision },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'alice' })).toMatchObject({ ok: true });
    expect(state.stored()).toMatchObject({ status: decision === 'reject' ? 'rejected' : 'canceled' });
    expect(settlements).toEqual([]);
    expect(state.publications).toEqual([]);
  });
  it('keeps default informational return available but refuses personless explicit Ask for non-Session Workflow custody', async () => {
    const state = harness('when_addressed', {  });
    state.setPolicy(null);
    const producer = { v: 1 as const, kind: 'workflow' as const, runId: 'run', invocationRecordId: 'leaf', invocationAttempt: '0',
      execution: { kind: 'action' as const, actionId: 'plugin:external/check' }, outcome: 'answer' as const };
    const localId = deriveWorkflowDiscussionReplyLocalIdV1(producer);
    const host: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home',
      serverIdentityId: 'srv_home', runtimeAccountId: 'alice', defaultSessionMachineId: 'machine',
      actionCaller: { kind: 'workflowRun', runId: 'run', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
      actionRequestId: localId, actionsSettings: normalizeActionsSettingsV1({ v: 1 }),
      discussionReplyReturn: { kind: 'workflow_invocation', serverId: 'srv_home', producer,
        origin: { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 } } };
    expect(await state.executor.execute('discussion.reply', { ...input, localId }, host)).toMatchObject({ ok: true });
    expect(state.publications).toHaveLength(1);
    expect(state.stored()).toBeNull();
    expect(await state.executor.execute('discussion.reply', { ...input, localId }, { ...host,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }) }))
      .toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(state.publications).toHaveLength(1);
    expect(state.stored()).toBeNull();
  });
  it.each(['text', 'typed'] as const)('lets an exact host Workflow original reach the trusted publisher without enrolling its implicit leaf (%s)', async resultKind => {
    const state = harness('when_addressed', {  });
    state.setPolicy(null);
    const workflow = { runId: 'workflow-run', invocationRecordId: 'leaf', invocationAttempt: '0' };
    const requestLocalId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId: workflow.runId, invocationRecordId: workflow.invocationRecordId });
    const marker = { serverId: 'srv_home', requestLocalId, acceptedTurnId: 'leaf-turn', workflow };
    const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'receiver', localId: requestLocalId, acceptedTurnId: 'leaf-turn' });
    const publication = { ...input, localId, ...(resultKind === 'typed' ? { content: { kind: 'workflow_result' as const, value: { checked: true },
      summary: 'Workflow result', source: workflow } } : {}) };
    const host: ActionExecutorContext = { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1 }),
      actionCaller: { kind: 'host' }, actionRequestId: localId,
      discussionReplyReturn: marker, sessionInputSource: { sourceSessionId: 'receiver', sourceInputId: requestLocalId,
        sourceTurnId: 'leaf-turn', via: 'action', discussionAddressing: {
          discussionId: 'discussion', messageId: 'question', throughSeq: 1, participantSessionId: 'receiver' } } };
    // This is eligibility to call the existing publisher boundary. Its native
    // original/index/content proof remains mandatory before any append.
    expect(await state.executor.execute('discussion.reply', publication, host)).toMatchObject({ ok: true });
    expect(state.publications).toHaveLength(1);
    expect(await state.executor.execute('discussion.reply', publication, { ...host,
      sessionInputSource: { ...host.sessionInputSource!, sourceInputId: 'another-input' } })).toMatchObject({ ok: false });
    expect(await state.executor.execute('discussion.reply', { ...publication, replyTarget: { kind: 'message', messageId: 'another-question' } }, host))
      .toMatchObject({ ok: false });
    state.setPolicy('reads_only');
    expect(await state.executor.execute('discussion.reply', publication, host)).toMatchObject({ ok: false, errorCode: 'discussion_answer_policy_denied' });
    expect(state.publications).toHaveLength(1);
    state.setPolicy('when_addressed');
    expect(await state.executor.execute('discussion.reply', publication, { ...host, actionsSettings: normalizeActionsSettingsV1({ v: 1,
      actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }) }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(state.publications).toHaveLength(1);
    expect(await state.executor.execute('discussion.post', { discussionId: input.discussionId, localId: 'new-post', content: input.content },
      { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1 }) }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(state.publications).toHaveLength(1);
    state.setPolicy('drafts_for_approval');
    expect(await state.executor.execute('discussion.reply', publication, host))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(state.stored()).toMatchObject({ discussionDraftReview: true });
    expect(state.publications).toHaveLength(1);
  });
  const createInput = { title: 'Release review', creationLocalId: 'create-review',
    firstMessage: { localId: 'first-review', content: { v: 1, parts: [{ t: 'text', text: 'What should we check?' }] } } } as const;
  const message = { id: 'first-message', localId: 'first-review', seq: 1,
    authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null, createdAt: 1 } as const;
  const created = DiscussionCreateResultV1Schema.parse({ v: 1, serverId: 'home', discussion: {
    id: 'discussion', ownerAccountId: 'alice', encryptionMode: 'plain', anchor: null, access: 'owner',
    keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'create-review', title: 'Release review',
    latestMessage: message, messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0,
    recentAuthorAccountIds: ['alice'], archivedAt: null,
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
      sendToSession: true, manageAccess: true, leave: false },
  }, firstMessage: { ...message, discussionId: 'discussion', content: createInput.firstMessage.content, mentionedAccountIds: [],
    messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: message.id } } });

  it('refuses a Doc anchor from a different Home before its creation reaches the host transport', async () => {
    const writes: unknown[] = [];
    const executor = createActionExecutor({ discussionAction: async ({ input }) => { writes.push(input); return created; } });
    const anchor = { kind: 'doc', doc: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'foreign-home' },
      revision: { headerVersion: 1, bodyVersion: 2 } } };
    expect(await executor.execute('discussion.create', { ...createInput, anchor },
      { serverId: 'home', surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(writes).toEqual([]);
    const localAnchor = { ...anchor, doc: { ...anchor.doc, ref: { ...anchor.doc.ref, serverId: 'home' } } };
    expect(await executor.execute('discussion.create', { ...createInput, anchor: localAnchor },
      { serverId: 'home', surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
    expect(writes).toEqual([{ ...createInput, anchor: localAnchor }]);
    const portableAnchor = { ...anchor, doc: { ...anchor.doc, ref: { ...anchor.doc.ref, serverId: 'srv_same_home' } } };
    expect(await executor.execute('discussion.create', { ...createInput, anchor: portableAnchor },
      { serverId: 'local-profile', serverIdentityId: 'srv_same_home', surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: true });
    expect(writes).toHaveLength(2);
  });

  it.each(['agent-session', 'person-cli-global', 'person-cli-contextual'] as const)(
    'retains independently-one initial participants through approval (%s)', async path => {
      const writes: unknown[] = [];
      const h = harness('when_addressed', {
        discussionAction: async ({ input }) => { writes.push(input); return created; } });
      const invocation: ActionExecutorContext = path === 'agent-session' ? context : {
        surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home',
        runtimeAccountId: 'alice', actionCaller: { kind: 'host' }, actionRequestId: `create-${path}`,
        ...(path === 'person-cli-contextual' ? { defaultSessionId: 'receiver', defaultSessionMachineId: 'machine' } : {}),
      };
      const authored = { ...createInput, participants: [
        { kind: 'session', sessionId: 'first' }, { kind: 'session', sessionId: 'second' },
      ] };
      expect(await h.executor.execute('discussion.create', authored, invocation))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(h.stored()).toMatchObject({ actionArgs: authored, executionOriginV1: { sessionTargetsV1: {
        field: 'participants.*.sessionId', targets: [
          { serverId: 'home', sessionId: 'first' }, { serverId: 'home', sessionId: 'second' },
        ], operands: [
          { field: 'participants.0.sessionId', target: { serverId: 'home', sessionId: 'first' } },
          { field: 'participants.1.sessionId', target: { serverId: 'home', sessionId: 'second' } },
        ],
      } } });
      expect(writes).toEqual([]);
      h.approve();
      expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } }))
        .toMatchObject({ ok: true });
      expect(writes).toEqual([authored]);
    });

  it('still refuses a Discussion proposal with no captured Home origin before storage or effect', async () => {
    const h = harness('when_addressed', {  });
    expect(await h.executor.execute('discussion.create', createInput, {
      surface: 'cli', authority: 'present_user', actionRequestId: 'originless-create',
    })).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(h.stored()).toBeNull();
    expect(h.publications).toEqual([]);
  });

  it('creates directly for the present UI user but defers an Agent request to human approval', async () => {
    const approvals: ApprovalRequestV2[] = [];
    const writes: string[] = [];
    // Only the stored HTTP result and approval persistence are system boundaries;
    // catalog normalization, authority admission and approval routing remain real.
    const executor = createActionExecutor({
      discussionAction: async ({ actionId }) => { writes.push(actionId); return created; },
      approvalsCreate: async ({ request }) => {
        approvals.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: 'create-approval' };
      },
    });
    const base = { serverId: 'home', runtimeAccountId: 'alice', actionRequestId: 'create-request',
      defaultSessionId: 'receiver', defaultSessionMachineId: 'machine',
      actionCaller: { kind: 'host' }, actionsSettings: normalizeActionsSettingsV1({ v: 1 }) } as const;
    expect(await executor.execute('discussion.create', createInput,
      { ...base, surface: 'ui', authority: 'present_user' })).toEqual({ ok: true, result: created });
    expect(approvals).toEqual([]);
    expect(writes).toEqual(['discussion.create']);

    expect(await executor.execute('discussion.create', createInput,
      { ...base, surface: 'agent', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'create-approval' } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ actionId: 'discussion.create', actionArgs: createInput,
      approval: { flow: 'deferred' }, status: 'open' });
    expect(writes).toEqual(['discussion.create']);

    expect(await executor.execute('discussion.create', createInput, { ...base, surface: 'agent',
      authority: 'account_automation', actionsSettings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'discussion.create': ['agent'] } }) }))
      .toMatchObject({ ok: true, result: created });
    expect(writes).toEqual(['discussion.create', 'discussion.create']);
  });

  it('routes explicit UI Ask through native confirmation and keeps ownership transfer distinct from archive', () => {
    const ui = { surface: 'ui', authority: 'present_user' } as const;
    const spec = getActionSpec('discussion.create');
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: ui,
      settings: normalizeActionsSettingsV1({ v: 1, actions: {
        'discussion.create': { approvalRequiredSurfaces: ['ui'] },
      } }) })).toMatchObject({ required: false, uiConfirmationRequired: true });
    for (const actionId of ['discussion.archive', 'discussion.restore', 'discussion.leave'] as const) {
      const spec = getActionSpec(actionId);
      expect(resolveActionApprovalRouting({ actionId, spec, context: ui }).required, actionId).toBe(false);
      expect(spec.requiredAuthority, actionId).toBe('present_user');
      expect(resolveActionApprovalRouting({ actionId, spec,
        context: { surface: 'agent', authority: 'account_automation' } }), actionId)
        .toMatchObject({ required: true, flow: 'deferred' });
    }
    const transfer = getActionSpec('discussion.owner.transfer');
    expect(resolveActionApprovalRouting({ actionId: transfer.id, spec: transfer, context: ui }))
      .toMatchObject({ required: false, uiConfirmationRequired: true });
    expect(transfer.requiredAuthority).toBe('present_user');
  });

  it('resolves initial Session slots once before one atomic create and retains concrete approval operands', async () => {
    let selected = 'chosen';
    const writes: unknown[] = [];
    const reads: string[] = [];
    const h = harness('when_addressed', { readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['discussion.create']: { approvalRequiredSurfaces: [context.surface ?? 'ui'] } } }),
      discussionAction: async ({ actionId, input, context }) => {
      if (actionId === 'discussion.participants.list') {
        reads.push(context.serverId!);
        return { discussionId: 'source-discussion', ownerAccountId: 'alice', access: 'owner', grants: [],
          participants: [{ participant: { kind: 'session', sessionId: selected }, answerPolicy: 'when_addressed', createdAt: 1 }] };
      }
      writes.push(input);
      return created;
    } });
    const authored = { ...createInput, participants: [{ kind: 'account', accountId: 'bob' },
      { kind: 'session', sessionId: { selector: 'discussion', discussionId: 'source-discussion' } }] };
    const observations: unknown[] = [];
    const caller = { ...context, surface: 'agent' as const, authority: 'account_automation' as const,
      onSessionTargetsResolved: (resolution: unknown) => { observations.push(resolution); } };
    expect(await h.executor.execute('discussion.create', authored, caller))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const concrete = { ...authored, participants: [{ kind: 'account', accountId: 'bob' }, { kind: 'session', sessionId: 'chosen' }] };
    expect(observations).toMatchObject([{ actionId: 'discussion.create', input: concrete }]);
    expect(h.stored()).toMatchObject({ actionArgs: concrete, executionOriginV1: { sessionTargetsV1: {
      actionId: 'discussion.create', field: 'participants.*.sessionId', targets: [{ serverId: 'home', sessionId: 'chosen' }],
      operands: [{ field: 'participants.1.sessionId', target: { serverId: 'home', sessionId: 'chosen' } }],
    } } });
    expect(writes).toEqual([]);
    selected = 'later';
    h.approve();
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } })).toMatchObject({ ok: true });
    expect(reads).toEqual(['home']);
    expect(writes).toEqual([concrete]);
    expect(observations).toHaveLength(1);
  });

  it('invites from a captured-Home Discussion roster without inventing a default Session', async () => {
    const writes: unknown[] = [];
    const executor = createActionExecutor({ discussionAction: async ({ actionId, input, context }) => {
      expect(context.serverId).toBe('home');
      if (actionId === 'discussion.participants.list') return { discussionId: 'source-discussion', ownerAccountId: 'alice',
        access: 'owner', grants: [], participants: [{ participant: { kind: 'session', sessionId: 'chosen' },
          answerPolicy: 'when_addressed', createdAt: 1 }] };
      writes.push(input);
      return DiscussionAccessGrantMutationResponseV1Schema.parse({ discussionId: 'destination', ownerAccountId: 'alice',
        access: 'owner', grants: [], changed: true });
    } });
    expect(await executor.execute('discussion.invite', { discussionId: 'destination',
      participant: { kind: 'session', sessionId: { selector: 'discussion', discussionId: 'source-discussion' } } },
    { serverId: 'home', surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
    expect(writes).toEqual([{ discussionId: 'destination', participant: { kind: 'session', sessionId: 'chosen' } }]);
  });

  it.each([{ sessionIds: [] }, { sessionIds: ['one', 'two'] }])('requires exactly one Session per authored invitation slot ($sessionIds)', async ({ sessionIds }) => {
    const writes: unknown[] = [];
    const executor = createActionExecutor({ discussionAction: async ({ actionId, input }) => {
      if (actionId === 'discussion.participants.list') return { discussionId: 'source', ownerAccountId: 'alice', access: 'owner', grants: [],
        participants: sessionIds.map(sessionId => ({ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 })) };
      writes.push(input); return created;
    } });
    const participant = { kind: 'session', sessionId: { selector: 'discussion', discussionId: 'source' } };
    for (const [actionId, input] of [['discussion.create', { ...createInput, participants: [participant] }],
      ['discussion.invite', { discussionId: 'destination', participant }]] as const) {
      expect(await executor.execute(actionId, input, { serverId: 'home', surface: 'ui', authority: 'present_user' }))
        .toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch' });
    }
    expect(writes).toEqual([]);
  });

  it('checks every concrete initial Session against the current credential before any create effect', async () => {
    const writes: unknown[] = [];
    const executor = createActionExecutor({ discussionAction: async ({ input }) => { writes.push(input); return created; } });
    expect(await executor.execute('discussion.create', { ...createInput,
      participants: [{ kind: 'session', sessionId: 'allowed' }, { kind: 'session', sessionId: 'denied' }] },
    { serverId: 'home', surface: 'ui', authority: 'present_user', externalActionCredential: {
      accountId: 'alice', principalId: 'principal', credentialId: 'credential', grant: { ...API_TOKEN_FULL_GRANT_V1,
        targets: { sessions: ['allowed'], machines: [] } },
    } })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(writes).toEqual([]);
  });

  it('does not custody a foreign-Home initial Session through explicit approval creation', async () => {
    const h = harness('when_addressed', { resolveSessionReference: async () => ({ kind: 'unique',
      address: { serverId: 'foreign-home', sessionId: 'chosen' } }) });
    const result = await h.executor.execute('approval.request.create', {
      actionId: 'discussion.create', actionArgs: { ...createInput,
        participants: [{ kind: 'session', sessionId: { selector: 'self', of: 'chosen' } }] },
      summary: 'Review invitations', createdBy: { surface: 'cli' },
    }, { ...context, surface: 'ui', authority: 'present_user' });
    expect(result).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(h.stored()).toBeNull();
  });

  it.each(['slot', 'target-list', 'home'] as const)('rejects a reviewed initial operand with changed %s correspondence', async change => {
    const writes: unknown[] = [];
    const h = harness('when_addressed', { readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['discussion.create']: { approvalRequiredSurfaces: [context.surface ?? 'ui'] } } }),
      discussionAction: async ({ input }) => { writes.push(input); return created; } });
    await h.executor.execute('discussion.create', { ...createInput, participants: [{ kind: 'session', sessionId: 'chosen' }] }, context);
    const request = h.stored();
    const snapshot = request?.executionOriginV1.sessionTargetsV1;
    if (!request || !snapshot?.operands) throw new Error('Missing reviewed Session operands');
    h.replaceApproval({ ...request, executionOriginV1: { ...request.executionOriginV1, sessionTargetsV1: {
      ...snapshot,
      ...(change === 'target-list' ? { targets: [{ serverId: 'home', sessionId: 'different' }] } : {}),
      operands: snapshot.operands.map(operand => change === 'slot' ? { ...operand, field: 'participants.0.accountId' }
        : change === 'home' ? { ...operand, target: { ...operand.target, serverId: 'foreign' } } : operand),
    } } });
    h.approve();
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } }))
      .toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
    expect(writes).toEqual([]);
  });
});

describe('Discussion direct-user invitation policy', () => {
  it.each([
    { actionId: 'discussion.invite', input: { discussionId: 'discussion',
      participant: { kind: 'account', accountId: 'bob' } } },
    { actionId: 'discussion.access.grants.set', input: { discussionId: 'discussion',
      principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'edit' } },
    { actionId: 'discussion.participant.policy.set', input: { discussionId: 'discussion',
      participant: { kind: 'session', sessionId: 'reviewer' }, answerPolicy: 'reads_only' } },
    { actionId: 'discussion.participant.remove', input: { discussionId: 'discussion',
      participant: { kind: 'session', sessionId: 'reviewer' } } },
    { actionId: 'discussion.participant.remove', input: { discussionId: 'discussion',
      participant: { kind: 'model', participantSlotId: 'unbound-reviewer' } } },
  ] as const)('admits $actionId directly for the UI user while retaining Agent approval and explicit Ask', async ({ actionId, input }) => {
    const granted = DiscussionAccessGrantMutationResponseV1Schema.parse({ discussionId: 'discussion',
      ownerAccountId: 'alice', access: 'owner', changed: true, grants: [{
        principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'edit',
        createdByAccountId: 'alice', createdAt: 1, display: { name: 'Bob' },
      }] });
    const approvals: ApprovalRequestV2[] = [];
    const writes: string[] = [];
    let confirmations = 0;
    // HTTP and approval storage are the only substituted system boundaries.
    const executor = createActionExecutor({
      presentUserActionConfirmation: async () => { confirmations++; return true; },
      discussionAction: async ({ actionId }) => { writes.push(actionId); return granted; },
      approvalsCreate: async ({ request }) => {
        approvals.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: 'invite-approval' };
      },
    });
    const base = { serverId: 'home', runtimeAccountId: 'alice', actionRequestId: 'invite-request',
      defaultSessionId: 'receiver', defaultSessionMachineId: 'machine',
      actionCaller: { kind: 'host' }, actionsSettings: normalizeActionsSettingsV1({ v: 1 }) } as const;
    expect(await executor.execute(actionId, input, { ...base, surface: 'ui', authority: 'present_user' }))
      .toEqual({ ok: true, result: granted });
    expect(approvals).toEqual([]);
    expect(writes).toEqual([actionId]);

    expect(await executor.execute(actionId, input, { ...base, surface: 'agent', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'invite-approval' } });
    expect(approvals[0]).toMatchObject({ actionId, actionArgs: input, status: 'open', approval: { flow: 'deferred' } });
    expect(writes).toEqual([actionId]);

    expect(await executor.execute(actionId, input, { ...base, surface: 'ui', authority: 'present_user',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: ['ui'] },
      } }) })).toEqual({ ok: true, result: granted });
    expect(approvals).toHaveLength(1);
    expect(confirmations).toBe(1);
    expect(writes).toEqual([actionId, actionId]);

    expect(await executor.execute(actionId, input, { ...base, surface: 'agent', authority: 'account_automation',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: ['agent'] },
      } }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'invite-approval' } });
    expect(approvals).toHaveLength(2);
    expect(writes).toEqual([actionId, actionId]);
  });
});

describe('Discussion participant publication policy', () => {
  it.each(['discussion.post', 'discussion.reply'] as const)('keeps %s private despite ordinary confirmation waiver and bypass', async actionId => {
    const h = harness();
    const result = await h.executor.execute(actionId, input, { ...context, bypassApprovals: true });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'private-draft' } });
    expect(h.publications).toEqual([]);
    expect(h.stored()).toMatchObject({ v: 2, status: 'open', actionId, actionArgs: input,
      discussionDraftReview: true, approval: { flow: 'deferred', result: 'required' },
      executionOriginV1: { caller: context.actionCaller, accountId: 'alice' } });
    const stored = h.stored();
    if (!stored) throw new Error('Missing private draft');
    const { discussionDraftReview: _purpose, ...withoutPurpose } = stored;
    expect(decideApprovalRequestTransition(stored, { ...withoutPurpose, status: 'rejected', updatedAtMs: stored.updatedAtMs + 1,
      decision: { kind: 'reject', decidedAtMs: stored.updatedAtMs + 1 } }))
      .toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
  });

  it('retains the original host return publisher for draft review', async () => {
    const h = harness();
    const result = await h.executor.execute('discussion.reply', input, { ...context, actionCaller: { kind: 'host' },
      discussionReplyReturn: { serverId: 'srv_home', requestLocalId: 'original-input' }, bypassApprovals: true });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(h.publications).toEqual([]);
    expect(resolveApprovalExecutor(ApprovalRequestV2Schema.parse(h.stored()))).toEqual({ kind: 'daemon', machineId: 'machine', sessionId: 'receiver' });
  });

  it('refuses a reads-only or removed participant before creating a draft or publishing', async () => {
    const h = harness('reads_only');
    expect(await h.executor.execute('discussion.reply', input, { ...context, bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'discussion_answer_policy_denied' });
    h.setPolicy(null);
    expect(await h.executor.execute('discussion.reply', input, context))
      .toMatchObject({ ok: false, errorCode: 'discussion_participant_required' });
    expect(h.publications).toEqual([]);
    expect(h.stored()).toBeNull();
  });

  it.each(['session', 'host'] as const)('publishes once from the original %s executor only after a current human review replay', async caller => {
    const h = harness();
    const publicationContext: ActionExecutorContext = caller === 'host' ? { ...context,
      actionCaller: { kind: 'host' }, discussionReplyReturn: { serverId: 'srv_home', requestLocalId: 'original-input' } } : context;
    await h.executor.execute('discussion.reply', input, publicationContext);
    expect(await h.executor.execute('approval.request.decide', { artifactId: 'private-draft', decision: 'approve' },
      { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(h.stored()?.status).toBe('open');
    h.approve();
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(h.publications).toEqual([]);
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toMatchObject({ actionCaller: publicationContext.actionCaller, authority: 'account_automation',
      approvedActionReplay: { artifactId: 'private-draft' }, presentUserApproval: { decidingAccountId: 'alice', actionId: 'discussion.reply' } });
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(h.publications).toHaveLength(1);
  });

  it('declines a private draft through the existing decision transition without publication', async () => {
    const h = harness();
    await h.executor.execute('discussion.reply', input, context);
    expect(await h.executor.execute('approval.request.decide', { artifactId: 'private-draft', decision: 'reject' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'alice' }))
      .toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(h.stored()?.status).toBe('rejected');
    expect(h.publications).toEqual([]);
  });

  it.each([
    { decision: 'reject', policy: 'drafts_for_approval' }, { decision: 'cancel', policy: 'drafts_for_approval' },
    { decision: 'reject', policy: 'when_addressed' }, { decision: 'cancel', policy: 'when_addressed' },
  ] as const)('keeps an addressed $policy draft recoverable until $decision settles', async ({ decision, policy }) => {
    const settlements: unknown[] = [];
    const observedStatuses: unknown[] = [];
    const terminal = decision === 'reject' ? 'rejected' : 'canceled';
    const nativeOutcome = { kind: 'answer', result: { sessionId: 'receiver', messageId: 'native-final' } };
    const publication = { kind: 'failed', failure: { code: decision === 'reject' ? 'approval_rejected' : 'approval_canceled',
      phase: 'action_admission', retryable: false } };
    let loseReplyResponse = true;
    const h = harness(policy, {
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: Object.fromEntries(ActionIdSchema.options.map(actionId => [actionId, { approvalRequiredSurfaces: [context.surface ?? 'ui'] }])) }),
      // Existing authenticated original-input HTTP persistence is the boundary;
      // V2 creation, decision/CAS and terminal retry use the real owners.
      sessionMessageReply: async request => {
        observedStatuses.push(h.stored()?.status);
        // Retried executions rebuild host callbacks; compare the authenticated
        // caller and the exact HTTP settlement, not callback identity.
        settlements.push({ ...request, context: { authority: request.context.authority,
          runtimeAccountId: request.context.runtimeAccountId, actionCaller: request.context.actionCaller } });
        if (loseReplyResponse) {
          loseReplyResponse = false;
          return { ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' };
        }
        return { v: 1, ok: true, progress: { v: 1, mode: 'return', discussion: {
          discussionId: 'discussion', messageId: 'question', throughSeq: 1, participantSessionId: 'receiver',
        }, acceptedTurnId: 'original-turn', disposition: 'released',
          ...(policy === 'drafts_for_approval' ? { outcome: { kind: 'declined' } }
            : { outcome: nativeOutcome, returnPublication: publication }) } };
      },
    });
    await h.executor.execute('discussion.reply', input, { ...context, actionCaller: { kind: 'host' },
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }),
      discussionReplyReturn: { serverId: 'srv_home', requestLocalId: 'original-input', acceptedTurnId: 'original-turn' } });
    const person: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'deciding-device-profile', runtimeAccountId: 'alice' };
    expect(await h.executor.execute('approval.request.decide', { artifactId: 'private-draft', decision }, person))
      .toMatchObject({ ok: false, errorCode: 'server_unreachable' });
    expect(h.stored()?.status).toBe('open');
    expect(observedStatuses).toEqual(['open']);
    expect(settlements).toEqual([{ context: expect.objectContaining({ authority: 'present_user' }),
      sessionId: 'receiver', requestLocalId: 'original-input', serverId: 'srv_home',
      reviewDecision: policy === 'drafts_for_approval'
        ? { kind: 'discussion_review', discussionId: 'discussion', messageId: 'question', acceptedTurnId: 'original-turn', decision }
        : { kind: 'discussion_publication', discussionId: 'discussion', messageId: 'question', acceptedTurnId: 'original-turn',
            approvalArtifactId: 'private-draft', publication } }]);
    expect(h.publications).toEqual([]);
    expect(await h.executor.execute('approval.request.decide', { artifactId: 'private-draft', decision }, person))
      .toMatchObject({ ok: true, result: { status: terminal } });
    expect(h.stored()?.status).toBe(terminal);
    expect(settlements).toHaveLength(2);
    expect(settlements[1]).toEqual(settlements[0]);
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } }))
      .toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
    expect(h.publications).toEqual([]);
  });

  it.each(['reject', 'cancel'] as const)('requires original settlement support before the addressed %s decision', async decision => {
    const h = harness();
    await h.executor.execute('discussion.reply', input, { ...context, actionCaller: { kind: 'host' },
      discussionReplyReturn: { serverId: 'srv_home', requestLocalId: 'original-input' } });
    expect(await h.executor.execute('approval.request.decide', { artifactId: 'private-draft', decision },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'alice' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(h.stored()?.status).toBe('open');
    expect(h.publications).toEqual([]);
  });

  it('rechecks the participant policy after review before executing the publication', async () => {
    const h = harness();
    await h.executor.execute('discussion.reply', input, context);
    h.approve();
    h.setPolicy('reads_only');
    expect(await h.executor.replayApprovedApprovalRequest({ artifactId: 'private-draft', callerAuthority: 'present_user', currentAccount: { accountId: 'alice', serverId: 'home', serverIdentityId: 'srv_home' } }))
      .toMatchObject({ ok: true, result: { status: 'failed' } });
    expect(h.publications).toEqual([]);
  });
});
