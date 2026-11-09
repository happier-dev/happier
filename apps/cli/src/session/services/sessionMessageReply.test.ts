import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { SessionPendingEnqueueByMachineRequestV1, SessionPendingExecutionRunEnqueueByMachineRequestV2 } from '@happier-dev/protocol';
import { buildCausalSessionInputAdmissionV1 } from './sessionInputAdmissionIdentity';
import { readSessionInputRequest, settleSessionInputRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { UserMessageSchema } from '@/api/types';
import { deriveSessionMessageReplyReturnLocalIdV1, type SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { projectSessionMessageReplyOutcome, readSessionMessageReplyCapability, recoverSessionMessageRepliesForMachine } from './sessionMessageReply';

afterEach(() => vi.restoreAllMocks());

it('settles a refused Discussion publication once without replacing its native outcome', async () => {
  const discussion = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'participant' };
  let progress: SessionMessageReplyProgressV1 = { v: 1, mode: 'return', disposition: 'return_pending',
    acceptedTurnId: 'turn', discussion, outcome: { kind: 'pass' } };
  vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: url.includes('/session-message-replies/pending')
    ? { v: 1, entries: progress.disposition === 'return_pending' ? [{ requestSessionId: 'participant', requestLocalId: 'original', progress }] : [], nextAfter: null }
    : { v: 1, status: 'available', progress } }));
  const settlements: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
    settlements.push(body);
    progress = { ...progress, disposition: 'released', returnPublication: { kind: 'failed',
      failure: { code: 'action_disabled', phase: 'action_admission', retryable: false } } };
    return { status: 200, data: { v: 1, ok: true, progress } };
  });
  let publications = 0;
  const input = { machineId: 'machine', serverId: 'home', credentials: { token: 'token', encryption: null },
    signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async () => { throw new Error('unexpected Session return'); },
    markReturned: async () => { throw new Error('unexpected Session ACK'); },
    publishDiscussionReply: async () => { publications++; return { v: 1 as const, ok: false as const,
      error: 'discussion_post_denied' as const, failure: { code: 'action_disabled' as const, phase: 'action_admission' as const, retryable: false } }; } };
  await recoverSessionMessageRepliesForMachine(input);
  await recoverSessionMessageRepliesForMachine(input);
  expect(publications).toBe(1);
  expect(settlements).toEqual([{ kind: 'discussion_publication', discussionId: 'discussion', messageId: 'question', acceptedTurnId: 'turn',
    publication: { kind: 'failed', failure: { code: 'action_disabled', phase: 'action_admission', retryable: false } } }]);
  expect(progress.outcome).toEqual({ kind: 'pass' });
});

it('retains private approval custody and does not republish it for repeated recovery hints', async () => {
  const discussion = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'participant' };
  const progress = { v: 1, mode: 'return', disposition: 'return_pending', acceptedTurnId: 'turn', discussion,
    outcome: { kind: 'pass' }, returnPublication: { kind: 'approval_pending', artifactId: 'approval' } };
  vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: url.includes('/session-message-replies/pending')
    ? { v: 1, entries: [{ requestSessionId: 'participant', requestLocalId: 'original', progress }], nextAfter: null }
    : { v: 1, status: 'available', progress } }));
  let publications = 0;
  const input = { machineId: 'machine', serverId: 'home', credentials: { token: 'token', encryption: null },
    signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async () => { throw new Error('unexpected Session return'); },
    markReturned: async () => { throw new Error('unexpected Session ACK'); },
    publishDiscussionReply: async () => { publications++; return { v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const }; } };
  await recoverSessionMessageRepliesForMachine(input);
  await recoverSessionMessageRepliesForMachine(input);
  expect(publications).toBe(0);
});

it('retries a retained transient return only when the transport state advances', async () => {
  const discussion = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'participant' };
  let progress: SessionMessageReplyProgressV1 = { v: 1, mode: 'return', disposition: 'return_pending', acceptedTurnId: 'turn', discussion, outcome: { kind: 'pass' } };
  const failure = { code: 'discussions_unavailable' as const, phase: 'session_transport' as const, retryable: true };
  vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: url.includes('/session-message-replies/pending')
    ? { v: 1, entries: [{ requestSessionId: 'participant', requestLocalId: 'original', progress }], nextAfter: null }
    : { v: 1, status: 'available', progress } }));
  vi.spyOn(axios, 'post').mockImplementation(async () => {
    progress = { ...progress, returnPublication: { kind: 'failed', failure } };
    return { status: 200, data: { v: 1, ok: true, progress } };
  });
  let publications = 0;
  const input = { machineId: 'machine', serverId: 'home', credentials: { token: 'token', encryption: null },
    signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async () => { throw new Error('unexpected Session return'); },
    markReturned: async () => { throw new Error('unexpected Session ACK'); },
    publishDiscussionReply: async () => { publications++; return { v: 1 as const, ok: false as const,
      error: 'discussions_unavailable' as const, failure }; } };
  await recoverSessionMessageRepliesForMachine(input);
  await recoverSessionMessageRepliesForMachine(input);
  expect(publications).toBe(1);
  expect(progress.disposition).toBe('return_pending');
  await recoverSessionMessageRepliesForMachine({ ...input, retryFailedPublications: true });
  expect(publications).toBe(2);
});

it('holds a missing scoped capability authorization without falling back to the Account bearer', async () => {
  const read = vi.spyOn(axios, 'get');
  expect(await readSessionMessageReplyCapability({ credentials: { token: 'account-token' }, sessionId: 'target',
    resolveAuthorizationHeaders: () => null })).toBe('unavailable');
  expect(read).not.toHaveBeenCalled();
});

it('never projects a declined private Discussion draft into public return text', async () => {
  expect(await projectSessionMessageReplyOutcome({ credentials: { token: 'token', encryption: null },
    serverId: 'home', sessionId: 'draft-session', localId: 'original', outcome: { kind: 'declined' } })).toBeNull();
});

it('recovers a human-origin return through the original reply owner without a source turn', async () => {
  const requestSessionId = 'c' + 'c'.repeat(24);
  const destinationId = 'c' + 'd'.repeat(24);
  const progress = { v: 1, mode: 'return', disposition: 'return_pending', acceptedTurnId: 'accepted-turn',
    humanOrigin: { sessionId: destinationId }, outcome: { kind: 'pass' } };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) return { status: 200, data: { v: 1,
      entries: [{ requestSessionId, requestLocalId: 'human-ask', progress }], nextAfter: null } };
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.endsWith(`/v2/sessions/${destinationId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: destinationId, encryptionMode: 'plain', active: true, metadata: JSON.stringify({ machineId: 'machine-source' }),
    }) } };
    throw new Error(`unexpected_human_return_read:${url}`);
  });
  const sent: unknown[] = [];
  const returned: unknown[] = [];
  await recoverSessionMessageRepliesForMachine({ machineId: 'machine-target', serverId: 'home',
    credentials: { token: 'token', encryption: null }, signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async request => { sent.push(request); return { status: 'accepted', localId: request.localId }; },
    markReturned: async request => { returned.push(request); return { v: 1, ok: true, progress: { ...progress,
      v: 1, mode: 'return', disposition: 'returned', outcome: { kind: 'pass' } } }; },
  });
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: requestSessionId, localId: 'human-ask', acceptedTurnId: 'accepted-turn' });
  expect(sent).toEqual([expect.objectContaining({ sessionId: destinationId, localId,
    content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
      happierInputRequestV1: expect.objectContaining({ returnedAnswer: expect.objectContaining({
        requestSessionId, requestLocalId: 'human-ask', outcome: 'pass', senderSessionId: requestSessionId,
      }) }),
    }) }) },
  })]);
  expect(returned).toEqual([{ requestSessionId, requestLocalId: 'human-ask', returnedInputLocalId: localId }]);
  expect(vi.mocked(axios.get).mock.calls.filter(([url]) => url.endsWith('/by-local-id/human-ask/reply'))).toHaveLength(0);
});

it.each(['pass', 'failed', 'cancelled', 'terminal_no_result'] as const)('returns a Discussion %s through its resource publisher without sending to the causal Session', async kind => {
  const requestSessionId = 'participant';
  const discussion = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: requestSessionId };
  const actionRequestAttributionV1 = { requestRef: 'original-cause', requester: { serverId: 'home', accountId: 'person' },
    persona: { serverId: 'home', sessionId: requestSessionId }, origin: null };
  const progress = { v: 1, mode: 'return', disposition: 'return_pending', acceptedTurnId: 'turn', discussion,
    sourceSession: { sourceSessionId: 'asker', sourceTurnId: 'source-turn', via: 'action' }, outcome: { kind }, actionRequestAttributionV1 };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) return { status: 200, data: { v: 1,
      entries: [{ requestSessionId, requestLocalId: 'original', progress }], nextAfter: null } };
    throw new Error(`unexpected_discussion_return_read:${url}`);
  });
  const { recoverSessionMessageRepliesForMachine } = await import('./sessionMessageReply');
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true, progress: { ...progress,
    disposition: 'released' } } });
  const input = { machineId: 'machine', serverId: 'home', credentials: { token: 'token', encryption: null },
    signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async () => { throw new Error('A Discussion return must not enter a Session'); },
    markReturned: async () => { throw new Error('Only the atomic Discussion writer acknowledges this return'); } };
  await recoverSessionMessageRepliesForMachine(input); // Unavailable publisher leaves original custody pending.
  const publications: unknown[] = [];
  await recoverSessionMessageRepliesForMachine({ ...input, publishDiscussionReply: async request => {
    publications.push(request);
    return { v: 1, ok: false, error: 'discussion_post_denied' };
  } });
  expect(publications).toEqual([expect.objectContaining({ serverId: 'home', requestSessionId, requestLocalId: 'original',
    acceptedTurnId: 'turn', discussion, outcome: { kind }, actionRequestAttributionV1 })]);
  if (kind === 'pass') {
    await expect(recoverSessionMessageRepliesForMachine({ ...input, publishDiscussionReply: async () => {
      throw new Error('publication_acknowledgement_lost');
    } })).rejects.toThrow('publication_acknowledgement_lost');
  }
});

it.each([
  { replyMode: undefined, accountId: 'bob' },
  { replyMode: 'wait', accountId: 'bob' },
  { replyMode: 'return', accountId: null },
] as const)('retains the original cause and immediate sender (reply $replyMode, requester $accountId)', async ({ replyMode, accountId }) => {
  const sessionId = 'c' + 'e'.repeat(24);
  const cause = { requestRef: 'bob-input', requester: accountId ? { serverId: 'home', accountId } : null,
    persona: { serverId: 'home', sessionId: 'release-bot' },
    origin: { kind: 'session' as const, session: { serverId: 'home', sessionId: 'release-bot' }, messageId: 'bob-message' } };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (url.includes(`/v2/sessions/${sessionId}/delivery-mutes`)) return { status: 200, data: { scopes: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', active: true, metadata: JSON.stringify({ machineId: 'machine-a', path: '/repo' }),
    }) } };
    throw new Error(`unexpected_forward_http:${url}`);
  });
  const inputAdmission = buildCausalSessionInputAdmissionV1({ sourceSessionId: 'sender-bot', sourceTurnId: 'sender-turn',
    sourceInputId: 'sender-input', via: 'action', callerDepth: 1, actionRequestAttributionV1: cause,
    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
  const { sendSessionMessage } = await import('./sendSessionMessage');
  let delivered: unknown;
  let replyCarrier: unknown;
  await expect(sendSessionMessage({ credentials: { token: 'bot-token', encryption: null },
    idOrPrefix: sessionId, message: 'Investigate', localId: 'forwarded-input', wait: false, timeoutMs: 30000, inputAdmission,
    ...(replyMode ? { replyIntent: { mode: replyMode } } : {}),
    machineAdmissionTransport: async request => {
      replyCarrier = request.reply;
      if (request.content.t !== 'plain') throw new Error('missing_forwarded_plain_input');
      const body = UserMessageSchema.parse(request.content.v);
      const protectedInput = readSessionInputRequest(body.meta);
      if (!protectedInput || protectedInput.v !== 1) throw new Error('missing_forwarded_request');
      const authority = settleSessionInputRequestV1({ request: protectedInput,
        currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } });
      expect(authority.sourceSession).toEqual({ sourceSessionId: 'sender-bot', sourceTurnId: 'sender-turn', sourceInputId: 'sender-input', via: 'action' });
      delivered = deriveSessionInputActionRequestAttributionV1({ requestRef: request.localId,
        persona: { serverId: 'home', sessionId }, origin: null, messageRole: 'user',
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' }, inputAuthority: authority });
      return { status: 'accepted', localId: request.localId };
    },
  })).resolves.toMatchObject({ ok: true });
  expect(delivered).toEqual(cause);
  if (replyMode) expect(replyCarrier).toMatchObject({ mode: replyMode, actionRequestAttributionV1: cause });
});

it('fails closed before a non-ignorable ask on an older host and preserves reply custody on a supported host', async () => {
  const sessionId = 'c' + 'b'.repeat(24);
  let supported = false;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/reply-capability')) return { status: supported ? 200 : 404,
      data: supported ? { v: 1, protocolVersions: [1] } : {} };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true, metadata: '{}' }) } };
    throw new Error(`unexpected_ask_http:${url}`);
  });
  const write = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { didWrite: true } });
  const { sendSessionMessage } = await import('./sendSessionMessage');
  const send = () => sendSessionMessage({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, message: 'Which revision?', localId: 'ask-1', wait: false, timeoutMs: 30000,
    replyIntent: { mode: 'wait' } });
  await expect(send()).resolves.toMatchObject({ ok: false, code: 'unsupported' });
  expect(write).not.toHaveBeenCalled();
  supported = true;
  await expect(send()).resolves.toMatchObject({ ok: true, localId: 'ask-1' });
  expect(write).toHaveBeenCalledWith(expect.stringContaining('/pending'), expect.objectContaining({
    reply: { mode: 'wait' }, content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
      happierInputRequestV1: expect.objectContaining({ replyIntent: { mode: 'wait' } }),
    }) }) },
  }), expect.anything());
});

it.each([
  { mode: 'wait', active: true }, { mode: 'continue', active: true },
  { mode: 'continue', active: false },
] as const)('returns a $mode question answer with an active=$active asker through receiver admission', async ({ mode, active }) => {
  const sessionId = 'c' + 'a'.repeat(24);
  let observedActive = active;
  const sent: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', active: observedActive, latestTurnStatus: 'in_progress',
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      metadata: JSON.stringify({ machineId: 'machine-a', path: '/repo', claudeSessionId: 'native-1',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
    }) } };
    throw new Error(`unexpected_reply_http:${url}`);
  });
  const { deliverSessionMessageReply } = await import('./sessionMessageReply');
  const actionRequestAttributionV1 = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
    persona: { serverId: 'home', sessionId: 'release-bot' }, origin: null };
  const machineResumeTransport = vi.fn(async () => {
    observedActive = true;
    return { type: 'success' as const, sessionId };
  });
  const deliver = () => deliverSessionMessageReply({
    credentials: { token: 'token', encryption: null }, sessionId,
    requestSessionId: sessionId, requestLocalId: 'question-1',
    message: 'Use the existing database', outcome: 'answer', mode,
    senderSessionId: 'manager',
    answeredBy: { v: 1, kind: 'happierSession', sourceSessionId: 'manager', via: 'action' },
    actionRequestAttributionV1,
    machineAdmissionTransport: async request => { sent.push(request); return { status: 'accepted', localId: request.localId }; },
    machineResumeTransport,
  });
  await expect(deliver()).resolves.toMatchObject({ ok: true, waited: false,
    receiverDelivery: { disposition: active ? 'next_turn' : 'wake' } });
  await expect(deliver()).resolves.toMatchObject({ ok: true, localId: sent[0]?.localId });
  expect(sent).toHaveLength(2);
  expect(sent[1]?.localId).toBe(sent[0]?.localId);
  const envelope = sent[0]?.content;
  if (!envelope || envelope.t !== 'plain') throw new Error('missing_plain_reply');
  expect(envelope.v).toMatchObject({ meta: {
    happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
    happierInputRequestV1: { producer: 'sessionAction', actionRequestAttributionV1, returnedAnswer: {
      requestSessionId: sessionId, requestLocalId: 'question-1', outcome: 'answer',
      delivery: 'wake',
      senderSessionId: 'manager',
      answeredBy: { kind: 'happierSession', sourceSessionId: 'manager' },
    } },
  } });
  expect(sent[0]?.requestedAction).toEqual({ v: 1, kind: active ? 'enqueue' : 'send_now' });
  if (active) expect(machineResumeTransport).not.toHaveBeenCalled();
  else expect(machineResumeTransport).toHaveBeenCalled();
});

it('recovers the original pending return after a lost receipt without a second answer identity', async () => {
  const requestSessionId = 'c' + 'c'.repeat(24);
  const sourceSessionId = 'c' + 'd'.repeat(24);
  const admitted: string[] = [];
  const admittedCauses: unknown[] = [];
  const originalCause = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
    persona: { serverId: 'home', sessionId: requestSessionId }, origin: null };
  let disposition: 'return_pending' | 'returned' = 'return_pending';
  const progress = (): SessionMessageReplyProgressV1 => ({ v: 1, mode: 'return', disposition, acceptedTurnId: 'accepted-turn',
    sourceSession: { sourceSessionId, sourceTurnId: 'source-turn', via: 'action' }, outcome: { kind: 'pass' },
    actionRequestAttributionV1: originalCause });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) return { status: 200, data: { v: 1,
      entries: [{ requestSessionId, requestLocalId: 'original-ask', progress: progress() }], nextAfter: null } };
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.includes(`/v2/sessions/${sourceSessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sourceSessionId, encryptionMode: 'plain', active: true, metadata: JSON.stringify({ machineId: 'machine-source', path: '/repo' }),
    }) } };
    throw new Error(`unexpected_recovery_read:${url}`);
  });
  const { recoverSessionMessageRepliesForMachine } = await import('./sessionMessageReply');
  let receipts = 0;
  const recover = () => recoverSessionMessageRepliesForMachine({ machineId: 'machine-target', serverId: 'home',
    credentials: { token: 'token', encryption: null }, signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async request => {
      admitted.push(request.localId);
      if (request.content.t !== 'plain') throw new Error('missing_recovered_plain_input');
      admittedCauses.push(readSessionInputRequest(UserMessageSchema.parse(request.content.v).meta)?.actionRequestAttributionV1);
      return { status: 'accepted', localId: request.localId };
    },
    markReturned: async () => {
      if (++receipts === 1) throw new Error('lost_socket_receipt');
      disposition = 'returned';
      return { v: 1, ok: true, progress: progress() };
    },
  });
  await expect(recover()).rejects.toThrow('lost_socket_receipt');
  await recover();
  await recover();
  expect(admitted).toHaveLength(2);
  expect(admitted[0]).toBe(admitted[1]);
  expect(receipts).toBe(2);
  expect(admittedCauses).toEqual([originalCause, originalCause]);
});

it('uses admitted native return custody and stops before admission after local Machine activity retires', async () => {
  const requestSessionId = 'c' + 'f'.repeat(24);
  const sourceSessionId = 'c' + '1'.repeat(24);
  const returnRecipient = { kind: 'execution_run', runId: 'run-source' } as const;
  const progress = { v: 1, mode: 'return', disposition: 'return_pending', acceptedTurnId: 'turn',
    sourceSession: { sourceSessionId, sourceTurnId: 'turn-source', via: 'action' }, outcome: { kind: 'pass' } };
  let live = true;
  let revoke = false;
  const sent: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
  const marked: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) return { status: 200, data: { v: 1,
      entries: [{ requestSessionId, requestLocalId: 'ask', progress, returnRecipient }], nextAfter: null } };
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.includes(`/v2/sessions/${sourceSessionId}`)) {
      if (revoke) live = false;
      return { status: 200, data: { session: createSessionRecordFixture({ id: sourceSessionId,
        encryptionMode: 'plain', active: true, metadata: JSON.stringify({ machineId: 'machine-source', path: '/repo' }) }) } };
    }
    throw new Error(`unexpected_native_recovery_read:${url}`);
  });
  const { recoverSessionMessageRepliesForMachine } = await import('./sessionMessageReply');
  const recover = () => recoverSessionMessageRepliesForMachine({ machineId: 'target-machine', serverId: 'home',
    credentials: { token: 'token', encryption: null }, signal: new AbortController().signal,
    isCurrent: async () => live, machineAdmissionTransport: async request => {
      sent.push(request); return { status: 'accepted', localId: request.localId };
    }, markReturned: async request => {
      marked.push(request.returnedInputLocalId);
      return { v: 1, ok: true, progress: { v: 1, mode: 'return', disposition: 'returned',
        acceptedTurnId: 'turn', sourceSession: { sourceSessionId, sourceTurnId: 'turn-source', via: 'action' }, outcome: { kind: 'pass' } } };
    } });
  await recover();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ v: 2, recipient: { kind: 'execution_run', runId: 'run-source' } });
  expect(marked).toEqual([sent[0]!.localId]);
  revoke = true;
  await recover();
  expect(sent).toHaveLength(1);
  expect(marked).toHaveLength(1);
});

it('does not read content or publish when the next admitted inventory has no eligible originals', async () => {
  const effects = vi.fn();
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) return { status: 200, data: { v: 1,
      entries: [], nextAfter: null } };
    throw new Error('Unexpected content read after original custody became unavailable');
  });
  const { recoverSessionMessageRepliesForMachine } = await import('./sessionMessageReply');
  await recoverSessionMessageRepliesForMachine({ machineId: 'machine', serverId: 'home', credentials: { token: 'token', encryption: null },
    signal: new AbortController().signal, isCurrent: async () => true,
    machineAdmissionTransport: async request => { effects(); return { status: 'accepted', localId: request.localId }; },
    markReturned: async () => { effects(); return { v: 1, ok: false, error: 'unavailable' }; } });
  expect(effects).not.toHaveBeenCalled();
});

it('rechecks installed custody before waking an inactive requester after Pending admission', async () => {
  const requestSessionId = 'c' + '5'.repeat(24);
  const sourceSessionId = 'c' + '6'.repeat(24);
  const progress = { v: 1, mode: 'return', disposition: 'return_pending', acceptedTurnId: 'turn',
    sourceSession: { sourceSessionId, sourceTurnId: 'source-turn', via: 'action' }, outcome: { kind: 'pass' } };
  let live = true;
  let revokeAfterAdmission = false;
  const resumed: string[] = [];
  let receipts = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) return { status: 200, data: { v: 1,
      entries: [{ requestSessionId, requestLocalId: 'ask', progress }], nextAfter: null } };
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.includes(`/v2/sessions/${sourceSessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sourceSessionId, encryptionMode: 'plain', active: false, metadata: JSON.stringify({ machineId: 'source-machine',
        path: '/repo', claudeSessionId: 'native', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
    }) } };
    throw new Error(`unexpected_resume_recovery_read:${url}`);
  });
  const { recoverSessionMessageRepliesForMachine } = await import('./sessionMessageReply');
  const recover = () => recoverSessionMessageRepliesForMachine({ machineId: 'target-machine', serverId: 'home',
    credentials: { token: 'token', encryption: null }, signal: new AbortController().signal, isCurrent: async () => live,
    machineAdmissionTransport: async request => {
      if (revokeAfterAdmission) live = false;
      return { status: 'accepted', localId: request.localId };
    }, machineResumeTransport: async method => { resumed.push(method); return { type: 'success', sessionId: sourceSessionId }; },
    markReturned: async () => { receipts++; return { v: 1, ok: true, progress: { ...progress,
      v: 1, mode: 'return', disposition: 'returned', sourceSession: { sourceSessionId, sourceTurnId: 'source-turn', via: 'action' },
      outcome: { kind: 'pass' } } }; },
  });
  await recover();
  expect(resumed).toHaveLength(1);
  expect(receipts).toBe(1);
  revokeAfterAdmission = true;
  await recover();
  expect(resumed).toHaveLength(1);
  expect(receipts).toBe(1);
});

it('keeps pre-provider cancellation in original input identity without inventing an accepted turn', async () => {
  const sessionId = 'c' + '7'.repeat(24);
  const requestSessionId = 'c' + '8'.repeat(24);
  const admitted: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', active: true, metadata: JSON.stringify({ machineId: 'source-machine', path: '/repo' }),
    }) } };
    throw new Error(`unexpected_cancel_return_read:${url}`);
  });
  const { deliverSessionMessageReply } = await import('./sessionMessageReply');
  await deliverSessionMessageReply({ credentials: { token: 'token', encryption: null }, sessionId,
    requestSessionId, requestLocalId: 'cancelled-before-provider', requestKind: 'session_input',
    outcome: 'cancelled', message: 'The requested work was cancelled.', mode: 'wait',
    machineAdmissionTransport: async request => { admitted.push(request.localId); return { status: 'accepted', localId: request.localId }; } });
  expect(admitted).toEqual([deriveSessionMessageReplyReturnLocalIdV1({ sessionId: requestSessionId, localId: 'cancelled-before-provider' })]);
});
