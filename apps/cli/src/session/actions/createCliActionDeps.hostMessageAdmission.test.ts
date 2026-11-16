import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, ExternalActionExecutionAuthorizationV1Schema, SessionInputRequestV1Schema, type ApprovalRequest } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const sockets = vi.hoisted(() => ({ connect: vi.fn() }));
// HTTP is the Home boundary; Action composition, input policy and serialization stay real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, ...http } };
});
vi.mock('@/api/session/sockets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/session/sockets')>();
  return { ...actual, createSessionScopedSocketConnection: sockets.connect };
});

describe('CLI host Message admission', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['retained_alias', 'missing_machine'] as const)(
    'preserves the approval-result admission failure for %s', async failure => {
    const accountId = 'approval-owner';
    const serverId = 'approval-profile';
    const serverIdentityId = 'srv_approval_home';
    const sessionId = 'cmv3approvalresultaaaaaaa';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture() };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: false, encryptionMode: 'plain',
        machineId: failure === 'missing_machine' ? null : 'approval-machine',
        metadata: JSON.stringify(failure === 'missing_machine' ? {} : { machineId: 'approval-machine' }),
      }) } };
      throw new Error(`Unexpected approval-result HTTP read: ${url}`);
    });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId, serverIdentityId });
    const result = await deps.sessionSendMessage!({ sessionId, message: 'Recorded Action result',
      localId: 'approval-result:retained', requestedAction: { v: 1, kind: 'enqueue' }, reply: 'none',
      actionCaller: { kind: 'host' }, callerSurface: 'mcp',
      context: { surface: 'mcp', authority: 'account_automation', runtimeAccountId: accountId, serverId,
        serverIdentityId, actionCaller: { kind: 'host' }, actionRequestAttributionV1: {
          requestRef: 'original-input', requester: { accountId, serverId },
          persona: { serverId, sessionId }, origin: null,
        } },
    });
    expect(result).toMatchObject({ status: 'rejected', code: failure === 'retained_alias'
      ? 'session_input_unauthorized' : 'session_input_target_unavailable' });
    expect(http.post).not.toHaveBeenCalled();
  });
  it.each([
    { decision: 'reject', draft: true }, { decision: 'cancel', draft: true }, { decision: 'reject', draft: false },
  ] as const)('settles a Discussion $decision at its captured Home without a live publisher (draft: $draft)', async ({ decision, draft }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'draft-account' })).toString('base64url')}.signature`;
    const sessionId = 'draft-session';
    const requestLocalId = 'discussion:original';
    const correlation = { discussionId: 'discussion-1', messageId: 'question-1', acceptedTurnId: 'draft-turn' };
    const publication = { kind: 'failed' as const, failure: { code: 'approval_rejected' as const,
      phase: 'action_admission' as const, retryable: false } };
    const operation = draft ? { kind: 'discussion_review' as const, ...correlation, decision }
      : { kind: 'discussion_publication' as const, ...correlation, approvalArtifactId: 'confirmation', publication };
    const progress = { v: 1, mode: 'return', discussion: { discussionId: operation.discussionId,
      messageId: operation.messageId, throughSeq: 1, participantSessionId: sessionId }, acceptedTurnId: operation.acceptedTurnId,
      disposition: 'released', ...(draft ? { outcome: { kind: 'declined' } }
        : { outcome: { kind: 'answer', result: { sessionId, messageId: 'native-answer' } }, returnPublication: publication }) };
    const writes: unknown[] = [];
    http.post.mockImplementation(async (url: string, body: unknown) => {
      writes.push({ url, body });
      return { status: 200, data: { v: 1, ok: true, progress } };
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'daemon-global',
      mode: 'plain', ctx: null, serverId: 'draft-home', serverHttpBaseUrl: 'https://draft-home.example' });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'draft-home',
      runtimeAccountId: 'draft-account' };
    expect(await deps.sessionMessageReply!({ sessionId, requestLocalId, reviewDecision: operation, context,
      serverId: 'draft-home' })).toMatchObject({ v: 1, ok: true, progress });
    expect(writes).toEqual([{ url: `https://draft-home.example/v2/sessions/${sessionId}/messages/by-local-id/${encodeURIComponent(requestLocalId)}/reply`,
      body: operation }]);
    expect(await deps.sessionMessageReply!({ sessionId, requestLocalId, reviewDecision: operation,
      context: { ...context, authority: 'account_automation' }, serverId: 'draft-home' }))
      .toMatchObject({ ok: false, error: 'forbidden' });
    expect(await deps.sessionMessageReply!({ sessionId, requestLocalId, reviewDecision: operation,
      context, serverId: 'foreign-home' })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(writes).toHaveLength(1);
  });
  it.each([false, true])('admits Voice later-return only through a current person approval (target changed:%s)', async targetChanged => {
    const receiverId = 'cmv3voiceapprovalaaaaaaa';
    const returnToSessionId = 'bound-voice-session';
    const localId = 'voice-approved-ask';
    const accountId = 'voice-account';
    const serverId = 'voice-home';
    const serverIdentityId = 'srv_voice_approval';
    const machineId = 'voice-machine';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    let currentMachineId = machineId;
    let stored: ApprovalRequest | null = null;
    const writes: unknown[] = [];
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith(`/v2/sessions/${receiverId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: receiverId, active: true, encryptionMode: 'plain', machineId: currentMachineId,
        metadata: JSON.stringify({ machineId: currentMachineId }),
      }) } };
      throw new Error(`Unexpected Voice approval HTTP read: ${url}`);
    });
    http.post.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith('/pending')) { writes.push(body); return { status: 200, data: { didWrite: true, terminal: false } }; }
      expect(body).toEqual({ kind: 'release' });
      return { status: 200, data: { v: 1, ok: true, progress: { v: 1, mode: 'return',
        humanOrigin: { sessionId: returnToSessionId }, disposition: 'return_pending' } } };
    });
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
      machineId, serverId, serverApiUrl: resolveServerHttpBaseUrl(),
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }) });
    const executor = createActionExecutor({
      ...createCliActionDeps({ token, credentials, sessionId: 'daemon-global', mode: 'plain', ctx: null }),
      // Artifact persistence is the boundary. Approval policy/claim/replay,
      // Home/target currentness and the actual human-input writer stay real.
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'voice-approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: currentness,
    });
    const input = { sessionId: receiverId, message: 'Return the answer here.', localId, reply: 'return', returnToSessionId };
    expect(await executor.execute('session.message.send', input, { surface: 'voice', authority: 'account_automation',
      actionCaller: { kind: 'host' }, runtimeAccountId: accountId, serverId, serverIdentityId,
      defaultSessionId: returnToSessionId, defaultSessionMachineId: machineId, actionRequestId: 'voice-call' }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'voice-approval' } });
    expect(writes).toEqual([]);
    expect(stored).toMatchObject({ actionArgs: input, executionOriginV1: {
      authority: 'account_automation', surface: 'voice', caller: { kind: 'host' },
    } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'voice-approval', decision: 'approve' }, {
      surface: 'api', authority: 'account_automation', runtimeAccountId: accountId, serverId, serverIdentityId,
      externalActionCredential: { accountId, principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } },
    })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(stored).toMatchObject({ status: 'open' });
    expect(writes).toEqual([]);
    if (targetChanged) currentMachineId = 'replacement-machine';
    const decision = await executor.execute('approval.request.decide', { artifactId: 'voice-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: accountId,
      serverId, serverIdentityId, defaultSessionId: 'a-different-visible-session',
    });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: targetChanged
      ? { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } }
      : { status: 'executed', execution: { ok: true, result: { status: 'accepted', localId } } } });
    expect(writes).toEqual(targetChanged ? [] : [expect.objectContaining({ reply: {
      mode: 'return', humanOrigin: { sessionId: returnToSessionId },
    }, content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
      happierInputRequestV1: expect.objectContaining({ caller: { kind: 'host' }, replyIntent: {
        mode: 'return', humanOrigin: { sessionId: returnToSessionId },
      } }),
    }) }) } })]);
  });
  it('does not turn a Voice approval waiver into human return authority', async () => {
    const approvals: ApprovalRequest[] = [];
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: 'test-account-token', sessionId: 'daemon-global', mode: 'plain', ctx: null,
        credentials: { token: 'test-account-token', encryption: null } }),
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'must-not-be-created' }; },
    });
    expect(await executor.execute('session.message.send', { sessionId: 'worker', message: 'Return it.',
      reply: 'return', returnToSessionId: 'bound-voice-session' }, { surface: 'voice', authority: 'account_automation',
      actionCaller: { kind: 'host' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'session.message.send': ['voice'] } }) }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(approvals).toEqual([]);
    expect(http.post).not.toHaveBeenCalled();
  });
  it.each([false, true])('admits a human-origin Ask through the Action front door with its exact return destination (structured:%s)', async structured => {
    const receiverId = 'cmv3humanadmissionaaaaaaa';
    const localId = 'human-ask-input';
    const humanOrigin = { sessionId: 'composer-session' };
    let admitted: unknown;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith(`/v2/sessions/${receiverId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: receiverId, active: true, encryptionMode: 'plain', machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1' }),
      }) } };
      throw new Error(`Unexpected human Ask HTTP read: ${url}`);
    });
    http.post.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith('/pending')) { admitted = body; return { status: 200, data: { didWrite: true, terminal: false } }; }
      expect(body).toEqual({ kind: 'release' });
      return { status: 200, data: { v: 1, ok: true, progress: { v: 1, mode: 'return', humanOrigin, disposition: 'return_pending' } } };
    });
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId: 'composer-session', mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null },
      machineAdmissionTransport: async () => { throw new Error('Human Ask must retain its authenticated Account requester'); } });
    const executor = createActionExecutor(deps);
    const structuredInput = { v: 1, mentions: [{ kind: 'happier.session', ref: 'session:source-session', token: '@source' }] };
    const input = { sessionId: receiverId, message: '@source Which revision?', localId, reply: 'return', returnToSessionId: humanOrigin.sessionId,
      ...(structured ? { structuredInput } : {}),
      requestedAction: { v: 1, kind: 'enqueue' } };
    expect(await executor.execute('session.message.send', input, {
      surface: 'ui', authority: 'present_user', serverId: 'home', defaultSessionId: humanOrigin.sessionId,
    })).toMatchObject({ ok: true, result: { status: 'accepted', localId } });
    expect(admitted).toMatchObject({ reply: { mode: 'return', humanOrigin }, content: { t: 'plain', v: {
      meta: { happierInputRequestV1: { producer: 'happierApp', replyIntent: { mode: 'return', humanOrigin } } },
    } } });
    if (structured) expect(admitted).toMatchObject({ content: { t: 'plain', v: { meta: { happierStructuredInputV1: structuredInput } } } });
    admitted = undefined;
    expect(await executor.execute('session.message.send', input, {
      surface: 'agent', serverId: 'home', defaultSessionId: humanOrigin.sessionId,
    })).toMatchObject({ ok: false });
    expect(admitted).toBeUndefined();
  });
  it('refuses return without an admitted source Session before publishing an input', async () => {
    http.post.mockClear();
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId: 'receiver', mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null } });
    expect(await deps.sessionSendMessage({ sessionId: 'receiver', message: 'Return the result', reply: 'return',
      context: { surface: 'cli', authority: 'present_user' }, callerSurface: 'cli', actionCaller: { kind: 'host' },
      requestedAction: { v: 1, kind: 'enqueue' } })).toEqual({ status: 'rejected', code: 'session_input_untrusted_assertion' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each(['wait', 'return'] as const)('refuses sourceful %s without its actual source publisher before publishing', async reply => {
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId: 'source-session', mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null },
      getCurrentSessionWorkDepth: () => 0, getCurrentTurnWorkDepth: () => 0 });
    expect(await deps.sessionSendMessage({ sessionId: 'receiver', message: 'Answer this input', reply,
      sessionInputSource: { sourceSessionId: 'source-session', sourceTurnId: 'source-turn', via: 'action',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
      context: { surface: 'agent' }, callerSurface: 'agent', actionCaller: { kind: 'host' },
      requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ ok: false, errorCode: 'session_reply_source_unavailable' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('rejects an unwitnessed source Turn while qualified Session input can reach the same target', async () => {
    const receiverSessionId = 'cmv3hostadmissionaaaaaaaaa';
    const sourceSessionId = 'source-session';
    const sourceTurnId = 'session-turn';
    const machineAdmissionTransport = vi.fn<NonNullable<Parameters<typeof createCliActionDeps>[0]['machineAdmissionTransport']>>(
      async request => ({ status: 'accepted', localId: request.localId }),
    );
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200, data: createAccountEncryptionCurrentnessFixture(),
      };
      if (url.endsWith(`/v2/sessions/${receiverSessionId}`)) return { status: 200, data: {
        session: createSessionRecordFixture({ id: receiverSessionId, active: true,
          encryptionMode: 'plain', machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1' }) }),
      } };
      if (url.endsWith(`/v2/sessions/${sourceSessionId}`)) return { status: 200, data: {
        session: createSessionRecordFixture({ id: sourceSessionId, share: null }),
      } };
      throw new Error('Unexpected host admission HTTP read');
    });
    let readWitnessedTurnDepth: Parameters<typeof createCliActionDeps>[0]['getCurrentTurnWorkDepth'];
    const sourceAction = createDaemonSessionAccountActionExecutor({
      serverId: 'test-home', serverHttpBaseUrl: resolveServerHttpBaseUrl(), token: 'test-account-token',
      createExecutor: reader => {
        readWitnessedTurnDepth = reader;
        return createActionExecutor({
          ...createCliActionDeps({ token: 'test-account-token', sessionId: sourceSessionId, mode: 'plain', ctx: null }),
          // Notification delivery is a network boundary; the Session witness
          // producer and its exact-turn reader execute unmocked.
          notificationsNotifyMe: async () => ({ attemptedChannels: 1, deliveredChannels: 1 }),
        });
      },
    });
    await expect(sourceAction({ kind: 'action.execute', requestId: 'source-witness',
      actionId: 'notifications.notify_me', input: { message: 'Observe the source witness' },
      witness: { turnId: sourceTurnId, inputId: 'session-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
        agentStartCaller: { kind: 'session', sessionId: sourceSessionId, starterDepth: 0, turnDepth: 0 } },
    }, { sessionId: sourceSessionId, isCurrent: async () => true })).resolves.toMatchObject({ ok: true });
    if (!readWitnessedTurnDepth) throw new Error('The Session witness must install its exact-turn reader');
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId: sourceSessionId, mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null },
      getCurrentSessionWorkDepth: () => 0, getCurrentTurnWorkDepth: readWitnessedTurnDepth, machineAdmissionTransport });
    const context = { surface: 'agent' as const, runtimeRunId: 'run-id' };
    await expect(deps.sessionSendMessage({ sessionId: receiverSessionId, message: 'Qualified Session input',
      localId: 'qualified-input', wait: false,
      sessionInputSource: { sourceSessionId, sourceTurnId, sourceInputId: 'session-input', via: 'action',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
      context, callerSurface: 'agent', actionCaller: { kind: 'host' }, requestedAction: { v: 1, kind: 'enqueue' },
    })).resolves.toMatchObject({ status: 'accepted', localId: 'qualified-input' });
    expect(machineAdmissionTransport).toHaveBeenCalledOnce();
    machineAdmissionTransport.mockClear();
    expect(await deps.sessionSendMessage({ sessionId: receiverSessionId, message: 'Continue this work',
      sessionInputSource: { sourceSessionId, sourceTurnId: 'run-native-turn',
        sourceInputId: 'run-input', via: 'action', causalPermissionAuthority: {
          kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
        } },
      context, callerSurface: 'agent',
      actionCaller: { kind: 'session', sessionId: sourceSessionId, starterDepth: 0, turnDepth: 0 },
      requestedAction: { v: 1, kind: 'enqueue' },
    })).toMatchObject({ status: 'rejected', code: 'session_input_untrusted_assertion' });
    expect(http.post).not.toHaveBeenCalled();
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
    expect(await deps.sessionSendMessage({ sessionId: receiverSessionId, message: 'Mismatched source',
      requestedAction: { v: 1, kind: 'enqueue' },
      sessionInputSource: { sourceSessionId, sourceTurnId, sourceInputId: 'session-input', via: 'action',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
      context, callerSurface: 'agent', actionCaller: { kind: 'session', sessionId: 'another-source', starterDepth: 0, turnDepth: 0 },
    })).toMatchObject({ status: 'rejected', code: 'session_input_untrusted_assertion' });
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
  });

  it.each([{ surface: 'cli', partial: false }, { surface: 'voice', partial: false }, { surface: 'cli', partial: true }] as const)(
    'returns the exact typed inline outcome on $surface (stopped partial: $partial) after observation wins custody', async ({ surface, partial }) => {
    const sessionId = 'cmv3hostadmissionaaaaaaaaa';
    const localId = 'original-wait';
    let content: unknown;
    const progress = { v: 1, mode: 'wait', acceptedTurnId: 'accepted-turn',
      disposition: 'observing', outcome: partial ? { kind: 'cancelled', result: { sessionId, messageId: 'partial-row' } } : { kind: 'pass' } } as const;
    const socket = createApiSessionSocketStub({ connected: true });
    sockets.connect.mockImplementation(() => ({ socket, transport: createSocketTransportAdapter(socket as never) }));
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith(`/messages/by-local-id/${localId}/reply`)) return { status: 200,
        data: { v: 1, status: 'available', progress } };
      if (url.endsWith(`/messages/by-local-id/${localId}`)) return { status: 200, data: { message: {
        id: 'committed-input', seq: 7, localId, sidechainId: null, content, createdAt: Date.now(), updatedAt: Date.now(),
      } } };
      if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [{ id: 'partial-row', seq: 8, localId: 'partial',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'Stopped partial' } } } },
        createdAt: Date.now(), updatedAt: Date.now() }] } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: {
        id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: JSON.stringify({ permissionMode: 'default', permissionModeUpdatedAt: 1 }), metadataVersion: 1,
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null, encryptionMode: 'plain',
      } } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    const observations: unknown[] = [];
    http.post.mockImplementation(async (url: string, body: { content?: unknown }) => {
      if (url.endsWith('/pending')) { content = body.content; return { status: 200, data: { didWrite: true, terminal: false } }; }
      observations.push(body);
      return { status: 200, data: { v: 1, ok: true, progress: { ...progress, disposition: 'inline' } } };
    });
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId, mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null } });
    expect(await deps.sessionSendMessage({ sessionId, localId, message: 'Can you answer?', reply: 'wait',
      callerSurface: surface, actionCaller: { kind: 'host' }, context: { surface, authority: surface === 'cli' ? 'present_user' : 'account_automation' },
      requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ status: 'replied', localId,
        inputMessageRef: { messageId: 'committed-input' }, outcome: partial
          ? { kind: 'cancelled', partialText: 'Stopped partial', messageRef: { messageId: 'partial-row' } } : { kind: 'pass' } });
    expect(observations).toEqual([{ kind: 'inline' }]);
    expect(content).toMatchObject({ t: 'plain', v: { meta: { happierInputRequestV1: { replyIntent: { mode: 'wait' } } } } });
  });

  it.each(['reply', 'legacy_wait'] as const)('returns the accepted failed turn typed runtime cause with an ordinary CLI %s', async mode => {
    // Live shape (QA-WAVE-A r3, Gemini invalid key): custody fulfils `failed` on the accepted
    // ordinary turn, whose projection and transcript both carry the typed authentication issue.
    const sessionId = 'cmv3hostadmissionfailedaaa';
    const localId = 'original-failed-wait';
    const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'auth_error', source: 'auth_error',
      occurredAt: 1794715969620, agentId: 'gemini', sanitizedPreview: 'Authentication failed',
      failureCause: { phase: 'authentication', failureReason: 'authentication_required' } } as const;
    const runtimeMeta = { sentFrom: 'cli', source: 'runtime', runtimeIssueCode: 'auth_error', runtimeIssueSource: 'auth_error',
      runtimeIssueV1, runtimeIssueProvider: 'gemini' };
    let content: unknown;
    const progress = { v: 1, mode: 'wait', acceptedTurnId: 'native-turn-1', disposition: 'observing', outcome: { kind: 'failed' } } as const;
    const socket = createApiSessionSocketStub({ connected: true });
    sockets.connect.mockImplementation(() => ({ socket, transport: createSocketTransportAdapter(socket as never) }));
    const row = (seq: number, id: string, v: unknown) => ({ id, seq, localId: null, content: { t: 'plain', v }, createdAt: seq, updatedAt: seq });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith(`/messages/by-local-id/${localId}/reply`)) return { status: 200,
        data: { v: 1, status: 'available', progress } };
      if (url.endsWith(`/messages/by-local-id/${localId}`)) return { status: 200, data: { message: {
        id: 'committed-input', seq: 2, localId, sidechainId: null, content, createdAt: 2, updatedAt: 2 } } };
      if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 5, turns: [{
        turnId: 'native-turn-1', status: 'failed', startedAt: 3, updatedAt: 5, terminalAt: 5, lastRuntimeIssue: runtimeIssueV1,
        transcriptAnchors: { startUserMessageSeq: 2, userMessageSeqs: [2], startSeqInclusive: 2, endSeqInclusive: 5 } }] } };
      if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [
        row(4, 'issue-row', { role: 'agent', content: { type: 'acp', agentId: 'gemini',
          data: { type: 'message', message: 'gemini turn failed: Authentication failed' } }, meta: runtimeMeta }),
        row(5, 'failed-marker', { role: 'agent', content: { type: 'acp', agentId: 'gemini',
          data: { type: 'turn_failed', id: 'native-turn-1' } }, meta: { ...runtimeMeta, runtimeEventKind: 'turn-failed', runtimeTurnId: 'native-turn-1' } }),
      ] } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: {
        id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: JSON.stringify({ permissionMode: 'default', permissionModeUpdatedAt: 1 }), metadataVersion: 1,
        agentState: null, agentStateVersion: 0, dataEncryptionKey: null, encryptionMode: 'plain',
        latestTurnStatus: 'failed', latestTurnStatusObservedAt: 5, lastRuntimeIssue: runtimeIssueV1,
      } } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    http.post.mockImplementation(async (url: string, body: { content?: unknown }) => {
      if (url.endsWith('/pending')) { content = body.content; return { status: 200, data: { didWrite: true, terminal: false } }; }
      return { status: 200, data: { v: 1, ok: true, progress: { ...progress, disposition: 'inline' } } };
    });
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId, mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null } });
    const sent = await deps.sessionSendMessage({ sessionId, localId, message: 'No tools. Reply A_CP2_OK.', ...(mode === 'reply' ? { reply: 'wait' as const } : { wait: true }),
      callerSurface: 'cli', actionCaller: { kind: 'host' }, context: { surface: 'cli', authority: 'present_user' },
      requestedAction: { v: 1, kind: 'enqueue' } });
    expect(sent).toEqual(mode === 'reply'
      ? { status: 'replied', localId, inputMessageRef: expect.objectContaining({ messageId: 'committed-input' }),
        outcome: { kind: 'failed', runtimeIssueV1 } }
      : { status: 'failed', localId, code: 'session_input_turn_failed', runtimeIssueV1 });
    expect(SessionMessageSendResultV1Schema.parse(sent)).toEqual(sent);
  });

  it.each(['wait', 'return'] as const)('settles sourceful %s through the existing authenticated SessionAction transport', async reply => {
    const receiverId = 'cmv3hostadmissionaaaaaaaaa';
    const sourceId = 'source-session';
    const localId = 'original-remote-observation';
    const source = { sourceSessionId: sourceId, sourceTurnId: 'source-turn', sourceInputId: 'source-input', via: 'action' as const,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } };
    const { causalPermissionAuthority: _authority, ...sourceSession } = source;
    const progress = { v: 1, mode: reply, sourceSession, acceptedTurnId: 'receiver-turn', disposition: 'observing', outcome: { kind: 'pass' } } as const;
    let content: unknown;
    const socket = createApiSessionSocketStub({ connected: true });
    sockets.connect.mockImplementation(() => ({ socket, transport: createSocketTransportAdapter(socket as never) }));
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
      if (url.endsWith(`/messages/by-local-id/${localId}/reply`)) return { status: 200, data: { v: 1, status: 'available', progress } };
      if (url.endsWith(`/messages/by-local-id/${localId}`)) return { status: 200, data: { message: {
        id: 'committed-remote-input', seq: 7, localId, content, createdAt: Date.now(), updatedAt: Date.now(),
      } } };
      const id = url.endsWith(`/v2/sessions/${sourceId}`) ? sourceId : receiverId;
      if (url.endsWith(`/v2/sessions/${id}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id, encryptionMode: 'plain', active: true, machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1' }),
      }) } };
      throw new Error(`Unexpected remote observation read: ${url}`);
    });
    const observations: unknown[] = [];
    const sessionActionRpcTransport: NonNullable<Parameters<typeof createCliActionDeps>[0]['sessionActionRpcTransport']> = async request => {
      observations.push(request);
      return { v: 1, ok: true, progress: { ...progress, disposition: reply === 'wait' ? 'inline' : 'return_pending' } };
    };
    const deps = createCliActionDeps({ token: 'test-account-token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null }, sessionActionRpcTransport,
      getCurrentTurnWorkDepth: () => 0,
      machineAdmissionTransport: async request => { content = request.content; return { status: 'accepted', localId: request.localId }; },
    });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionRequestId: 'source-action',
      actionCaller: { kind: 'session' as const, sessionId: sourceId, starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default' as const, sessionInputSource: source };
    expect(await deps.sessionSendMessage({ sessionId: receiverId, localId, message: 'Answer this original request', reply,
      sessionInputSource: source, context, callerSurface: 'agent', actionCaller: context.actionCaller,
      requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({
      status: reply === 'wait' ? 'replied' : 'accepted', localId,
    });
    expect(observations).toEqual([expect.objectContaining({ sessionId: sourceId, method: 'session.message.reply.observe.v1',
      input: { requestSessionId: receiverId, requestLocalId: localId, operation: reply === 'wait' ? 'inline' : 'release' },
      origin: expect.objectContaining({ caller: context.actionCaller, sourceTurnId: source.sourceTurnId, sourceInputId: source.sourceInputId }),
    })]);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('admits ordinary CLI input without dropping its target permission defaults', async () => {
    const sessionId = 'cmv3hostadmissionaaaaaaaaa';
    const metadata = JSON.stringify({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 1 });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (url.includes('/v2/sessions/')) return { status: 200, data: { session: {
        id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata, metadataVersion: 1, agentState: null, agentStateVersion: 0,
        dataEncryptionKey: null, encryptionMode: 'plain',
      } } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    http.post.mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false, suppressed: false } });
    const deps = createCliActionDeps({
      token: 'test-account-token', sessionId, mode: 'plain', ctx: null,
      credentials: { token: 'test-account-token', encryption: null },
    });
    await expect(deps.sessionSendMessage!({
      sessionId, message: 'Start the panel workflow', callerSurface: 'cli',
      actionCaller: { kind: 'host' }, localId: 'host-input', wait: false,
      context: { surface: 'cli', authority: 'present_user' },
      requestedAction: { v: 1, kind: 'enqueue' },
    })).resolves.toMatchObject({ status: 'accepted', localId: 'host-input' });
    const write = http.post.mock.calls.find(([url]) => String(url).endsWith(`/v2/sessions/${sessionId}/pending`));
    expect(write?.[1]).toMatchObject({ content: { t: 'plain', v: { meta: {
      permissionMode: 'safe-yolo', happierProvenanceV1: { v: 1, kind: 'cli' },
      happierInputRequestV1: { v: 1, producer: 'cli', caller: { kind: 'host' } },
    } } } });
    expect(SessionInputRequestV1Schema.safeParse(write?.[1].content.v.meta.happierInputRequestV1).success).toBe(true);
  });

  it('protects an API-token Session input so causal permission authority can reach provider dispatch', async () => {
    const sessionId = 'cmv3apitokenadmissionaaaa';
    const machineId = 'api-token-machine';
    const target = { kind: 'session' as const, sessionId };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [sessionId], machines: [] },
      permissionModes: ['default' as const] };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'requester-proof',
      binding: {
        accountId: 'api-account', principalId: 'api-principal', credentialId: 'api-credential', grant,
        serverIdentityId: 'api-home', machineId, custodianAccountId: 'api-account', installationId: 'api-installation',
        actionId: 'session.message.send', requestId: 'api-message', target,
        requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
      },
    });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: 'plain', machineId,
        metadata: JSON.stringify({ machineId, permissionMode: 'default', permissionModeUpdatedAt: 1 }),
      }) } };
      throw new Error(`Unexpected API-token admission read: ${url}`);
    });
    const admitted: unknown[] = [];
    const machineAdmissionTransport: NonNullable<Parameters<typeof createCliActionDeps>[0]['machineAdmissionTransport']> =
      async request => { admitted.push(request); return { status: 'accepted', localId: request.localId }; };
    const deps = createCliActionDeps({
      token: 'daemon-token', credentials: { token: 'daemon-token', encryption: null },
      sessionId: 'daemon-global', mode: 'plain', ctx: null, serverIdentityId: 'api-home', machineAdmissionTransport,
      externalActionMachineInstallationId: 'api-installation',
      externalActionMachineRequestPrivateKey: new Uint8Array(64),
    });
    const result = await deps.sessionSendMessage!({
      sessionId, message: 'Run a command that requires approval', localId: 'api-input', wait: false,
      callerInputConstraints: grant, callerSurface: 'api', actionCaller: { kind: 'host' },
      context: {
        surface: 'api', authority: 'account_automation', externalActionTarget: target,
        externalActionCredential: { accountId: 'api-account', principalId: 'api-principal',
          credentialId: 'api-credential', grant },
        externalActionExecutionAuthorization: authorization,
      },
      requestedAction: { v: 1, kind: 'enqueue' },
    });
    expect(result).toEqual({ status: 'accepted', localId: 'api-input' });
    expect(admitted).toEqual([expect.objectContaining({ content: expect.objectContaining({
      t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
        happierInputRequestV1: expect.objectContaining({ producer: 'sessionAction', caller: { kind: 'host' } }),
      }) }),
    }) })]);
    expect(http.post).not.toHaveBeenCalled();
  });
});
