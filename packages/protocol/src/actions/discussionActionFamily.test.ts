import { describe, expect, it } from 'vitest';

import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { bindDiscussionActionHttpRequestV1 } from './discussionActionFamily.js';
import * as discussionFamily from './discussionActionFamily.js';
import { bindHomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { buildDiscussionMutationRequestBodyV1 } from '../discussions/api.js';
import { DiscussionAccessGrantRemoveRequestV1Schema } from '../discussions/access.js';
import { DiscussionMessagesQueryV1Schema } from '../discussions/query.js';
import { DiscussionOpenedMessageV1Schema } from '../discussions/actions.js';
import { DiscussionMessageV1Schema } from '../discussions/models.js';
import { createDiscussionMessageRefV1, DiscussionMessageRefV1Schema } from '../discussions/messageRefs.js';

describe('Home Discussion Action identity', () => {
  it.each(['discussion.attachment.remove', 'artifact.revisions.trim'] as const)('requires agent approval for %s', actionId => {
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
      context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
  });

  it('binds an attachment read to its committed Discussion message and exact blob', () => {
    const input = { discussionId: 'discussion/one', messageId: 'message/two',
      blobId: 'aee3c9c8-18d8-4e40-9b23-3ab21b67b7ca', throughSeq: 7 };
    expect(ActionIdSchema.safeParse('discussion.attachment.read').success).toBe(true);
    const bound = bindDiscussionActionHttpRequestV1('discussion.attachment.read', input);
    expect(bound).toEqual({ method: 'GET',
      path: '/v1/discussions/discussion%2Fone/messages/message%2Ftwo/attachments/aee3c9c8-18d8-4e40-9b23-3ab21b67b7ca?throughSeq=7',
      body: undefined });
    const spec = getActionSpec('discussion.attachment.read');
    expect(spec.inputSchema.safeParse({ ...input, path: '/private/unrelated' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, blobId: 'not-an-issued-blob' }).success).toBe(false);
    expect(spec.sideEffectClass).toBe('read');
  });

  it('selects one committed message by ID or private local ID without paging operands', () => {
    for (const selection of [{ messageId: 'message-1' }, { localId: 'private-1' }]) {
      const input = { discussionId: 'thread', ...selection, throughSeq: 7 };
      const bound = bindDiscussionActionHttpRequestV1('discussion.read', input);
      const url = new URL(bound.path, 'https://captured-home.test');
      expect(url.pathname).toBe('/v1/discussions/thread/messages');
      expect(DiscussionMessagesQueryV1Schema.parse(Object.fromEntries(url.searchParams)))
        .toEqual({ ...selection, throughSeq: 7 });
      for (const paging of [{ beforeSeq: 8 }, { afterSeq: 0 }, { limit: 1 }]) {
        expect(getActionSpec('discussion.read').inputSchema.safeParse({ ...input, ...paging }).success).toBe(false);
        expect(DiscussionMessagesQueryV1Schema.safeParse({ ...selection, ...paging }).success).toBe(false);
      }
    }
    const conflicting = { messageId: 'message-1', localId: 'private-1' };
    expect(getActionSpec('discussion.read').inputSchema.safeParse({ discussionId: 'thread', ...conflicting }).success).toBe(false);
    expect(DiscussionMessagesQueryV1Schema.safeParse(conflicting).success).toBe(false);
    expect(DiscussionMessagesQueryV1Schema.safeParse({ messageId: '' }).success).toBe(false);
    expect(DiscussionMessagesQueryV1Schema.safeParse({ localId: '' }).success).toBe(false);
  });

  it('retains Doc preparation scope only on the active list', () => {
    const scope = { anchorDocArtifactId: 'doc-1' };
    expect(getActionSpec('discussion.list').inputSchema.safeParse({ ...scope, state: 'active' }).success).toBe(true);
    const bound = bindDiscussionActionHttpRequestV1('discussion.list', { ...scope, state: 'active' });
    expect(bound.method).toBe('GET');
    const url = new URL(bound.path, 'https://captured-home.test');
    expect(url.pathname).toBe('/v1/discussions');
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...scope, state: 'active' });
    expect(getActionSpec('discussion.get').inputSchema.safeParse({ discussionId: 'thread', ...scope }).success).toBe(false);
    expect(getActionSpec('discussion.read').inputSchema.safeParse({ discussionId: 'thread', ...scope, afterSeq: 0, throughSeq: 1, limit: 1 }).success).toBe(false);
    expect(getActionSpec('discussion.list').inputSchema.safeParse({ ...scope, state: 'archived' }).success).toBe(false);
    expect(getActionSpec('discussion.archive').inputSchema.safeParse({ discussionId: 'thread', ...scope }).success).toBe(false);
    expect(getActionSpec('discussion.pass').inputSchema.safeParse({ discussionId: 'thread', ...scope }).success).toBe(false);
  });
  it('binds strict stored HTTP inputs without losing canonical encryption refinements', () => {
    const body = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'post-1',
      authoredContent: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
      content: { t: 'encrypted', c: 'ciphertext' }, mentionedAccountIds: [],
      requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'a'.repeat(43) } });
    const input = { discussionId: 'question/part', ...body };
    const schema = discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.post');
    const spec = getActionSpec('discussion.post');
    if (!spec.serverTransport) throw new Error('Discussion post transport is required');
    expect(bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: schema, input }))
      .toEqual({ method: 'POST', path: '/v1/discussions/question%2Fpart/messages', body });
    expect(spec.inputSchema.safeParse(input).success).toBe(false);
    expect(schema.safeParse({ ...input, requestEqualityEvidenceV1: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input, producerV1: { kind: 'agent' } }).success).toBe(false);
    const replySchema = discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.reply');
    expect(replySchema.safeParse(input).success).toBe(false);
    expect(replySchema.safeParse({ ...input, replyTarget: { kind: 'message', messageId: 'question-1' } }).success).toBe(true);
    const create = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: 'create-1',
      titleContent: { t: 'plain', v: { title: 'Question' } }, firstMessage: {
        authoredContent: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
        localId: 'first-1', content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Hello' }] } },
        mentionedAccountIds: [],
      } });
    const createSchema = discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.create');
    expect(createSchema.safeParse(create).success).toBe(true);
    expect(createSchema.safeParse({ ...create, creationLocalId: 'first-1' }).success).toBe(false);
    expect(discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.rename')
      .safeParse({ discussionId: 'question', titleContent: { t: 'encrypted', c: 'sealed-title' } }).success).toBe(true);
    expect(discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.leave'))
      .toBe(getActionSpec('discussion.leave').inputSchema);
  });

  it('admits first-class Discussion operations and rejects retired Session-owned operations', () => {
    expect(ActionIdSchema.safeParse('discussion.create').success).toBe(true);
    expect(ActionIdSchema.safeParse('discussion.post').success).toBe(true);
    expect(ActionIdSchema.safeParse('session.discussion.create').success).toBe(false);
    expect(ACTION_IDS.some(id => id.startsWith('session.discussion.'))).toBe(false);
  });

  it('binds the creator retry lookup and exact Home resource path through the declared transport', () => {
    expect(bindDiscussionActionHttpRequestV1('discussion.list', { creationLocalId: 'retry-1' })).toEqual({
      method: 'GET', path: '/v1/discussions?creationLocalId=retry-1', body: undefined,
    });
    expect(bindDiscussionActionHttpRequestV1('discussion.get', { discussionId: 'question/part' })).toEqual({
      method: 'GET', path: '/v1/discussions/question%2Fpart', body: undefined,
    });
    expect(() => bindDiscussionActionHttpRequestV1('discussion.get', {
      discussionId: 'question', sessionId: 'old-parent',
    })).toThrow();
  });

  it('preserves the canonical principal through grant removal and gives self-leave no principal operand', () => {
    const principal = { kind: 'group', teamId: 'team-1', groupId: 'group-1' } as const;
    const removal = bindDiscussionActionHttpRequestV1('discussion.access.grants.remove', {
      discussionId: 'question', principal,
    });
    expect(removal).toEqual({ method: 'DELETE', path: '/v1/discussions/question/access/grants', body: { principal } });
    expect(DiscussionAccessGrantRemoveRequestV1Schema.parse(removal.body)).toEqual({ principal });
    expect(bindDiscussionActionHttpRequestV1('discussion.leave', { discussionId: 'question' }))
      .toEqual({ method: 'POST', path: '/v1/discussions/question/leave', body: {} });
  });

  it('requires an exact reply target while rejecting caller-supplied producer authority', () => {
    const input = { discussionId: 'question', localId: 'reply-1',
      content: { v: 1, parts: [{ t: 'text', text: 'The migration is ready.' }] } };
    const spec = getActionSpec('discussion.reply');
    expect(spec.inputSchema.safeParse(input).success).toBe(false);
    const reply = { ...input, replyTarget: { kind: 'message', messageId: 'committed-question' } };
    expect(spec.inputSchema.safeParse(reply).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...reply, producerV1: { kind: 'agent' } }).success).toBe(false);
    expect(bindDiscussionActionHttpRequestV1('discussion.reply', reply)).toMatchObject({
      method: 'POST', path: '/v1/discussions/question/messages',
      body: { localId: 'reply-1', replyTarget: { kind: 'message', messageId: 'committed-question' } },
    });
  });

  it('keeps executable participant roster results separate from human grants', () => {
    const roster = {
      discussionId: 'question', ownerAccountId: 'owner', access: 'owner', grants: [],
      participants: [{ participant: { kind: 'session', sessionId: 'reviewer' },
        answerPolicy: 'when_addressed', createdAt: 1 }],
    };
    expect(getActionSpec('discussion.participants.list').outputSchema?.safeParse(roster).success).toBe(true);
    expect(getActionSpec('discussion.access.grants.list').outputSchema?.safeParse(roster).success).toBe(false);
    const removal = bindDiscussionActionHttpRequestV1('discussion.participant.remove', {
      discussionId: 'question', participant: { kind: 'session', sessionId: 'reviewer' },
    });
    expect(removal).toEqual({ method: 'DELETE', path: '/v1/discussions/question/participants',
      body: { participant: { kind: 'session', sessionId: 'reviewer' } } });
  });

  it('preserves canonical Session mentions and the strict invitation union', () => {
    const message = { content: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'reviewer' } }] },
      mentionedSessionIds: ['reviewer'] };
    expect(getActionSpec('discussion.post').inputSchema.safeParse({ discussionId: 'question', ...message }).success).toBe(true);
    expect(getActionSpec('discussion.create').inputSchema.safeParse({ title: 'Question', firstMessage: message }).success).toBe(true);
    const invite = getActionSpec('discussion.invite').inputSchema;
    expect(invite.safeParse({ discussionId: 'question', participant: { kind: 'session', sessionId: 'reviewer' },
      answerPolicy: 'when_addressed' }).success).toBe(true);
    expect(invite.safeParse({ discussionId: 'question', participant: { kind: 'account', accountId: 'person' },
      answerPolicy: 'when_addressed' }).success).toBe(false);
    const selected = { discussionId: 'question', participant: { kind: 'session',
      sessionId: { selector: 'discussion', discussionId: 'reviewers' } } };
    expect(invite.safeParse(selected).success).toBe(true);
    expect(discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.invite').safeParse(selected).success).toBe(false);
    expect(() => bindDiscussionActionHttpRequestV1('discussion.invite', selected)).toThrow();
    expect(bindDiscussionActionHttpRequestV1('discussion.invite', { ...selected,
      participant: { kind: 'session', sessionId: 'resolved-reviewer' } })).toEqual({ method: 'POST',
      path: '/v1/discussions/question/participants/invite', body: { participant: { kind: 'session', sessionId: 'resolved-reviewer' } } });
    expect(getActionSpec('discussion.participant.remove').inputSchema.safeParse(selected).success).toBe(false);
    const policySelection = { ...selected, answerPolicy: 'reads_only' };
    expect(getActionSpec('discussion.participant.policy.set').inputSchema.safeParse(policySelection).success).toBe(true);
    expect(discussionFamily.discussionActionHttpWireInputSchemaV1('discussion.participant.policy.set').safeParse(policySelection).success).toBe(false);
    expect(() => bindDiscussionActionHttpRequestV1('discussion.participant.policy.set', policySelection)).toThrow();
    expect(bindDiscussionActionHttpRequestV1('discussion.participant.policy.set', { ...policySelection,
      participant: { kind: 'session', sessionId: 'resolved-reviewer' } })).toEqual({ method: 'PUT',
      path: '/v1/discussions/question/participants/policy', body: {
        participant: { kind: 'session', sessionId: 'resolved-reviewer' }, answerPolicy: 'reads_only' } });
  });

  it('accepts committed reference producer output and keeps identical raw IDs in different Homes distinct', () => {
    const content = { v: 1, parts: [{ t: 'text', text: 'Committed answer' }] } as const;
    const committed = DiscussionMessageV1Schema.parse({
      id: 'message-1', discussionId: 'question', localId: 'post-retry', seq: 1,
      authorAccountId: null, accountActor: null, producerV1: null,
      content: { t: 'plain', v: content }, mentionedAccountIds: [], createdAt: 1,
    });
    const first = createDiscussionMessageRefV1({ serverId: 'home-1', discussionId: 'question' }, committed);
    const other = createDiscussionMessageRefV1({ serverId: 'home-2', discussionId: 'question' }, committed);
    expect(DiscussionMessageRefV1Schema.parse(first)).not.toEqual(other);
    expect(DiscussionOpenedMessageV1Schema.parse({ ...committed, content, messageRef: first }).messageRef).toEqual(first);
    expect(DiscussionOpenedMessageV1Schema.safeParse({ ...committed, content,
      messageRef: { ...first, messageId: 'different-message' },
    }).success).toBe(false);
  });
});
