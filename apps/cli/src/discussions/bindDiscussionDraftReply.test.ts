import { beforeEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent, FeaturesResponseSchema, accountSettingsParse,
  normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createDiscussionActionDeps } from './discussionActionDeps';
import { bindDiscussionDraftReply } from './bindDiscussionDraftReply';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import nacl from 'tweetnacl';
import { mintExternalActionExecutionAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';

const http = vi.hoisted(() => ({ defaults: {}, request: vi.fn(), get: vi.fn(), post: vi.fn() }));
// Only authenticated Home HTTP is replaced. Participant decoding and the
// Discussion Action dependency retain their production implementations.
vi.mock('axios', () => ({ default: http }));

const participantSessionId = 'c123456789012345678901234';
const source = { sourceSessionId: participantSessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' as const,
  discussionAddressing: { discussionId: 'discussion', messageId: 'question', throughSeq: 3, participantSessionId: participantSessionId } };
const homeIdentityId = 'srv_draft_home';
const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', serverIdentityId: homeIdentityId,
  defaultSessionId: participantSessionId, actionCaller: { kind: 'session', sessionId: participantSessionId, starterDepth: 1, turnDepth: 1 }, sessionInputSource: source,
  actionRequestId: 'tool-request' };
const input = { discussionId: 'discussion', localId: 'tool-local', content: { v: 1, parts: [{ t: 'text', text: 'Draft answer' }] } };
const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({
  features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
  capabilities: { serverIdentity: { serverIdentityId: homeIdentityId } },
}) };
const readRoster = createDiscussionActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home', serverIdentityId: homeIdentityId,
  serverHttpBaseUrl: 'https://draft-reply.test', resolveServerFeaturesSnapshot: () => features }).discussionAction!;

beforeEach(() => {
  vi.restoreAllMocks();
  http.request.mockReset();
  http.get.mockReset();
  http.post.mockReset();
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy: 'drafts_for_approval', createdAt: 1 }] } });
});

it.each(['draft', 'informational'] as const)('normalizes the verified daemon Session input before signed authorization (%s)', async originalKind => {
  const { createDaemonSessionAccountActionExecutor } = await import('@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor');
  const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const informational = originalKind === 'informational';
  const actionInput = informational ? { ...input, replyTarget: { kind: 'message', messageId: 'question' } } : input;
  if (informational) http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy: 'when_addressed', createdAt: 1 }] } });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(features.features));
  http.get.mockImplementation(async (url: string) => {
    if (new URL(url).pathname === `/v2/sessions/${participantSessionId}`) return { status: 200,
      data: { session: { ...createSessionNotificationContextFixture(participantSessionId), encryptionMode: 'plain', metadata: '{}' } } };
    if (new URL(url).pathname === '/v1/features') return { status: 200, data: features.features };
    if (new URL(url).pathname.endsWith('/messages/by-local-id/input/reply')) return { status: 200, data: {
      v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'turn',
        discussion: source.discussionAddressing },
    } };
    throw new Error(`Unexpected daemon read: ${url}`);
  });
  const localId = informational ? 'tool-request'
    : deriveSessionMessageReplyReturnLocalIdV1({ sessionId: participantSessionId, localId: 'input', acceptedTurnId: 'turn' });
  const expectedInput = informational ? actionInput : { ...input, localId, replyTarget: { kind: 'message', messageId: 'question' } };
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(47));
  const target = { kind: 'machine' as const, machineId: 'machine' };
  http.post.mockImplementation(async (url: string, raw: unknown) => {
    expect(new URL(url).pathname).toBe(bindExternalActionExecutionAuthorizationHttpPathV1('discussion.reply'));
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
    const payload = { version: 1 as const, accountId: 'owner', machineId: 'machine', installationId: 'installation',
      externalActionOrigin: { homeId: homeIdentityId, actionId: 'discussion.reply', requestId: localId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.sessionActionOrigin! } };
    expect(verifyMachineInstallationProof({ payload, proof: request.installationProof!, publicKey: keys.publicKey })).toBe(true);
    expect(request.envelope).toMatchObject({ requestId: localId, input: expectedInput });
    return { status: 200, data: { v: 1, token: 'home-issued-reply-root', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeIdentityId, machineId: 'machine',
      custodianAccountId: 'owner', installationId: 'installation', actionId: 'discussion.reply', requestId: localId, target,
      accountEncryptionMode: 'plain', requestEnvelopeDigest: payload.externalActionOrigin.requestEnvelopeDigest,
      sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: { machineId: 'machine', installationId: 'installation' },
    } } };
  });
  const signedPreparation = vi.fn<NonNullable<Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']>>(
    async request => {
      expect(request.operation).toMatchObject({ actionId: 'discussion.reply', requestId: localId,
        input: expectedInput });
      expect(request.sessionActionOrigin).toMatchObject({ sourceTurnId: 'turn', sourceInputId: 'input' });
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: request.operation.requestId, input: request.operation.input, target });
      const minted = await mintExternalActionExecutionAuthorization({ actionId: request.operation.actionId, envelope,
        machineId: 'machine', pat: token, serverHttpBaseUrl: 'https://draft-reply.test', sessionActionOrigin: request.sessionActionOrigin,
        sessionActionSource: { machineId: 'machine', installationId: 'installation' }, installationProof: signMachineInstallationProof({
          privateKey: keys.secretKey, payload: { version: 1, accountId: 'owner', machineId: 'machine', installationId: 'installation',
            externalActionOrigin: { homeId: homeIdentityId, actionId: request.operation.actionId, requestId: request.operation.requestId,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: request.sessionActionOrigin } },
        }) });
      return minted.ok ? { authorization: minted.authorization, target } : null;
    });
  const execute = createDaemonSessionAccountActionExecutor({ serverId: 'home', serverHttpBaseUrl: 'https://draft-reply.test',
    token, credentials: { token, encryption: null }, prepareExternalActionAuthorization: signedPreparation,
    resolveServerFeaturesSnapshot: () => features,
    createExecutor: () => createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: participantSessionId, mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: homeIdentityId, serverHttpBaseUrl: 'https://draft-reply.test', pluginActionExecutionOwner: 'current_process',
      getCurrentSessionMetadata: () => ({}),
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {
        'discussion.post': { enabled: false }, 'discussion.reply': { enabled: false },
      } }) },
    }),
  });
  const result = await execute({ kind: 'action.execute', actionId: informational ? 'discussion.reply' : 'discussion.post', input: actionInput, requestId: 'tool-request',
    witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 1,
      agentStartCaller: { kind: 'session', sessionId: participantSessionId, starterDepth: 1, turnDepth: 1 }, discussionAddressing: source.discussionAddressing } },
  { sessionId: participantSessionId, isCurrent: async () => true });
  expect(signedPreparation).toHaveBeenCalledTimes(1);
  expect(http.post).toHaveBeenCalledTimes(1);
  // The daemon captured policy before signing; the downstream host preserves
  // those exact operands and performs no second policy preparation.
  expect(http.request).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
});

it.each(['discussion.post', 'discussion.reply'] as const)('binds an addressed %s across the saved profile and canonical Home before approval captures it', async actionId => {
  const result = await bindDiscussionDraftReply({ actionId, input: { ...input,
    ...(actionId === 'discussion.reply' ? { replyTarget: { kind: 'message', messageId: 'question' } } : {}) },
    context: { ...context, serverId: homeIdentityId }, serverId: 'home', serverIdentityId: homeIdentityId, discussionAction: readRoster });
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: participantSessionId, localId: 'input', acceptedTurnId: 'turn' });
  expect(result).toMatchObject({ actionId: 'discussion.reply', input: { ...input, localId,
    replyTarget: { kind: 'message', messageId: 'question' } }, context: { actionRequestId: localId,
    sessionInputSource: source, discussionReplyReturn: { serverId: homeIdentityId, requestLocalId: 'input', acceptedTurnId: 'turn' } } });
  expect(http.request.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/v1/discussions/discussion/participants']);
  expect(context).not.toHaveProperty('discussionReplyReturn');
  expect(input.localId).toBe('tool-local');
});

it('does not bind a draft from a foreign Home with a matching identity hint', async () => {
  const foreign = { ...context, serverId: 'srv_foreign' };
  expect(await bindDiscussionDraftReply({ actionId: 'discussion.post', input, context: foreign,
    serverId: 'home', serverIdentityId: homeIdentityId, discussionAction: readRoster }))
    .toEqual({ actionId: 'discussion.post', input, context: foreign });
  expect(http.request).not.toHaveBeenCalled();
});

it.each(['when_addressed', 'reads_only', 'watches_and_speaks_up'] as const)('preserves independent explicit publication under %s', async answerPolicy => {
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy, createdAt: 1 }] } });
  expect(await bindDiscussionDraftReply({ actionId: 'discussion.post', input, context, serverId: 'home', discussionAction: readRoster }))
    .toEqual({ actionId: 'discussion.post', input, context });
});

it('does not promote a prior informational input when its participant policy changes to when-addressed', async () => {
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy: 'when_addressed', createdAt: 1 }] } });
  const reply = { ...input, replyTarget: { kind: 'message', messageId: 'question' } };
  const progress = { v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'turn', discussion: source.discussionAddressing };
  http.get.mockResolvedValue({ status: 200, data: { v: 1, status: 'available', progress } });
  expect(await bindDiscussionDraftReply({ actionId: 'discussion.reply', input: reply, context, serverId: 'home',
    discussionAction: readRoster, credentials: { token: 'token' }, serverHttpBaseUrl: 'https://draft-reply.test' }))
    .toEqual({ actionId: 'discussion.reply', input: reply, context });
});

it.each([
  { acceptedTurnId: 'unrelated-turn' },
  { discussion: { ...source.discussionAddressing, participantSessionId: 'another-participant' } },
  { disposition: 'released' },
])('refuses a stale or mismatched original return before approval ($acceptedTurnId $disposition)', async override => {
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy: 'when_addressed', createdAt: 1 }] } });
  http.get.mockResolvedValue({ status: 200, data: { v: 1, status: 'available', progress: {
    v: 1, mode: 'return', disposition: 'observing', acceptedTurnId: 'turn', discussion: source.discussionAddressing, ...override,
  } } });
  expect(await bindDiscussionDraftReply({ actionId: 'discussion.reply', input: { ...input,
    replyTarget: { kind: 'message', messageId: 'question' } }, context, serverId: 'home', discussionAction: readRoster,
    credentials: { token: 'token' }, serverHttpBaseUrl: 'https://draft-reply.test' }))
    .toMatchObject({ failure: { ok: false, errorCode: 'discussion_content_unavailable' } });
});

it('holds an addressed publication when its persisted policy read is unavailable', async () => {
  http.request.mockRejectedValue(new Error('Home unavailable'));
  expect(await bindDiscussionDraftReply({ actionId: 'discussion.post', input, context, serverId: 'home', discussionAction: readRoster }))
    .toMatchObject({ failure: { ok: false, errorCode: 'discussion_content_unavailable' } });
});

it.each(['drafts_for_approval', 'watches_and_speaks_up'] as const)('preserves already admitted signed operands without another policy read (%s)', async answerPolicy => {
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy, createdAt: 1 }] } });
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(53));
  const signedRoster = createDiscussionActionDeps({ credentials: { token: 'token', encryption: null }, serverId: 'home',
    serverIdentityId: homeIdentityId, serverHttpBaseUrl: 'https://draft-reply.test', resolveServerFeaturesSnapshot: () => features,
    externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' }).discussionAction!;
  const invocation: ActionExecutorContext = { ...context, externalActionTarget: { kind: 'machine', machineId: 'machine' },
    externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1, token: 'home-issued-root', binding: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: homeIdentityId, machineId: 'machine', custodianAccountId: 'owner', installationId: 'installation',
      actionId: 'discussion.post', requestId: 'tool-request', target: { kind: 'machine', machineId: 'machine' },
      accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
        ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'tool-request', target: { kind: 'machine', machineId: 'machine' }, input })) },
  }) };
  const result = await bindDiscussionDraftReply({ actionId: 'discussion.post', input, context: invocation, serverId: 'home', discussionAction: signedRoster });
  expect(result).toEqual({ actionId: 'discussion.post', input, context: invocation });
  expect(http.request).not.toHaveBeenCalled();
});

it.each([
  { method: 'execute', caller: 'session' }, { method: 'prepare', caller: 'session' },
  { method: 'execute', caller: 'agent_default_session' },
  { method: 'execute', caller: 'session_reply_enabled' },
] as const)('captures the canonical explicit reply through the production CLI $method entry ($caller)', async ({ method, caller }) => {
  const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const settings = accountSettingsParse({});
  const artifacts = new Map<string, Readonly<Record<string, unknown>>>();
  http.get.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    if (path.startsWith('/v1/artifacts/')) {
      const artifact = artifacts.get(decodeURIComponent(path.split('/').at(-1)!));
      return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'Artifact not found' } };
    }
    throw new Error(`Unexpected approval HTTP read: ${path}`);
  });
  const captured: unknown[] = [];
  http.post.mockImplementation(async (url: string, body: Record<string, unknown> & { id: string; body: string }) => {
    if (new URL(url).pathname !== '/v1/artifacts') throw new Error('Unexpected approval HTTP write');
    const content = decodePlainArtifactStoredContent(body.body);
    if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Invalid private approval carrier');
    captured.push(JSON.parse(content.body));
    const { idScope: _idScope, ...stored } = body;
    artifacts.set(body.id, { ...stored, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    return { status: 200, data: artifacts.get(body.id) };
  });
  const publisher = vi.fn();
  const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: participantSessionId, mode: 'plain', ctx: null,
    serverId: 'home', serverIdentityId: homeIdentityId, serverHttpBaseUrl: 'https://draft-reply.test', pluginActionExecutionOwner: 'current_process',
    resolveServerFeaturesSnapshot: () => features, getCurrentSessionMetadata: () => ({}), postAgentDiscussionMessage: publisher,
    actionsSettingsProvider: { getAccountSettings: () => settings, getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      ...(caller === 'session_reply_enabled' ? { actions: { 'discussion.post': { enabled: false }, 'discussion.reply': { enabled: true } } } : {}),
      approvalWaivedSurfaces: { 'discussion.post': ['agent'], 'discussion.reply': ['agent'] } }) },
  });
  const result = await runWithServerHttpBaseUrl('https://draft-reply.test', () => executor[method]('discussion.post', input,
    { ...context, ...(caller === 'agent_default_session' ? { actionCaller: { kind: 'host' as const } } : {}),
      defaultSessionMachineId: 'machine', serverIdentityId: homeIdentityId }));
  expect(http.request.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith('/participants'))).toHaveLength(1);
  expect(result, JSON.stringify({ result, reads: http.get.mock.calls.map(([url]) => url),
    writes: http.post.mock.calls.map(([url]) => url) })).toMatchObject(method === 'prepare' ? { kind: 'settled', result: { ok: true } } : { ok: true });
  expect(captured).toHaveLength(1);
  const request = ApprovalRequestV2Schema.parse(captured[0]);
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: participantSessionId, localId: 'input', acceptedTurnId: 'turn' });
  expect(request).toMatchObject({ actionId: 'discussion.reply', discussionDraftReview: true, actionArgs: { ...input, localId,
    replyTarget: { kind: 'message', messageId: 'question' } }, executionOriginV1: { actionId: 'discussion.reply', requestId: localId,
    sessionId: participantSessionId, sessionInputSource: source,
    discussionReplyReturn: { serverId: homeIdentityId, requestLocalId: 'input', acceptedTurnId: 'turn' } } });
  expect(publisher).not.toHaveBeenCalled();
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy: 'reads_only', createdAt: 1 }] } });
  expect(await executor.execute('discussion.post', input, { ...context,
    ...(caller === 'agent_default_session' ? { actionCaller: { kind: 'host' as const } } : {}),
    defaultSessionMachineId: 'machine' })).toMatchObject({ ok: false,
      errorCode: caller === 'session_reply_enabled' ? 'action_disabled' : 'discussion_answer_policy_denied' });
  expect(http.request.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith('/participants'))).toHaveLength(2);
  expect(captured).toHaveLength(1);
  expect(publisher).not.toHaveBeenCalled();
});

it('denies a reads-only agent default Session before any approval or publication', async () => {
  const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  http.request.mockResolvedValue({ status: 200, data: { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: participantSessionId }, answerPolicy: 'reads_only', createdAt: 1 }] } });
  const publisher = vi.fn();
  const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: participantSessionId, mode: 'plain', ctx: null,
    serverId: 'home', serverIdentityId: homeIdentityId, serverHttpBaseUrl: 'https://draft-reply.test', pluginActionExecutionOwner: 'current_process',
    resolveServerFeaturesSnapshot: () => features, getCurrentSessionMetadata: () => ({}), postAgentDiscussionMessage: publisher,
    actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}),
      getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'discussion.post': ['agent'] } }) } });
  expect(await executor.execute('discussion.post', input, { ...context, actionCaller: { kind: 'host' },
    defaultSessionMachineId: 'machine' })).toMatchObject({ ok: false, errorCode: 'discussion_answer_policy_denied' });
  expect(http.request.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith('/participants'))).toHaveLength(1);
  expect(http.post).not.toHaveBeenCalled();
  expect(publisher).not.toHaveBeenCalled();
});

it('does not borrow the daemon credential for unsigned restricted publication preparation', async () => {
  const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const publisher = vi.fn();
  const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: participantSessionId, mode: 'plain', ctx: null,
    serverId: 'home', serverIdentityId: homeIdentityId, serverHttpBaseUrl: 'https://draft-reply.test', pluginActionExecutionOwner: 'current_process',
    resolveServerFeaturesSnapshot: () => features, getCurrentSessionMetadata: () => ({}), postAgentDiscussionMessage: publisher,
    actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}),
      getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
  expect(await executor.execute('discussion.post', input, { ...context, defaultSessionMachineId: 'machine',
    externalActionCredential: { accountId: 'owner', principalId: 'principal', credentialId: 'credential',
      grant: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['discussion.post'] } }) } }))
    .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  expect(http.request).not.toHaveBeenCalled();
  expect(http.post).not.toHaveBeenCalled();
  expect(publisher).not.toHaveBeenCalled();
});

it.each(['different_reply', 'different_discussion', 'different_participant', 'missing_input', 'human', 'terminal_return'] as const)(
  'does not absorb an unbound explicit publication (%s)', async kind => {
    const caller = context.actionCaller;
    if (caller?.kind !== 'session') throw new Error('Expected the original Session caller fixture');
    const explicit = kind === 'different_reply' ? { ...input, replyTarget: { kind: 'message', messageId: 'other-question' } }
      : kind === 'different_discussion' ? { ...input, discussionId: 'other-discussion' } : input;
    const invocation = kind === 'different_participant' ? { ...context, actionCaller: { ...caller, sessionId: 'other-participant' } }
      : kind === 'missing_input' ? { ...context, sessionInputSource: { ...source, sourceInputId: undefined } }
      : kind === 'human' ? { ...context, surface: 'ui' as const, actionCaller: { kind: 'host' as const } }
      : kind === 'terminal_return' ? { ...context, discussionReplyReturn: { serverId: 'home', requestLocalId: 'input', acceptedTurnId: 'turn' } }
      : context;
    expect(await bindDiscussionDraftReply({ actionId: 'discussion.post', input: explicit, context: invocation,
      serverId: 'home', discussionAction: readRoster })).toEqual({ actionId: 'discussion.post', input: explicit, context: invocation });
    expect(http.request).not.toHaveBeenCalled();
  });
