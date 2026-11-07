import { describe, expect, it } from 'vitest';
import { SessionMessageReplyAdmissionV1Schema, SessionMessageReplyProgressV1Schema, SessionMessageReplyMutationV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { ChangeKindSchema } from '../changes/index.js';

import {
  SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1 as DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
  SESSION_INPUT_EQUALITY_HKDF_LABEL_V1,
  deriveSessionMutationEqualityTagV1,
} from '../sessions/mutations/sessionMutationEqualityV1.js';
import {
  DISCUSSION_HTTP_PATHS_V1,
  DISCUSSION_AGENT_POST_EVENT_V1,
  buildDiscussionMutationRequestBodyV1,
  DiscussionAgentPostRequestV1Schema,
  DiscussionAgentPostResponseV1Schema,
  DiscussionAgentApprovedReplayPublicationV1Schema,
  DiscussionAgentApprovedReplayResponseV1Schema,
  DiscussionAgentPublisherPublicationV1Schema,
  DiscussionCreateRequestV1Schema,
  DiscussionMessagesQueryV1Schema,
  DiscussionPostRequestV1Schema,
  DiscussionPostResponseV1Schema,
  DiscussionReadRequestV1Schema,
} from './api.js';
import {
  DiscussionOpenedMessageV1Schema,
  DiscussionOpenedSummaryV1Schema,
} from './actions.js';
import {
  DiscussionMessageContentV1Schema,
  DiscussionSelectionSourceV1Schema,
  DiscussionTitleV1Schema,
  DiscussionTitleV1StoredSchema,
  DiscussionAddressV1Schema,
  DiscussionProducerV1Schema,
  DiscussionMessageContentV1StoredSchema,
  readDiscussionMentionedParticipantIdsV1,
  readDiscussionMessagePartsV1,
} from './content.js';
import { areCoordinationMessageRefsEqualV1, areDiscussionMessageRefsEqualV1, CoordinationMessageRefV1Schema,
  createDiscussionMessageRefV1, DiscussionMessageRefV1Schema, parseCoordinationMessageRefV1 } from './messageRefs.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { DiscussionInviteRequestV1Schema, DiscussionMessageAddressingV1Schema } from './participants.js';
import { DiscussionAnchorV1Schema, DiscussionDocPassageReplyTargetV1Schema, DiscussionReplyTargetV1Schema } from './replyTargets.js';
import { DiscussionDocEditProposalContentV1Schema } from './content.js';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { serializeDiscussionMutationEqualityIntentV1 } from './equality.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import {
  DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1,
  DiscussionLatestMessageV1Schema,
  DiscussionMessageV1Schema,
  DiscussionSummaryV1Schema,
} from './models.js';

const plainMessage = {
  localId: 'local-1',
  content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Ship it' }] } },
  mentionedAccountIds: [] as string[],
};

describe('session discussion content', () => {
  it('round-trips channel provenance inside ordinary message content without exposing credentials', () => {
    const content = { v: 1, parts: [{ t: 'text', text: 'Hello from outside' }],
      externalSource: { kind: 'channel', providerPluginId: 'happier.channel.telegram',
        conversationDisplayName: 'Support', senderDisplayName: 'Ada', inputLocalId: 'channels:input-1' } };
    expect(DiscussionMessageContentV1Schema.parse(content)).toEqual(content);
    expect(DiscussionMessageContentV1StoredSchema.parse(content)).toEqual(content);
    expect(readDiscussionMessagePartsV1(DiscussionMessageContentV1Schema.parse(content))).toEqual(content.parts);
    expect(DiscussionMessageContentV1Schema.safeParse({ ...content,
      externalSource: { ...content.externalSource, credentialRef: 'forbidden' } }).success).toBe(false);
  });

  it('admits attachment-only files and complete folder trees through strict writes and tolerant stored reads', () => {
    const file = { blobId: '00000000-0000-4000-8000-000000000001', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) };
    const attachment = { kind: 'folder', id: '00000000-0000-4000-8000-000000000002', name: 'Pictures',
      entries: [{ relativePath: 'nested/photo.png', file }], directories: ['nested', 'empty'] };
    const content = { v: 1, parts: [{ t: 'attachment', attachment }] };
    expect(DiscussionMessageContentV1Schema.safeParse(content).success).toBe(true);
    expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'attachment', attachment: { kind: 'file', id: file.blobId, name: 'photo.png', file } }] }).success).toBe(true);
    const parsed = DiscussionMessageContentV1Schema.parse(content);
    expect(readDiscussionMentionedParticipantIdsV1(parsed)).toEqual({ mentionedAccountIds: [], mentionedSessionIds: [] });
    expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'attachment', attachment: { ...attachment,
      entries: [{ relativePath: '../escape', file }] } }] }).success).toBe(false);
    const extended = { v: 1, parts: [{ t: 'attachment', attachment: { ...attachment,
      entries: [{ relativePath: 'nested/photo.png', file: { ...file, future: true }, future: true }], future: true } }] };
    expect(DiscussionMessageContentV1Schema.safeParse(extended).success).toBe(false);
    expect(DiscussionMessageContentV1StoredSchema.parse(extended)).toEqual(content);
    expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'attachment', attachment: { ...attachment, entries: [], directories: ['empty'] } }] }).success).toBe(true);
    expect(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: parsed, mentionedAccountIds: [] }))
      .not.toBe(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'attachment', attachment: { ...attachment, entries: [{ relativePath: 'nested/photo.png', file: { ...file, sha256: 'b'.repeat(64) } }] } }] }), mentionedAccountIds: [] }));
  });
  it('reads an attributed Workflow result without inventing a Session producer', () => {
    const producer = { v: 1, kind: 'workflow', runId: 'run', invocationRecordId: 'invocation', invocationAttempt: '0',
      execution: { kind: 'action', actionId: 'plugin:external/check' }, outcome: 'answer' };
    expect(DiscussionProducerV1Schema.parse(producer)).toEqual(producer);
    expect(DiscussionProducerV1Schema.safeParse({ ...producer, sessionId: 'fabricated' }).success).toBe(false);
    const publication = { v: 1, operation: 'workflow_result', machineId: 'machine', publication: {
      discussionId: 'discussion', request: { ...plainMessage, replyTarget: { kind: 'message', messageId: 'question' } },
      producer, origin: { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 },
    } };
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.parse(publication)).toEqual(publication);
    expect(DiscussionAgentPostRequestV1Schema.safeParse(publication.publication).success).toBe(false);
  });
  it('keeps the reviewed Machine replay closed and separate from current Session publication', () => {
    const post = { v: 1, sessionId: 'receiver', discussionId: 'discussion', request: plainMessage,
      sourceSession: { sourceSessionId: 'receiver', sourceInputId: 'input', sourceTurnId: 'turn', via: 'action' },
      draftReview: { artifactId: 'approved-private-body', decidingAccountId: 'owner' } };
    const replay = { v: 1, operation: 'approved_replay', machineId: 'owner-machine', publication: post };
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.parse(replay)).toEqual(replay);
    expect(DiscussionAgentPublisherPublicationV1Schema.parse(post)).toEqual(post);
    expect(DiscussionAgentPublisherPublicationV1Schema.safeParse(replay).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse(post).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse({ ...replay, approved: true }).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse({ ...replay, publication: { ...post, draftReview: undefined } }).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse({ ...replay, publication: { ...post, draftReview: { ...post.draftReview, approved: true } } }).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse({ ...replay, publication: { ...post, operation: 'create' } }).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse({ ...replay, publication: { ...post, sourceSession: undefined } }).success).toBe(false);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse({ ...replay, publication: { ...post, sourceSession: undefined,
      replyReturn: { serverId: 'home', requestLocalId: 'input' } } }).success).toBe(true);
    const terminalPublication = { ...post, replyReturn: { serverId: 'home', requestLocalId: 'input', acceptedTurnId: 'turn' },
      terminalReturn: true };
    expect(DiscussionAgentPublisherPublicationV1Schema.parse(terminalPublication)).toEqual(terminalPublication);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.parse({ ...replay, publication: terminalPublication }))
      .toEqual({ ...replay, publication: terminalPublication });
    // Only the verified host publisher can distinguish a final-return notice
    // from an explicit answer; an authored RPC request cannot select it.
    const { draftReview: _review, ...authoredTerminal } = terminalPublication;
    expect(DiscussionAgentPostRequestV1Schema.safeParse(authoredTerminal).success).toBe(false);
    const unknown = { v: 1, ok: false, error: 'outcome_unknown' };
    expect(DiscussionAgentApprovedReplayResponseV1Schema.parse(unknown)).toEqual(unknown);
    expect(DiscussionAgentPostResponseV1Schema.safeParse(unknown).success).toBe(false);
  });
  it('retains only content-free host reply cause with tolerant stored producer reads, never authored attribution', () => {
    const cause = { requestRef: 'original-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'worker' },
      origin: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question' } };
    const producer = { v: 1, kind: 'agent', sessionId: 'worker', actionRequestAttributionV1: cause,
      replyReturn: { serverId: 'home', requestLocalId: 'input', acceptedTurnId: 'turn', outcome: 'answer' } };
    expect(DiscussionProducerV1Schema.parse(producer)).toEqual(producer);
    expect(DiscussionProducerV1Schema.safeParse({ ...producer, arbitrary: true }).success).toBe(false);
    expect(DiscussionProducerV1Schema.safeParse({ ...producer, actionRequestAttributionV1: { ...cause, text: 'private request' } }).success).toBe(false);
    expect(createStoredReadSchema(DiscussionProducerV1Schema).parse({ ...producer, futurePresentation: true })).toEqual(producer);
    expect(DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'worker' })).toEqual({ v: 1, kind: 'agent', sessionId: 'worker' });
    expect(DiscussionPostRequestV1Schema.safeParse({ ...plainMessage, actionRequestAttributionV1: cause }).success).toBe(false);
  });
  it('accepts only the sanitized actor of the host-stamped requester, not an unrelated Account label', () => {
    const cause = { requestRef: 'original-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'worker' }, origin: null };
    const actor = { v: 1, accountId: 'bob', profile: { name: 'Bob Chen', firstName: null, lastName: null, username: null, avatarUrl: null } };
    const message = { id: 'answer', discussionId: 'discussion', localId: null, seq: 2, authorAccountId: 'executor', accountActor: null,
      producerV1: { v: 1, kind: 'agent', sessionId: 'worker', actionRequestAttributionV1: cause }, requesterAccountActor: actor,
      content: plainMessage.content, mentionedAccountIds: [], createdAt: 1 };
    expect(DiscussionMessageV1Schema.parse(message)).toMatchObject({ requesterAccountActor: actor });
    expect(DiscussionOpenedMessageV1Schema.parse({ ...message, content: plainMessage.content.v,
      messageRef: createDiscussionMessageRefV1({ serverId: 'home', discussionId: 'discussion' }, message) }))
      .toMatchObject({ requesterAccountActor: actor, producerV1: { actionRequestAttributionV1: cause } });
    expect(DiscussionMessageV1Schema.safeParse({ ...message, requesterAccountActor: { ...actor, accountId: 'executor' } }).success).toBe(false);
    expect(DiscussionMessageV1Schema.safeParse({ ...message, producerV1: { ...message.producerV1,
      actionRequestAttributionV1: { ...cause, requester: null } } }).success).toBe(false);
    expect(DiscussionMessageV1Schema.safeParse({ ...message, requesterAccountActor: { ...actor,
      profile: { ...actor.profile, email: 'private@example.test' } } }).success).toBe(false);
  });
  it('consumes the canonical Task producer as closed anchor and reply identity without source authority', () => {
    const entry = TriageEntryRefV1Schema.parse({ source: { pluginId: 'acme.tasks', localId: 'issues' },
      kindId: 'task', collisionScope: 'https://tracker.example\u001fproject', entryId: 'PAY-212' });
    const target = { kind: 'task' as const, entry };
    expect(DiscussionAnchorV1Schema.parse(target)).toEqual(target);
    expect(DiscussionReplyTargetV1Schema.parse(target)).toEqual(target);
    const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: 'task-discussion',
      anchor: target, titleContent: { t: 'plain', v: { v: 1, title: 'Discuss privately' } }, firstMessage: {
        ...plainMessage, authoredContent: plainMessage.content.v, replyTarget: target,
      } });
    expect(DiscussionCreateRequestV1Schema.parse(JSON.parse(JSON.stringify(request))))
      .toMatchObject({ anchor: target, firstMessage: { replyTarget: target } });
    for (const invalid of [{ ...target, quote: 'private tracker text' }, { ...target, grants: [] },
      { ...target, entry: { ...entry, sourceInstanceId: 'a-configured-instance' } },
      { ...target, entry: { ...entry, source: { ...entry.source, accountId: 'forged' } } },
      { ...target, entry: { ...entry, entryId: '' } }]) {
      expect(DiscussionAnchorV1Schema.safeParse(invalid).success).toBe(false);
      expect(DiscussionReplyTargetV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
  it('projects a proposal reason for previews without copying its reviewed Doc text', () => {
    const before = 'Private original passage';
    const after = 'Private replacement passage';
    const content = DiscussionDocEditProposalContentV1Schema.parse({ kind: 'doc_edit_proposal', proposal: {
      target: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' },
        revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: before.length }, quote: before },
      baseRevision: { headerVersion: 1, bodyVersion: 1 }, before, after, reason: 'Clarify retries',
    } });
    expect(readDiscussionMessagePartsV1(content, 'preview')).toEqual([{ t: 'text', text: 'Clarify retries' }]);
    // Full human read/copy consumers retain the authored proposal; only preview is summarized.
    expect(readDiscussionMessagePartsV1(content)).toEqual([{ t: 'text', text: `${before}\n${after}\nClarify retries` }]);
  });

  it('retains typed external references as closed authored data without executable addressing', () => {
    const reference = { kind: 'happier.composerReference', ref: 'composerReference:issue-42',
      token: '[Reviewer](happier-ref:composerReference:issue-42)', label: 'Reviewer',
      composerReference: { pluginId: 'acme.issues', localId: 'issues' }, composerReferenceTrigger: '@' };
    const content = { v: 1, parts: [{ t: 'reference', reference }] };
    expect(DiscussionMessageContentV1Schema.parse(content)).toEqual(content);
    expect(readDiscussionMentionedParticipantIdsV1(DiscussionMessageContentV1Schema.parse(content)))
      .toEqual({ mentionedAccountIds: [], mentionedSessionIds: [] });
    for (const forged of [{ ...reference, participant: { kind: 'session', sessionId: 'reviewer' } },
      { ...reference, composerReference: { ...reference.composerReference, accountId: 'forged' } },
      { ...reference, ref: 'malformed' }]) {
      expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'reference', reference: forged }] }).success).toBe(false);
    }
    expect(DiscussionMessageContentV1StoredSchema.parse({ v: 1, future: 'inert', parts: [{ t: 'reference', reference: {
      ...reference, future: 'inert', composerReference: { ...reference.composerReference, future: 'inert' },
    } }] })).toEqual(content);
  });

  it('retains an exact Home-qualified Doc anchor without admitting source content or grants', () => {
    const doc = { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' },
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const anchor = { kind: 'doc', doc };
    expect(DiscussionAnchorV1Schema.parse(anchor)).toEqual(anchor);
    expect(DiscussionCreateRequestV1Schema.parse({ creationLocalId: 'create-doc', anchor,
      titleContent: { t: 'plain', v: { v: 1, title: 'About this Doc' } }, firstMessage: plainMessage })).toMatchObject({ anchor });
    for (const invalid of [{ ...anchor, quote: 'private source' }, { ...anchor, grants: [] },
      { ...anchor, doc: { ...doc, range: { start: 0, end: 1 } } },
      { ...anchor, doc: { ...doc, revision: { bodyVersion: 3 } } },
      { ...anchor, doc: { ...doc, ref: { kind: 'doc', artifactId: 'doc' } } }]) {
      expect(DiscussionAnchorV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
  it('keeps a retained Doc-root retry equal when its anchor is derived from the same first-message source', () => {
    const doc = { ref: { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' },
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const original = { kind: 'create' as const, title: { v: 1 as const, title: 'About this Doc' }, firstMessage: {
      localId: 'first-doc', content: { kind: 'doc_passage_comment' as const,
        passage: { ...doc, range: { start: 0, end: 3 }, quote: 'old' }, content: plainMessage.content.v },
      mentionedAccountIds: [], replyTarget: { kind: 'doc_passage' as const, doc },
    } };
    const previous = serializeDiscussionMutationEqualityIntentV1(original);
    expect(serializeDiscussionMutationEqualityIntentV1({ ...original, anchor: { kind: 'doc', doc } })).toBe(previous);
    expect(serializeDiscussionMutationEqualityIntentV1({ ...original,
      anchor: { kind: 'doc', doc: { ...doc, revision: { ...doc.revision, bodyVersion: 4 } } } })).not.toBe(previous);
    expect(serializeDiscussionMutationEqualityIntentV1({ ...original,
      anchor: { kind: 'doc', doc: { ...doc, ref: { ...doc.ref, artifactId: 'different-doc' } } } })).not.toBe(previous);
  });
  it('preserves the closed host decision on a stored proposal without admitting an authored decision', () => {
    const message = { id: 'm', discussionId: 'd', localId: 'local', seq: 1, authorAccountId: null,
      accountActor: null, producerV1: null, content: { t: 'encrypted', c: 'ciphertext' },
      mentionedAccountIds: [], createdAt: 1 };
    const disposition = { state: 'accepted', acceptedRevision: { headerVersion: 2, bodyVersion: 3 },
      decidedBy: { accountId: 'person', atMs: 2 } };
    const parsed = DiscussionMessageV1Schema.safeParse({ ...message, docEditProposalDispositionV1: disposition });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ docEditProposalDispositionV1: disposition });
    const opened = { ...message, content: plainMessage.content.v,
      messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'd' }, messageId: 'm' } };
    expect(DiscussionOpenedMessageV1Schema.parse({ ...opened,
      docEditProposalDispositionV1: disposition })).toMatchObject({ docEditProposalDispositionV1: disposition });
    for (const invalid of [{ ...disposition, state: 'approved' }, { ...disposition, extra: true },
      { state: 'open', decidedBy: disposition.decidedBy }, { state: 'declined' }]) {
      expect(DiscussionMessageV1Schema.safeParse({ ...message, docEditProposalDispositionV1: invalid }).success).toBe(false);
      expect(DiscussionOpenedMessageV1Schema.safeParse({ ...opened,
        docEditProposalDispositionV1: invalid }).success).toBe(false);
    }
    expect(DiscussionPostRequestV1Schema.safeParse({ ...plainMessage, docEditProposalDispositionV1: disposition }).success).toBe(false);
  });
  it('admits passage comments and proposals through the sealed content grammar with identity-only reply routing', () => {
    const revision = { headerVersion: 1, bodyVersion: 2 };
    const passage = { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' }, revision,
      range: { start: 0, end: 3 }, quote: 'old' };
    const content = { kind: 'doc_edit_proposal', proposal: { target: passage, baseRevision: revision,
      before: 'old', after: 'new', reason: 'clarify' } };
    const replyTarget = { kind: 'doc_passage', doc: { ref: passage.ref, revision } };
    const comment = { kind: 'doc_passage_comment', passage, content: { v: 1, parts: [
      { t: 'text', text: 'Please clarify ' }, { t: 'mention', participant: { kind: 'session', sessionId: 'agent' } },
    ] } };
    expect(DiscussionDocEditProposalContentV1Schema.parse(content)).toEqual(content);
    expect(DiscussionDocPassageReplyTargetV1Schema.parse(replyTarget)).toEqual(replyTarget);
    expect(DiscussionMessageContentV1Schema.parse(content)).toEqual(content);
    expect(DiscussionMessageContentV1Schema.parse(comment)).toEqual(comment);
    expect(DiscussionReplyTargetV1Schema.parse(replyTarget)).toEqual(replyTarget);
    expect(readDiscussionMentionedParticipantIdsV1(DiscussionMessageContentV1Schema.parse(comment)))
      .toEqual({ mentionedAccountIds: [], mentionedSessionIds: ['agent'] });
    expect(readDiscussionMentionedParticipantIdsV1(DiscussionMessageContentV1Schema.parse(content)))
      .toEqual({ mentionedAccountIds: [], mentionedSessionIds: [] });
    expect(DiscussionMessageContentV1StoredSchema.parse({ ...comment, future: true,
      passage: { ...passage, future: true }, content: { ...comment.content, future: true } })).toEqual(comment);
    for (const invalid of [{ kind: 'doc_passage', passage }, { ...replyTarget, quote: passage.quote },
      { ...replyTarget, doc: { ...replyTarget.doc, range: passage.range } },
      { ...replyTarget, doc: { ref: { kind: 'doc', artifactId: 'doc' }, revision } }]) {
      expect(DiscussionReplyTargetV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(DiscussionMessageContentV1Schema.safeParse({ ...comment, content }).success).toBe(false);
    expect(DiscussionMessageContentV1Schema.safeParse({ ...comment, passage: { ...passage, extra: true } }).success).toBe(false);
    expect(DiscussionDocEditProposalContentV1Schema.safeParse({ ...content, disposition: { state: 'accepted' } }).success).toBe(false);
    expect(DiscussionDocEditProposalContentV1Schema.safeParse({ ...content, proposal: { ...content.proposal,
      baseRevision: { ...revision, bodyVersion: 3 } } }).success).toBe(false);
  });
  it('retains a bounded actual Session causal source while rejecting another Session root', () => {
    const sourceSession = { sourceSessionId: 'session-1', sourceTurnId: 'turn-1', sourceInputId: 'input-1', via: 'action' };
    const producer = { v: 1, kind: 'agent', sessionId: 'session-1', sourceSession };
    expect(DiscussionProducerV1Schema.safeParse(producer).success).toBe(true);
    expect(DiscussionProducerV1Schema.safeParse({ ...producer, sourceSession: { ...sourceSession, sourceSessionId: 'other' } }).success).toBe(false);
    expect(DiscussionProducerV1Schema.safeParse({ ...producer, sourceSession: { ...sourceSession, arbitrary: true } }).success).toBe(false);
  });
  it('binds closed Account and Session mention identities without accepting producer authority', () => {
    for (const participant of [{ kind: 'account', accountId: 'acct-1' }, { kind: 'session', sessionId: 'session-1' }]) {
      expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'mention', participant }] }).success).toBe(true);
    }
    for (const participant of [{ kind: 'session', sessionId: 'session-1', accountId: 'acct-1' },
      { kind: 'bot', sessionId: 'session-1' }, { kind: 'session', sessionId: 'session-1', throughSeq: 5 }]) {
      expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'mention', participant }] }).success).toBe(false);
    }
    expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'mention', accountId: 'acct-1' }] }).success).toBe(false);
    expect(DiscussionInviteRequestV1Schema.safeParse({ participant: { kind: 'session', sessionId: 'session-1' }, answerPolicy: 'when_addressed' }).success).toBe(true);
    expect(DiscussionInviteRequestV1Schema.safeParse({ participant: { kind: 'session', sessionId: 'session-1', runtimeAccountId: 'forged' } }).success).toBe(false);
  });
  it('binds encrypted executable routing to the canonical retry intent and rejects caller cutoffs', () => {
    const input = { content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Question' }] }, mentionedAccountIds: [] };
    const first = serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...input, mentionedSessionIds: ['a', 'b'] });
    expect(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...input, mentionedSessionIds: ['b', 'a'] })).toBe(first);
    expect(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...input, mentionedSessionIds: ['a'] })).not.toBe(first);
    expect(DiscussionPostRequestV1Schema.safeParse({ ...plainMessage, addressingV1: { throughSeq: 8, participantSessionIds: ['a'] } }).success).toBe(false);
  });
  it('requires at least one mention or non-blank text run', () => {
    expect(DiscussionMessageContentV1Schema.safeParse({
      v: 1,
      parts: [{ t: 'text', text: '   ' }],
    }).success).toBe(false);
    expect(DiscussionMessageContentV1Schema.safeParse({
      v: 1,
      parts: [{ t: 'mention', participant: { kind: 'account', accountId: 'acct-1' } }],
    }).success).toBe(true);
  });

  it('rejects adjacent and leading empty text parts', () => {
    expect(DiscussionMessageContentV1Schema.safeParse({
      v: 1,
      parts: [{ t: 'text', text: '' }, { t: 'mention', participant: { kind: 'account', accountId: 'acct-1' } }],
    }).success).toBe(false);
    expect(DiscussionMessageContentV1Schema.safeParse({
      v: 1,
      parts: [
        { t: 'text', text: 'hi ' },
        { t: 'mention', participant: { kind: 'account', accountId: 'acct-1' } },
        { t: 'text', text: '' },
      ],
    }).success).toBe(true);
  });

  it('requires NFC normalization and rejects unknown fields', () => {
    expect(DiscussionTitleV1Schema.safeParse({ v: 1, title: 'é' }).success).toBe(false);
    expect(DiscussionTitleV1Schema.safeParse({ v: 1, title: 'é' }).success).toBe(true);
    expect(DiscussionTitleV1Schema.safeParse({ v: 1, title: 'ok', extra: 1 }).success).toBe(false);
  });

  it('drops unfamiliar stored fields without accepting malformed known content', () => {
    expect(DiscussionTitleV1StoredSchema.parse({ v: 1, title: 'Stored', future: { accountId: 'forged' } }))
      .toEqual({ v: 1, title: 'Stored' });
    expect(DiscussionTitleV1StoredSchema.safeParse({ v: 1, title: 42, future: true }).success).toBe(false);
  });

  it('keeps selection provenance bounded, nonempty and deduplicated', () => {
    expect(DiscussionSelectionSourceV1Schema.safeParse({
      kind: 'discussion',
      serverId: 'home-1',
      discussionId: 'disc-1',
      messageIds: [],
    }).success).toBe(false);
    expect(DiscussionSelectionSourceV1Schema.safeParse({
      kind: 'discussion',
      serverId: 'home-1',
      discussionId: 'disc-1',
      messageIds: ['m1', 'm1'],
    }).success).toBe(false);
    expect(DiscussionSelectionSourceV1Schema.safeParse({
      kind: 'discussion',
      serverId: 'home-1',
      discussionId: 'disc-1',
      messageIds: ['m1', 'm2'],
      draftCorrelationId: 'corr-1',
    }).success).toBe(true);
  });
});

describe('session discussion presentation projections', () => {
  const summary = {
    id: 'discussion-1',
    ownerAccountId: 'account-1',
    encryptionMode: 'plain' as const,
    anchor: null,
    access: 'owner' as const,
    keyReadiness: true,
    dataEncryptionKey: null,
    creationLocalId: null,
    titleContent: { t: 'plain' as const, v: { v: 1, title: 'Design review' } },
    latestMessage: {
      id: 'message-1',
      localId: null,
      seq: 4,
      authorAccountId: 'account-4',
      accountActor: null,
      producerV1: null,
      createdAt: 1,
    },
    messageSeq: 4,
    lastReadSeq: null,
    unreadCount: 0,
    unreadMentionCount: 0,
    archivedAt: null,
    capabilities: {
      postMessages: true,
      rename: true,
      archive: true,
      restore: false,
      askAgent: true,
      sendToSession: true,
      manageAccess: true,
      leave: true,
    },
  };

  it('enforces the one three-avatar recent-author projection bound', () => {
    const { titleContent: _titleContent, ...openedSummary } = summary;
    expect(DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1).toBe(3);
    expect(DiscussionSummaryV1Schema.safeParse({
      ...summary,
      recentAuthorAccountIds: ['account-1', 'account-2', 'account-3'],
    }).success).toBe(true);
    expect(DiscussionSummaryV1Schema.safeParse({
      ...summary,
      recentAuthorAccountIds: ['account-1', 'account-2', 'account-3', 'account-4'],
    }).success).toBe(false);
    expect(DiscussionOpenedSummaryV1Schema.safeParse({
      ...openedSummary,
      title: 'Design review',
      recentAuthorAccountIds: ['account-1', 'account-2', 'account-3', 'account-4'],
    }).success).toBe(false);
  });
});

describe('session discussion API schemas', () => {
  it('derives only the proposal initialization marker from authored content before sealing', () => {
    const revision = { headerVersion: 1, bodyVersion: 2 };
    const proposal = DiscussionMessageContentV1Schema.parse({ kind: 'doc_edit_proposal', proposal: {
      target: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' }, revision,
        range: { start: 0, end: 3 }, quote: 'old' }, baseRevision: revision, before: 'old', after: 'new', reason: 'clarify',
    } });
    const requestEqualityEvidenceV1 = { kind: 'e2eeTag' as const, tag: 'A'.repeat(43) };
    const sealed = { t: 'encrypted' as const, c: 'sealed-proposal' };
    const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'proposal', authoredContent: proposal,
      content: sealed, mentionedAccountIds: [], requestEqualityEvidenceV1 });
    expect(post).toMatchObject({ docEditProposal: true, content: sealed });
    const create = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: 'creation',
      titleContent: { t: 'encrypted', c: 'sealed-title' }, creationEqualityEvidenceV1: requestEqualityEvidenceV1,
      firstMessage: { localId: 'first', authoredContent: proposal, content: sealed, mentionedAccountIds: [], requestEqualityEvidenceV1 } });
    expect(create.firstMessage).toMatchObject({ docEditProposal: true });
    const text = DiscussionMessageContentV1Schema.parse(plainMessage.content.v);
    expect(buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'text', authoredContent: text,
      content: { t: 'encrypted', c: 'sealed-text' }, mentionedAccountIds: [], requestEqualityEvidenceV1 })).not.toHaveProperty('docEditProposal');
    expect(DiscussionPostRequestV1Schema.safeParse({ ...post, docEditProposal: false }).success).toBe(false);
    expect(DiscussionPostRequestV1Schema.safeParse({ ...post, docEditProposalDispositionV1: { state: 'open' } }).success).toBe(false);
  });
  it('admits a first-class Discussion AccountChange kind', () => {
    expect(ChangeKindSchema.safeParse('discussion').success).toBe(true);
  });
  it('preserves independent creation participants, anchor and reply targets through the strict mutation builder', () => {
    const input = {
      creationLocalId: 'creation-home-1',
      titleContent: { t: 'plain' as const, v: { v: 1, title: 'Independent' } },
      anchor: { kind: 'session' as const, sessionId: 'source-session', messageId: 'source-message' },
      participants: [{ kind: 'account' as const, accountId: 'invitee' }],
      firstMessage: { ...plainMessage, localId: 'first-home-1' },
    };
    const parsed = DiscussionCreateRequestV1Schema.parse(input);
    expect(buildDiscussionMutationRequestBodyV1({ kind: 'create', ...parsed,
      firstMessage: { ...parsed.firstMessage, authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v) } })).toEqual(input);
    const reply = { ...plainMessage, replyTarget: { kind: 'message' as const, messageId: 'parent-1' } };
    expect(buildDiscussionMutationRequestBodyV1({ kind: 'post', ...reply,
      authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v) })).toEqual(reply);
    expect(DiscussionCreateRequestV1Schema.safeParse({
      ...input, participants: [{ kind: 'account', accountId: 'invitee', accessLevel: 'admin' }],
    }).success).toBe(false);
    expect(DiscussionCreateRequestV1Schema.safeParse({ ...input, ownerAccountId: 'forged' }).success).toBe(false);
    expect(DiscussionPostRequestV1Schema.safeParse({
      ...reply, replyTarget: { ...reply.replyTarget, throughSeq: 999 },
    }).success).toBe(false);
  });

  it('keeps plain creation keyless and pairs encrypted owner material with its current fingerprint', () => {
    const ownerEnvelope = Buffer.alloc(SESSION_DATA_KEY_ENVELOPE_BYTES_V1, 7).toString('base64');
    const fingerprint = `content-public-key-sha256:${'a'.repeat(64)}`;
    const plain = { creationLocalId: 'keyless-create', titleContent: { t: 'plain' as const, v: { v: 1, title: 'Keyless' } }, firstMessage: plainMessage };
    expect(DiscussionCreateRequestV1Schema.safeParse(plain).success).toBe(true);
    expect(DiscussionCreateRequestV1Schema.safeParse({ ...plain, dataEncryptionKey: ownerEnvelope, expectedOwnerContentPublicKeyFingerprint: fingerprint }).success).toBe(false);
    const evidence = { kind: 'e2eeTag' as const, tag: 'A'.repeat(43) };
    const encrypted = {
      creationLocalId: 'encrypted-create', titleContent: { t: 'encrypted' as const, c: 'opaque-title' }, creationEqualityEvidenceV1: evidence,
      firstMessage: { ...plainMessage, content: { t: 'encrypted' as const, c: 'opaque-first' }, requestEqualityEvidenceV1: evidence },
      dataEncryptionKey: ownerEnvelope, expectedOwnerContentPublicKeyFingerprint: fingerprint,
      recipientKeyEnvelopes: [{ recipientAccountId: 'invitee', encryptedDataKey: ownerEnvelope, recipientContentPublicKeyFingerprint: fingerprint }],
    };
    expect(buildDiscussionMutationRequestBodyV1({ kind: 'create', ...encrypted,
      firstMessage: { ...encrypted.firstMessage, authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v) } })).toEqual(encrypted);
    expect(DiscussionCreateRequestV1Schema.safeParse({ ...encrypted, expectedOwnerContentPublicKeyFingerprint: undefined }).success).toBe(false);
    expect(DiscussionCreateRequestV1Schema.safeParse({ ...encrypted, recipientKeyEnvelopes: [...encrypted.recipientKeyEnvelopes, ...encrypted.recipientKeyEnvelopes] }).success).toBe(false);
  });
  it('admits ambient watchers only as a deduplicated subset of committed recipients', () => {
    const snapshot = { throughSeq: 2, participantSessionIds: ['asked', 'watcher'], watcherSessionIds: ['watcher'] };
    expect(DiscussionMessageAddressingV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(DiscussionMessageAddressingV1Schema.safeParse({ ...snapshot, watcherSessionIds: ['stranger'] }).success).toBe(false);
    expect(DiscussionMessageAddressingV1Schema.safeParse({ ...snapshot, watcherSessionIds: ['watcher', 'watcher'] }).success).toBe(false);
  });
  it('owns the complete HTTP path set', () => {
    expect(DISCUSSION_HTTP_PATHS_V1).toEqual({
      collection: '/v1/discussions',
      attention: '/v1/discussions/attention',
      discussion: '/v1/discussions/:discussionId',
      archive: '/v1/discussions/:discussionId/archive',
      restore: '/v1/discussions/:discussionId/restore',
      settings: '/v1/discussions/:discussionId/settings',
      messages: '/v1/discussions/:discussionId/messages',
      upload: '/v1/discussions/upload',
      attachment: '/v1/discussions/:discussionId/messages/:messageId/attachments/:blobId',
      attachmentUpload: '/v1/discussions/attachments/uploads/:uploadId',
      read: '/v1/discussions/:discussionId/read',
      participants: '/v1/discussions/:discussionId/participants',
      invite: '/v1/discussions/:discussionId/participants/invite',
      participant: '/v1/discussions/:discussionId/participants',
      participantPolicy: '/v1/discussions/:discussionId/participants/policy',
      leave: '/v1/discussions/:discussionId/leave',
      ownerTransfer: '/v1/discussions/:discussionId/owner',
      grants: '/v1/discussions/:discussionId/access/grants',
      recipientCensus: '/v1/discussions/:discussionId/data-key/recipients',
      recipientEnvelopes: '/v1/discussions/:discussionId/data-key/envelopes',
    });
  });

  it('builds the exact final create, post, and rename mutation bodies', () => {
    const e2eeEvidence = { kind: 'e2eeTag' as const, tag: 'A'.repeat(43) };
    const create = buildDiscussionMutationRequestBodyV1({
      kind: 'create',
      creationLocalId: 'creation-1',
      creationEqualityEvidenceV1: e2eeEvidence,
      titleContent: { t: 'encrypted', c: 'title-ciphertext' },
      firstMessage: {
        localId: 'message-1',
        authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v),
        requestEqualityEvidenceV1: e2eeEvidence,
        content: { t: 'encrypted', c: 'message-ciphertext' },
        mentionedAccountIds: ['account-1'],
      },
    });
    const post = buildDiscussionMutationRequestBodyV1({
      kind: 'post',
      localId: 'message-2',
      authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v),
      requestEqualityEvidenceV1: e2eeEvidence,
      content: { t: 'encrypted', c: 'post-ciphertext' },
      mentionedAccountIds: ['account-2'],
    });
    const rename = buildDiscussionMutationRequestBodyV1({
      kind: 'rename',
      titleContent: { t: 'plain', v: { v: 1, title: 'Renamed' } },
    });

    expect(create).toEqual({
      creationLocalId: 'creation-1',
      creationEqualityEvidenceV1: e2eeEvidence,
      titleContent: { t: 'encrypted', c: 'title-ciphertext' },
      firstMessage: {
        localId: 'message-1',
        requestEqualityEvidenceV1: e2eeEvidence,
        content: { t: 'encrypted', c: 'message-ciphertext' },
        mentionedAccountIds: ['account-1'],
      },
    });
    expect(create.creationLocalId).not.toBe(create.firstMessage.localId);
    expect(post).toEqual({
      localId: 'message-2',
      requestEqualityEvidenceV1: e2eeEvidence,
      content: { t: 'encrypted', c: 'post-ciphertext' },
      mentionedAccountIds: ['account-2'],
    });
    expect(rename).toEqual({ titleContent: { t: 'plain', v: { v: 1, title: 'Renamed' } } });
  });

  it('does not generate identities or accept misplaced equality evidence', () => {
    expect(() => buildDiscussionMutationRequestBodyV1({
      kind: 'create',
      creationLocalId: undefined as unknown as string,
      titleContent: { t: 'plain', v: { v: 1, title: 'Title' } },
      firstMessage: {
        localId: 'message-1',
        authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v),
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Hello' }] } },
        mentionedAccountIds: [],
      },
    })).toThrow();
    expect(() => buildDiscussionMutationRequestBodyV1({
      kind: 'post',
      localId: 'message-2',
      authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v),
      content: { t: 'encrypted', c: 'ciphertext' },
      mentionedAccountIds: [],
      requestEqualityEvidenceV1: undefined,
    })).toThrow();
  });

  it('keeps discussion creation and first-message retry identities distinct', () => {
    const aliased = {
      creationLocalId: 'same-local-id',
      titleContent: { t: 'plain' as const, v: { v: 1, title: 'Title' } },
      firstMessage: {
        localId: 'same-local-id',
        content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text' as const, text: 'Hello' }] } },
        mentionedAccountIds: [],
      },
    };

    expect(DiscussionCreateRequestV1Schema.safeParse(aliased).success).toBe(false);
    expect(() => buildDiscussionMutationRequestBodyV1({
      kind: 'create',
      ...aliased,
      firstMessage: { ...aliased.firstMessage, authoredContent: DiscussionMessageContentV1Schema.parse(plainMessage.content.v) },
    })).toThrow();
  });

  it('requires e2eeTag equality for encrypted content and refuses a client plain digest', () => {
    expect(DiscussionPostRequestV1Schema.safeParse({
      ...plainMessage,
      content: { t: 'encrypted', c: 'Y2lwaGVy' },
    }).success).toBe(false);
    expect(DiscussionPostRequestV1Schema.safeParse({
      ...plainMessage,
      content: { t: 'encrypted', c: 'Y2lwaGVy' },
      requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
    }).success).toBe(true);
    expect(DiscussionPostRequestV1Schema.safeParse({
      ...plainMessage,
      requestEqualityEvidenceV1: { kind: 'plainDigest', digest: 'A'.repeat(43) },
    }).success).toBe(false);
    expect(DiscussionPostRequestV1Schema.safeParse(plainMessage).success).toBe(true);
  });

  it('rejects caller-authored producer provenance on the public post request', () => {
    expect(DiscussionPostRequestV1Schema.safeParse({
      ...plainMessage,
      producerV1: {
        v: 1,
        kind: 'agent',
        runId: 'run-forged-by-caller',
      },
    }).success).toBe(false);
  });

  it('keeps the runtime Agent-post carrier producer-free and Session-bound', () => {
    expect(DISCUSSION_AGENT_POST_EVENT_V1).toBe('discussion-agent-post-v1');
    const request = {
      v: 1,
      sessionId: 'session-1',
      discussionId: 'discussion-1',
      request: plainMessage,
      runId: 'run-1',
      toolCallId: 'tool-1',
    };
    expect(DiscussionAgentPostRequestV1Schema.safeParse(request).success).toBe(true);
    expect(DiscussionAgentPostRequestV1Schema.safeParse({
      ...request,
      producerV1: { v: 1, kind: 'agent', sessionId: 'session-2' },
    }).success).toBe(false);
  });

  it('initializes the ordinary post response before the Agent carrier wraps it', () => {
    const message = {
      id: 'message-1',
      discussionId: 'discussion-1',
      localId: null,
      seq: 1,
      authorAccountId: 'account-1',
      accountActor: { v: 1, accountId: 'account-1', profile: null },
      producerV1: null,
      content: plainMessage.content,
      mentionedAccountIds: [],
      createdAt: 1,
    };
    const value = DiscussionPostResponseV1Schema.parse({
      message,
      messageSeq: 1,
    });

    expect(DiscussionPostResponseV1Schema.safeParse({
      message: { ...message, accountActor: undefined },
      messageSeq: 1,
    }).success).toBe(false);
    expect(DiscussionPostResponseV1Schema.safeParse({
      message: {
        ...message,
        accountActor: { v: 1, accountId: 'account-1', profile: null, email: 'private@example.test' },
      },
      messageSeq: 1,
    }).success).toBe(false);
    expect(DiscussionPostResponseV1Schema.safeParse({
      message: {
        ...message,
        accountActor: { v: 1, accountId: 'different-account', profile: null },
      },
      messageSeq: 1,
    }).success).toBe(false);

    expect(DiscussionLatestMessageV1Schema.safeParse({
      id: 'message-1',
      localId: null,
      seq: 1,
      authorAccountId: 'account-1',
      accountActor: { v: 1, accountId: 'different-account', profile: null },
      producerV1: null,
      createdAt: 1,
    }).success).toBe(false);
    expect(DiscussionOpenedMessageV1Schema.safeParse({
      ...message,
      content: plainMessage.content.v,
      accountActor: { v: 1, accountId: 'different-account', profile: null },
    }).success).toBe(false);

    expect(DiscussionAgentPostResponseV1Schema.parse({
      ok: true,
      v: 1,
      value,
    })).toEqual({ ok: true, v: 1, value });
  });

  it('rejects a create whose title and first message disagree about storage mode', () => {
    expect(DiscussionCreateRequestV1Schema.safeParse({
      creationLocalId: 'create-1',
      titleContent: { t: 'plain', v: { v: 1, title: 'Release readiness' } },
      firstMessage: {
        ...plainMessage,
        content: { t: 'encrypted', c: 'Y2lwaGVy' },
        requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
      },
    }).success).toBe(false);
  });

  it('rejects mutually exclusive message pagination and negative cursors', () => {
    expect(DiscussionMessagesQueryV1Schema.safeParse({ beforeSeq: 5, afterSeq: 2 }).success).toBe(false);
    expect(DiscussionMessagesQueryV1Schema.safeParse({ afterSeq: 2 }).success).toBe(true);
    expect(DiscussionReadRequestV1Schema.safeParse({ lastReadSeq: -1 }).success).toBe(false);
    expect(DiscussionReadRequestV1Schema.safeParse({ lastReadSeq: 1.5 }).success).toBe(false);
  });
});

describe('committed Discussion message references', () => {
  it('uses the captured Home and the committed id, rejecting pending identity and cross-Discussion output', () => {
    const message = {
      id: 'committed-message', discussionId: 'discussion-1', localId: 'retry-1', seq: 1,
      authorAccountId: 'account-1', accountActor: { v: 1 as const, accountId: 'account-1', profile: null },
      producerV1: null, content: plainMessage.content, mentionedAccountIds: [], createdAt: 1,
    };
    const address = { serverId: 'home-1', discussionId: message.discussionId };
    const reference = createDiscussionMessageRefV1(address, message);
    expect(DiscussionMessageRefV1Schema.parse(reference)).toEqual({ kind: 'discussion', discussion: address, messageId: message.id });
    expect(CoordinationMessageRefV1Schema.parse(reference)).toEqual(reference);
    const sessionReference = SessionMessageRefV1Schema.parse({
      kind: 'session', session: { serverId: 'home-1', sessionId: 'session-1' }, messageId: message.id,
    });
    expect(parseCoordinationMessageRefV1(sessionReference)).toEqual(sessionReference);
    expect(areCoordinationMessageRefsEqualV1(reference, sessionReference)).toBe(false);
    expect(parseCoordinationMessageRefV1({ ...sessionReference, localId: 'retry-1' })).toBeNull();
    expect(areDiscussionMessageRefsEqualV1(reference, createDiscussionMessageRefV1({ ...address, serverId: 'home-2' }, message))).toBe(false);
    expect(() => createDiscussionMessageRefV1(address, { ...message, discussionId: 'another-discussion' })).toThrow();
    expect(DiscussionMessageRefV1Schema.safeParse({ kind: 'discussion', discussion: address, localId: 'retry-1' }).success).toBe(false);
    expect(DiscussionAddressV1Schema.safeParse({ ...address, accountId: 'forged-account' }).success).toBe(false);
    expect(DiscussionMessageRefV1Schema.safeParse({ ...reference, throughSeq: 123 }).success).toBe(false);
  });
});

describe('session discussion mutation equality', () => {
  const title = { v: 1 as const, title: 'Release readiness' };
  const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Ship it' }] };

  it('preserves observed previous canonical equality bytes when the new operands are absent', () => {
    expect(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, mentionedAccountIds: [] }))
      .toBe('{"content":{"parts":[{"t":"text","text":"Ship it"}],"v":1},"kind":"post","mentionedAccountIds":[],"v":1}');
    expect(serializeDiscussionMutationEqualityIntentV1({
      kind: 'create', title, firstMessage: { localId: 'local-1', content, mentionedAccountIds: [] },
    })).toBe('{"firstMessage":{"content":{"parts":[{"t":"text","text":"Ship it"}],"v":1},"localId":"local-1","mentionedAccountIds":[]},"kind":"create","title":{"title":"Release readiness","v":1},"v":1}');
  });

  it('binds creation equality to its anchor and invited people, and post equality to its reply target', () => {
    const original = {
      kind: 'create' as const, title,
      anchor: { kind: 'session' as const, sessionId: 'session-1' },
      participants: [{ kind: 'account' as const, accountId: 'b' }, { kind: 'account' as const, accountId: 'a' }],
      firstMessage: { localId: 'first-1', content, mentionedAccountIds: [] },
    };
    const serialized = serializeDiscussionMutationEqualityIntentV1(original);
    expect(serializeDiscussionMutationEqualityIntentV1({ ...original, participants: [...original.participants].reverse() })).toBe(serialized);
    expect(serializeDiscussionMutationEqualityIntentV1({ ...original, participants: [{ kind: 'account', accountId: 'c' }] })).not.toBe(serialized);
    expect(serializeDiscussionMutationEqualityIntentV1({ ...original, anchor: { kind: 'session', sessionId: 'other-session' } })).not.toBe(serialized);
    const reply = { kind: 'post' as const, content, mentionedAccountIds: [], replyTarget: { kind: 'message' as const, messageId: 'parent-1' } };
    expect(serializeDiscussionMutationEqualityIntentV1(reply)).not.toBe(serializeDiscussionMutationEqualityIntentV1({
      ...reply, replyTarget: { kind: 'message', messageId: 'parent-2' },
    }));
  });

  it('is independent of key order and mention order but not of the operation', () => {
    const left = serializeDiscussionMutationEqualityIntentV1({
      kind: 'post',
      content,
      mentionedAccountIds: ['b', 'a'],
    });
    const right = serializeDiscussionMutationEqualityIntentV1({
      kind: 'post',
      mentionedAccountIds: ['a', 'b', 'a'],
      content: { parts: [{ text: 'Ship it', t: 'text' }], v: 1 } as typeof content,
    });
    const create = serializeDiscussionMutationEqualityIntentV1({
      kind: 'create',
      title,
      firstMessage: { localId: 'local-1', content, mentionedAccountIds: ['a', 'b'] },
    });

    expect(left).toBe(right);
    expect(create).not.toBe(left);
    expect(create.includes('"kind":"create"')).toBe(true);
  });

  it('separates discussion tags from Session-input tags for the same Session key', () => {
    const keyMaterial = new Uint8Array(32).fill(7);
    const canonicalIntent = serializeDiscussionMutationEqualityIntentV1({
      kind: 'post',
      content,
      mentionedAccountIds: [],
    });
    const discussionTag = deriveSessionMutationEqualityTagV1({
      keyMaterial,
      sessionId: 'sess-1',
      purpose: DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
      canonicalIntent,
    });
    const inputTag = deriveSessionMutationEqualityTagV1({
      keyMaterial,
      sessionId: 'sess-1',
      purpose: SESSION_INPUT_EQUALITY_HKDF_LABEL_V1,
      canonicalIntent,
    });
    const otherSessionTag = deriveSessionMutationEqualityTagV1({
      keyMaterial,
      sessionId: 'sess-2',
      purpose: DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
      canonicalIntent,
    });

    expect(discussionTag).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(discussionTag).not.toBe(inputTag);
    expect(discussionTag).not.toBe(otherSessionTag);
  });

  it('refuses to derive a tag without Session key material', () => {
    expect(() => deriveSessionMutationEqualityTagV1({
      keyMaterial: new Uint8Array(0),
      sessionId: 'sess-1',
      purpose: DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
      canonicalIntent: 'x',
    })).toThrow('Session key material');
  });
});

it('retains the exact Discussion destination in original reply admission and progress', () => {
  const discussion = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'participant' };
  expect(SessionMessageReplyAdmissionV1Schema.safeParse({ mode: 'return', discussion }).success).toBe(true);
  expect(SessionMessageReplyProgressV1Schema.safeParse({ v: 1, mode: 'return', discussion, disposition: 'return_pending' }).success).toBe(true);
  expect(SessionMessageReplyProgressV1Schema.safeParse({ v: 1, mode: 'return', discussion, disposition: 'released', outcome: { kind: 'declined' } }).success).toBe(true);
  expect(SessionMessageReplyMutationV1Schema.safeParse({ v: 1, sessionId: 'receiver', requestSessionId: 'receiver', requestLocalId: 'original',
    operation: { kind: 'fulfill', turnId: 'turn', outcome: { kind: 'declined' } } }).success).toBe(false);
  expect(SessionMessageReplyAdmissionV1Schema.safeParse({ mode: 'return', discussion: { ...discussion, throughSeq: 0 } }).success).toBe(false);
});
