import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { DiscussionProducerV1 } from '@happier-dev/protocol/discussions/content';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
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

describe('Workflow production Discussion context', () => {
  beforeEach(() => {
    vi.mocked(axios.request).mockReset();
    vi.mocked(axios.get).mockReset();
    vi.stubGlobal('fetch', async () => Response.json(features));
  });
  afterEach(() => vi.unstubAllGlobals());

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
      addressingMessageId: 'local-1' }, context, discussionAction })).rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
  });

  it.each(['revoked', 'locked'] as const)('refuses current %s access before returning any history', async failure => {
    const state = await fixture('e2ee');
    if (failure === 'revoked') state.revoke(); else state.lock();
    await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin }).resolveDiscussionContext('addressing_message'))
      .rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
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
      .rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
    expect(state.reads).toHaveLength(1);
  });
});
