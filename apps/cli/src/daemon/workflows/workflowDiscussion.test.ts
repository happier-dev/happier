import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { DiscussionProducerV1 } from '@happier-dev/protocol/discussions/content';
import { createWorkflowCoordinator, WorkflowRuntimeInterruption, workflowInvocationKey, type WorkflowCoordinatorInvocation } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { readWorkflowDiscussionContextV1 } from '@happier-dev/protocol/workflows/workflowDiscussionContextV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { createProductionWorkflowDiscussionContextReader, resolveWorkflowDiscussionOrigin } from './workflowDiscussion';

vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, request: vi.fn(), get: vi.fn() } };
});
const discussion = { serverId: 'server-1', discussionId: 'discussion-1' };
const origin = { discussion, messageId: 'question', throughSeq: 2 };
const serverHttpBaseUrl = 'https://workflow-discussion.test';
const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true,
  conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {} });

async function fixture(mode: 'plain' | 'e2ee') {
  const credentials = { token: 'token', encryption: mode === 'plain' ? null
    : { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
  const key = await createResourceDataKey({ credentials, mode });
  const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? { mode: 'plain', ctx: null }
    : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
  let latest = 3;
  let revoked = false;
  let locked = false;
  let revokeAfterFirstPage = false;
  const messages = Array.from({ length: 4 }, (_, i) => ({ id: i === 1 ? 'question' : `message-${i + 1}`,
    discussionId: discussion.discussionId, localId: `local-${i}`, seq: i + 1,
    authorAccountId: 'account', accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null as DiscussionProducerV1 | null,
    content: sealSessionStoredContent({ ...crypto, payload: { v: 1, parts: [{ t: 'text',
      text: i >= 2 ? 'peer sentinel' : `message ${i + 1}` }] } }), mentionedAccountIds: [], createdAt: i + 1 }));
  const reads: URL[] = [];
  vi.mocked(axios.request).mockImplementation(async request => {
    const url = new URL(String(request.url));
    if (url.pathname === '/v1/discussions/discussion-1') return { status: revoked ? 403 : 200, data: { discussion: {
      id: discussion.discussionId, ownerAccountId: 'account', encryptionMode: mode,
      titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Title' } }),
      dataEncryptionKey: locked ? null : key.dataEncryptionKey, keyReadiness: !locked, anchor: null, access: 'owner',
      latestMessage: { id: 'message-3', localId: 'local-2', seq: 3, authorAccountId: 'account',
        accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null, createdAt: 3 },
      creationLocalId: 'creation', messageSeq: latest, lastReadSeq: 0, unreadCount: latest, unreadMentionCount: 0,
      recentAuthorAccountIds: ['account'], archivedAt: null, capabilities: { postMessages: true, rename: true,
        archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    } } };
    if (url.pathname.endsWith('/messages')) {
      reads.push(url);
      const frontier = Math.min(Number(url.searchParams.get('throughSeq') ?? latest), latest);
      const before = Number(url.searchParams.get('beforeSeq') ?? frontier + 1);
      const messageId = url.searchParams.get('messageId');
      const localId = url.searchParams.get('localId');
      if (messageId !== null || localId !== null) {
        const row = messages.find(message => message.seq <= frontier
          && (messageId !== null ? message.id === messageId : message.localId === localId));
        return { status: 200, data: { messages: row ? [row] : [], messageSeq: frontier, hasMoreOlder: false } };
      }
      const row = messages[Math.min(frontier, before - 1) - 1]!;
      latest = 4; // New peer reply arrives between pages.
      if (revokeAfterFirstPage) revoked = true;
      return { status: 200, data: { messages: [row], messageSeq: frontier, hasMoreOlder: row.seq > 1 } };
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  return { credentials, reads, messages, revoke: () => { revoked = true; }, lock: () => { locked = true; },
    revokeAfterFirstPage: () => { revokeAfterFirstPage = true; } };
}

async function contextCoordinatorFixture(sessionContext: Parameters<typeof createWorkflowCoordinator>[0]['sessionContext'],
  discussionAction?: Parameters<typeof createActionExecutor>[0]['discussionAction']) {
  const actionBinding = discussionAction !== undefined;
  const store = createInMemoryWorkflowCoordinatorStore();
  const runId = 'discussion-read-recovery';
  await store.ensureIntent({ key: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }),
    recordId: 'root', runId, blockId: '$root', blockKind: 'root', path: { blockId: '$root', scope: [] },
    attempt: 0, acceptedAtMs: 0, lifecycle: 'running' });
  // Native execution is the boundary; input resolution and coordination stay real.
  const executeStep = vi.fn<Parameters<typeof createWorkflowCoordinator>[0]['executeStep']>(async params => {
    await params.beforeInputAdmission();
    return { kind: 'completed', result: 'answer' };
  });
  const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: 'root', sessionContext,
    ...(actionBinding ? { action: { executor: createActionExecutor({ ...createUnavailableActionTransportDeps(), discussionAction }),
      buildContext: async execution => buildWorkflowActionContext(execution),
      observeRun: async (): Promise<never> => { throw new Error('Input refusal must not start an Action'); } } } : {}),
    executeStep, resolveWorkspace: async () => ({ ok: true,
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }) });
  const executionTarget = { kind: 'session' } as const;
  const mention = { kind: MENTION_KIND_V1.workflowInput, ref: 'workflowInput:0', label: 'Context' };
  const token = formatInlineReferenceTokenV1(mention);
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: actionBinding ? [{ kind: 'action', id: 'answer',
    actionId: 'discussion.rename', input: { discussionId: { kind: 'literal', value: discussion.discussionId },
      title: { kind: 'text', input: [{ kind: 'discussion_context', scope: 'addressing_message' }], document: {
        text: `READY243 context ${token}`, references: [
          { ...mention, token },
        ] } } } }] : [{ kind: 'step', id: 'answer',
    document: { text: 'Answer the question', references: [], attachments: [] },
    input: [{ kind: 'discussion_context', scope: 'addressing_message' }], result: { kind: 'text' } }] };
  const run: Parameters<typeof coordinator.run>[0] = { runId, inputs: {}, executionTarget,
    authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } as const,
    definition, authoredDefinition: definition, frozenChildren: {}, workDepth: 0,
    materializedLeaves: actionBinding ? [{ sourceKey: '$root', blockId: 'answer', kind: 'action', selection: {},
      executionTarget, authoredWorkspace: { kind: 'inherit' }, actionId: 'discussion.rename',
      actionContract: freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec('discussion.rename')))! }] : [{ sourceKey: '$root', blockId: 'answer', kind: 'step',
      selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        conversation: { kind: 'fresh' } }, executionTarget, authoredWorkspace: { kind: 'inherit' } }] };
  return { store, coordinator, executeStep, run };
}

describe('Workflow production Discussion context', () => {
  beforeEach(() => {
    vi.mocked(axios.request).mockReset();
    vi.mocked(axios.get).mockReset();
    vi.stubGlobal('fetch', async () => Response.json(features));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { status: 403, code: 'discussion_read_denied' },
    { status: 503, code: 'database_transaction_timeout' },
  ])('retains the typed Discussion owner refusal while paging context ($code)', async ({ status, code }) => {
    const state = await fixture('plain');
    // The Home HTTP response is the boundary; the Discussion Action, paging
    // reader and production Workflow adapter all remain real.
    vi.mocked(axios.request).mockResolvedValue({ status, data: code === 'database_transaction_timeout'
      ? { error: code, statusCode: 503, transactionOutcome: 'rolled_back' } : { error: code } });
    await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin }).resolveDiscussionContext('addressing_message'))
      .rejects.toMatchObject({ ok: false, errorCode: code });
  });

  it('parks an unavailable Discussion input with its typed cause and resumes the same intent after recovery', async () => {
    const state = await fixture('plain');
    const test = await contextCoordinatorFixture(createProductionWorkflowDiscussionContextReader({
      credentials: state.credentials, serverId: discussion.serverId, serverHttpBaseUrl, origin }));
    vi.mocked(axios.request).mockResolvedValueOnce({ status: 503,
      data: { error: 'database_transaction_timeout', statusCode: 503, transactionOutcome: 'rolled_back' } });
    expect(await test.coordinator.run(test.run)).toEqual({ state: 'interrupted', reason: 'database_transaction_timeout' });
    expect(test.store.readByLogicalInvocation('root')).toMatchObject({ lifecycle: 'needs_attention',
      reason: 'database_transaction_timeout', failureCause: { errorCode: 'database_transaction_timeout', httpStatus: null } });
    expect(test.executeStep).not.toHaveBeenCalled();
    const intent = test.store.list().find(row => row.blockId === 'answer');
    expect(intent).toMatchObject({ lifecycle: 'pending' });
    expect(await test.coordinator.run(test.run)).toMatchObject({ state: 'succeeded' });
    expect(test.store.list().filter(row => row.blockId === 'answer')).toMatchObject([
      { recordId: intent!.recordId, lifecycle: 'completed', result: 'answer', input: { input: [
        { messages: [{ id: 'message-1' }, { id: 'question' }] },
      ] } },
    ]);
  });

  it('leaves a raw storage failure to the existing reclaim owner', async () => {
    const state = await fixture('plain');
    const test = await contextCoordinatorFixture(createProductionWorkflowDiscussionContextReader({
      credentials: state.credentials, serverId: discussion.serverId, serverHttpBaseUrl, origin }));
    const failure = new Error('storage transport failed');
    vi.spyOn(test.store, 'readFrontier').mockRejectedValue(failure);
    await expect(test.coordinator.run(test.run)).rejects.toBe(failure);
    expect(test.store.readByLogicalInvocation('root')).toMatchObject({ lifecycle: 'running' });
  });

  it.each([
    { status: 403, code: 'discussion_read_denied' },
    { status: 404, code: 'discussion_not_found' },
  ])('parks a refused Action context binding without replaying its pending intent ($code)', async ({ status, code }) => {
    const state = await fixture('e2ee');
    const test = await contextCoordinatorFixture(createProductionWorkflowDiscussionContextReader({
      credentials: state.credentials, serverId: discussion.serverId, serverHttpBaseUrl, origin }),
      createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId, serverHttpBaseUrl,
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction);
    // READY243: admission accepted this origin, then the owner transferred the
    // Discussion and left it before the held Action reached its context read.
    vi.mocked(axios.request).mockResolvedValue({ status, data: { error: code } });
    expect(await test.coordinator.run(test.run)).toEqual({ state: 'interrupted', reason: code });
    expect(test.store.readByLogicalInvocation('root')).toMatchObject({ lifecycle: 'needs_attention',
      reason: code, failureCause: { errorCode: code } });
    expect(test.store.list().find(row => row.blockId === 'answer')).toMatchObject({ lifecycle: 'pending', attempt: 0 });
    expect(test.store.list().find(row => row.blockId === 'answer')?.execution).toBeUndefined();
    expect(test.executeStep).not.toHaveBeenCalled();
  });

  it('does not turn an aborted Discussion read into recoverable attention', async () => {
    const state = await fixture('plain');
    const controller = new AbortController();
    const test = await contextCoordinatorFixture(createProductionWorkflowDiscussionContextReader({
      credentials: state.credentials, serverId: discussion.serverId, serverHttpBaseUrl, origin, signal: controller.signal }));
    vi.mocked(axios.request).mockImplementationOnce(async () => {
      controller.abort(new DOMException('Stopped', 'AbortError'));
      return { status: 503, data: { error: 'database_transaction_timeout', statusCode: 503, transactionOutcome: 'rolled_back' } };
    });
    await expect(test.coordinator.run({ ...test.run, signal: controller.signal })).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    expect(test.store.readByLogicalInvocation('root')).toMatchObject({ lifecycle: 'running' });
    expect(test.executeStep).not.toHaveBeenCalled();
  });

  it.each(['plain', 'e2ee'] as const)('opens %s round context through the executing profile and its portable Home', async mode => {
    const state = await fixture(mode);
    const serverIdentityId = 'srv_workflow_home';
    const stableOrigin = { ...origin, discussion: { ...discussion, serverId: serverIdentityId } };
    const discussionAction = createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId,
      serverIdentityId, serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction!;
    const read = (target: typeof stableOrigin) => readWorkflowDiscussionContextV1({ origin: target, scope: 'addressing_message',
      context: { serverId: discussion.serverId, serverIdentityId, surface: 'agent', authority: 'account_automation' }, discussionAction });
    expect(await read(stableOrigin)).toMatchObject({ ok: true, context: { discussion: stableOrigin.discussion,
      messages: [{ id: 'message-1', content: { parts: [{ text: 'message 1' }] } }, { id: 'question' }] } });
    expect(await read({ ...stableOrigin, discussion: { ...discussion, serverId: 'srv_foreign' } }))
      .toEqual({ ok: false, code: 'invalid_reference_scope' });
  });

  it.each(['origin', 'context'] as const)('accepts only the observed stable Home behind a local routing profile (%s)', async boundary => {
    const state = await fixture('plain');
    const serverIdentityId = 'srv_workflow_home';
    const stableOrigin = { ...origin, discussion: { ...discussion, serverId: serverIdentityId } };
    const discussionAction = createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId,
      serverIdentityId, serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction!;
    const read = (target: typeof stableOrigin) => boundary === 'origin'
      ? resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion: target.discussion, addressingMessageId: target.messageId },
        context: { serverId: discussion.serverId, serverIdentityId, surface: 'cli', authority: 'account_automation' }, discussionAction })
      : createProductionWorkflowDiscussionContextReader({ credentials: state.credentials, serverId: discussion.serverId,
        serverIdentityId, serverHttpBaseUrl, origin: target }).resolveDiscussionContext('addressing_message');
    expect(await read(stableOrigin)).toMatchObject({ discussion: stableOrigin.discussion,
      ...(boundary === 'origin' ? { messageId: 'question', throughSeq: 2 } : { messages: [{ id: 'message-1' }, { id: 'question' }] }) });
    await expect(read({ ...stableOrigin, discussion: { ...discussion, serverId: 'srv_foreign' } }))
      .rejects.toMatchObject({ code: 'invalid_reference_scope' });
  });

  it('resolves an external Action publication by its exact invocation identity without Session custody', async () => {
    const state = await fixture('plain');
    const invocation: WorkflowCoordinatorInvocation = { runId: 'run-1', recordId: 'inv-action', key: 'action',
      blockId: 'action', blockKind: 'action', attempt: 2, acceptedAtMs: 1, lifecycle: 'completed', result: { count: 3 },
      path: { blockId: 'action', scope: [] }, execution: { kind: 'action', actionId: 'plugin:external/report',
        actionRequestId: 'action-request', localInputId: 'action-input', input: {} } };
    const identity = { runId: invocation.runId, invocationRecordId: invocation.recordId, invocationAttempt: '2' };
    state.messages[2]!.localId = deriveWorkflowDiscussionReplyLocalIdV1(identity);
    state.messages[2]!.producerV1 = { v: 1, kind: 'workflow', ...identity,
      execution: { kind: 'action', actionId: 'plugin:external/report' }, outcome: 'answer' };
    const discussionAction = createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId,
      serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction!;
    expect(await resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion, addressingMessageId: 'question' },
      context: { serverId: discussion.serverId, surface: 'cli', authority: 'account_automation' }, discussionAction,
      replyTo: { credentials: state.credentials, runId: invocation.runId, invocation } }))
      .toEqual({ discussion, messageId: 'message-3', throughSeq: 3 });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it.each(['plain', 'e2ee'] as const)('resolves the exact %s accepted answer publication instead of its originating question', async mode => {
    const state = await fixture(mode);
    const invocation: WorkflowCoordinatorInvocation = { runId: 'run-1', recordId: 'inv-answer', key: 'answer',
      blockId: 'answer', blockKind: 'step', attempt: 0, acceptedAtMs: 1, lifecycle: 'completed', result: 'exact answer',
      path: { blockId: 'answer', scope: [] }, execution: { kind: 'session', sessionId: 'answerer', localInputId: 'answer-input' } };
    state.messages[2]!.producerV1 = { v: 1, kind: 'agent', sessionId: 'answerer', runId: invocation.runId,
      replyReturn: { serverId: discussion.serverId, requestLocalId: 'answer-input', acceptedTurnId: 'answer-turn',
        workflow: { runId: invocation.runId, invocationRecordId: invocation.recordId, invocationAttempt: '0' }, outcome: 'answer' } };
    let parentId = 'message-3';
    vi.mocked(axios.get).mockImplementation(async () => ({ status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: 'wait', disposition: 'returned', acceptedTurnId: 'answer-turn',
      discussion: { discussionId: discussion.discussionId, messageId: 'question', throughSeq: 2, participantSessionId: 'answerer' },
      workflow: { purpose: 'invocation', runId: invocation.runId, invocationRecordId: invocation.recordId },
      outcome: { kind: 'answer', publicationRef: { kind: 'discussion', discussion: { ...discussion, serverId: 'srv_workflow_home' }, messageId: parentId } },
    } } }));
    const discussionAction = createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId,
      serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction!;
    const resolve = () => resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion, addressingMessageId: 'question' },
      context: { serverId: discussion.serverId, surface: 'cli', authority: 'account_automation' }, discussionAction,
      replyTo: { credentials: state.credentials, runId: invocation.runId, invocation, serverIdentityId: 'srv_workflow_home' } });
    expect(await resolve()).toEqual({ discussion, messageId: 'message-3', throughSeq: 3 });
    parentId = 'question';
    await expect(resolve()).rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
  });

  it.each(['plain', 'e2ee'] as const)('pages actual %s C3 content through the fixed addressing occurrence', async mode => {
    const state = await fixture(mode);
    const reader = createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin });
    const fixed = await reader.resolveDiscussionContext('addressing_message');
    expect(fixed).toMatchObject({ throughSeq: 2, messages: [{ id: 'message-1' }, { id: 'question' }] });
    expect(JSON.stringify(fixed)).not.toContain('peer sentinel');
    expect(state.reads.map(url => url.searchParams.get('throughSeq'))).toEqual(['2', '2']);
    state.reads.length = 0;
    const current = await reader.resolveDiscussionContext('so_far');
    expect(current).toMatchObject({ throughSeq: 4, messages: [
      { id: 'message-1' }, { id: 'question' }, { id: 'message-3' }, { id: 'message-4' },
    ] });
    expect(state.reads.slice(1).every(url => url.searchParams.get('throughSeq') === '4')).toBe(true);
  });

  it('derives start custody from the committed message instead of a local id or current frontier', async () => {
    const state = await fixture('plain');
    const discussionAction = createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId,
      serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction!;
    const context = { serverId: discussion.serverId, surface: 'cli' as const, authority: 'present_user' as const };
    expect(await resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion,
      addressingMessageId: 'question' }, context, discussionAction })).toEqual(origin);
    await expect(resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion,
      addressingMessageId: 'local-1' }, context, discussionAction })).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['revoked', 'locked'] as const)('refuses current %s access before returning any history', async failure => {
    const state = await fixture('e2ee');
    if (failure === 'revoked') state.revoke(); else state.lock();
    await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin }).resolveDiscussionContext('addressing_message'))
      .rejects.toMatchObject({ code: failure === 'revoked' ? 'discussions_unavailable' : 'encryption_material_unavailable' });
    expect(state.reads).toEqual([]);
  });

  it('rejects a foreign or missing Discussion origin without a transport read', async () => {
    const state = await fixture('plain');
    for (const selected of [undefined, { ...origin, discussion: { ...discussion, serverId: 'other-home' } }]) {
      await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
        serverId: discussion.serverId, serverHttpBaseUrl, origin: selected }).resolveDiscussionContext('so_far'))
        .rejects.toMatchObject({ code: 'invalid_reference_scope' });
    }
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('does not return a partial context when access is revoked between history pages', async () => {
    const state = await fixture('plain');
    state.revokeAfterFirstPage();
    await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin }).resolveDiscussionContext('addressing_message'))
      .rejects.toMatchObject({ code: 'discussions_unavailable' });
    expect(state.reads).toHaveLength(1);
  });
});
