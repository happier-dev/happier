import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import nacl from 'tweetnacl';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema, FeaturesResponseSchema, createActionExecutor, deriveSessionCreationTagV1, deriveAccountMachineKeyFromRecoverySecret,
  sealEncryptedDataKeyEnvelopeV1, SessionPendingEnqueueByMachineRequestV1Schema, SessionMessageSendResultV1Schema,
  withParticipantRecipientV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { sendSessionMessage, waitForSessionInputResult } from './sendSessionMessage';
import { resolveSessionUserMessageRequestedAction } from './resolveSessionUserMessageRequestedAction';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { ApiMachineClient } from '@/api/apiMachine';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createUserScopedSocket, createSessionScopedSocketConnection } from '@/api/session/sockets';
import { sealSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encodeBase64 } from '@/api/encryption';
import { encryptSessionPayload, decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import * as installationIdentity from '@/daemon/identity/store';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { SessionMessageContentSchema, UserMessageSchema, type UserMessage } from '@/api/types';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { resolveStartupPermissionModeFromSession } from '@/agent/runtime/permissions/startupSeed';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readSessionInputForgeEvidenceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { configuration } from '@/configuration';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';

// HTTP and fetch are the real process boundaries; authoring, crypto envelopes,
// Session resolution, capability parsing and Pending transport stay real.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const sockets = vi.hoisted(() => ({ createUserScopedSocket: vi.fn(), createSessionScopedSocketConnection: vi.fn() }));
let observationSocket: EventEmitter;
const rpc = vi.hoisted(() => ({ callSessionRpc: vi.fn() }));
vi.mock('axios', () => ({ default: { ...http, defaults: {}, isAxiosError: () => false } }));
vi.mock('@/api/session/sockets', () => sockets);
vi.mock('@/session/transport/rpc/sessionRpc', () => rpc);

const sessionId = 'c123456789012345678901234';
const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
const cliActionContext = { surface: 'cli' as const, authority: 'present_user' as const, defaultSessionId: null };
it('preserves explicit Run recovery while bootstrapping its inactive parent', () => {
  const recovery = { v: 2, kind: 'recover_execution_run' } as const;
  expect(resolveSessionUserMessageRequestedAction({ deliveryIntent: 'runtime_bootstrap', requestedAction: recovery })).toEqual(recovery);
  expect(resolveSessionUserMessageRequestedAction({ deliveryIntent: 'runtime_bootstrap', requestedAction: { v: 1, kind: 'enqueue' } }))
    .toEqual({ v: 1, kind: 'send_now' });
});
// Plain-account cases retain this key only to read historical encrypted rows.
const credentials = { token: 'target-send-test', accountE2eeCustody: 'historical' as const,
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
const correspondence = {
  v: 1,
  sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'target-send-test' }),
  recipe: {
    execution: { machineId: 'machine-a', directory: { kind: 'path', path: '/workspace' } },
    organization: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    modelSelection: null, profileId: null, requestedPermissionMode: null,
    agentModeId: null, configuration: null, connectedServices: null, capabilitySelection: null,
    transcriptStorage: null, terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
  },
};

function mockRunReads(inputTurns: readonly unknown[]) {
  let readIndex = 0;
  let resolveRead!: () => void;
  const firstRead = new Promise<void>((resolve) => { resolveRead = resolve; });
  const run = () => ({
        runId: 'run-a', callId: 'call-a', sidechainId: 'sidechain-a', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read-only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        inputTurns: inputTurns[Math.min(readIndex, inputTurns.length - 1)],
      });
  rpc.callSessionRpc.mockImplementation(async () => {
    resolveRead();
    return { ok: true, data: { run: run() } };
  });
  return { firstRead, advance: () => {
    readIndex += 1;
    observationSocket.emit('ephemeral', { type: 'execution-run-updated', sessionId, run: run() });
  } };
}

describe('target Session input authoring through HTTP', () => {
  it.each([{ mode: 'plain', malformed: false }, { mode: 'e2ee', malformed: false }, { mode: 'plain', malformed: true }] as const)(
    'admits Bob Follow through Account HTTP and rejoins a late accepted original ($mode, malformed forge metadata=$malformed)', async ({ mode, malformed }) => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.fixture`;
    const secret = new Uint8Array(32).fill(17);
    const ctx = { encryptionKey: secret, encryptionVariant: 'legacy' as const };
    const forgeEvidence = { v: 1 as const, items: [{ source: { kind: 'localTerminal' as const, label: 'Selected failing output' },
      author: { kind: 'process' as const }, text: 'Preserve evidence independently from prompt text.' }] };
    let storedMessageMeta: unknown;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/currentness')) return { status: 200, data: { mode, version: 1, updatedAt: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null } };
      if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: mode, share: null, dataEncryptionKey: null,
        metadata: mode === 'plain' ? JSON.stringify({ machineId: 'machine-a' })
          : encryptSessionPayload({ ctx, payload: { machineId: 'machine-a' } }),
      }) } };
      throw new Error(`Unexpected read: ${url}`);
    });
    http.post.mockImplementation(async (url: string, body: unknown, config) => {
      expect(url).toContain(`/v2/sessions/${sessionId}/pending`);
      expect(config.headers.Authorization).toBe(`Bearer ${token}`);
      expect(body).toMatchObject({ followSources: [{ evaluation: 'receiver', rule: { ruleId: 'bob-private-rule', ruleVersion: 3 } }],
        followRelations: [{ relation: 'follower' }], followDeliveryV1: { original: { sourceSessionId: 'c222222222222222222222222' } } });
      if (!body || typeof body !== 'object') throw new Error('Expected the real Pending HTTP request');
      const payload = mode === 'plain' ? (() => {
        const content = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
        if (content.t !== 'plain') throw new Error('Expected plain stored content');
        return content.v;
      })() : (() => {
        const ciphertextBase64 = Reflect.get(body, 'ciphertext');
        if (typeof ciphertextBase64 !== 'string') throw new Error('Expected encrypted stored content');
        return decryptSessionPayload({ ctx, ciphertextBase64 });
      })();
      if (!payload || typeof payload !== 'object') throw new Error('Expected the complete stored message record');
      storedMessageMeta = Reflect.get(payload, 'meta');
      return { status: 200, data: { didWrite: false, terminal: true, message: { localId: 'earlier-accepted-input' } } };
    });
    const admission = buildTrustedHostSessionInputAdmissionV1('agent');
    const result = await sendSessionMessage({ credentials: { token, encryption: mode === 'plain' ? null : { type: 'legacy', secret } },
      idOrPrefix: sessionId, localId: 'late-route-attempt', message: 'Read the followed original', wait: false,
      messageMeta: { forgeEvidence: malformed ? { ...forgeEvidence, authority: 'approved' } : forgeEvidence },
      timeoutMs: 1000, resumeInactiveSession: false, informationDelivery: 'session_follow', executionAuthority: 'account_automation',
      inputAdmission: { ...admission, request: { ...admission.request, followDeliveryV1: {
        v: 1, delivery: 'next_turn', original: { sourceSessionId: 'c222222222222222222222222', sourceTurn: { id: 'host-turn', status: 'failed' } },
        event: { kind: 'failed_or_stopped' },
      } } }, followSources: [{ evaluation: 'receiver', selectedDelivery: 'next_turn', sourceSessionId: 'c222222222222222222222222', destinationSessionId: sessionId,
        sourceTurn: { id: 'host-turn', status: 'failed' }, rule: { ruleId: 'bob-private-rule', ruleVersion: 3 } }],
      followRelations: [{ relation: 'follower' }],
    });
    expect(result).toMatchObject({ ok: true, localId: 'earlier-accepted-input', terminal: true,
      admissionResult: { status: 'alreadyAccepted', localId: 'earlier-accepted-input' } });
    if (malformed) expect(storedMessageMeta).not.toHaveProperty('forgeEvidence');
    else expect(readSessionInputForgeEvidenceV1(storedMessageMeta)).toEqual(forgeEvidence);
  });
  it('keeps the owner baseline across external Send admission, turn intent and subsequent resume', async () => {
    const pending: Array<{ localId: string; content: { t: 'plain'; v: unknown } }> = [];
    const admitted: UserMessage[] = [];
    const userSocket = createApiSessionSocketStub();
    const runtimeSocket = createApiSessionSocketStub({ emitWithAck: (event) => {
      if (event !== 'pending-materialize-next') return { ok: true };
      const next = pending.shift();
      return next ? { ok: true, didMaterialize: true, didWrite: true,
        pendingCount: pending.length, pendingBlockedCount: 0, pendingVersion: admitted.length * 2 + 1,
        deliveryState: { mode: 'provider', unresolved: true },
        message: { id: `message-${next.localId}`, seq: admitted.length, localId: next.localId,
          messageRole: 'user', content: next.content, providerAction: 'send',
          requestedAction: { v: 1, kind: 'enqueue' }, createdAt: 42, updatedAt: 42 },
      } : { ok: true, didMaterialize: false };
    } });
    sockets.createUserScopedSocket.mockReturnValue(userSocket);
    sockets.createSessionScopedSocketConnection.mockReturnValue({
      socket: runtimeSocket, transport: createSocketTransportAdapter(runtimeSocket),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { session: {
      pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
    } } }), { status: 200 })));
    // Only HTTP and Socket.IO are substituted. The Session client's delivery,
    // external ingress, Action executor, schemas and runtime queue stay real.
    const session = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: sessionId,
      pendingCount: 0, pendingVersion: 0,
      metadata: createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 1 }),
    }), {
      localMachineId: 'machine-a', durableMutationDeliveryInitiallyActive: false,
      metadataAuthority: { kind: 'owner', credentials },
      transport: { serverId: 'fixture-home', serverUrl: 'http://fixture-home',
        createAccountUpdatesSocket: () => userSocket,
        createSessionSocketTransport: () => createSessionScopedSocketConnection({
          token: credentials.token, sessionId, machineId: 'machine-a', serverUrl: 'http://fixture-home',
        }),
      },
    });
    const state = createPermissionModeQueueState({ session,
      agentTargetKey: 'agent:happier.agent.claude/claude', initialPermissionMode: 'default' });
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (...args: unknown[]) => {
      const result = await read(...args);
      if (String(args[0]).includes(`/v2/sessions/${sessionId}`)) {
        result.data.session.active = true;
        result.data.session.pendingCount = pending.length;
        result.data.session.pendingVersion = admitted.length * 2 + (pending.length === 0 ? 1 : 0);
        result.data.session.metadata = JSON.stringify({ ...session.getMetadataSnapshot(), sessionCreationCorrespondenceV1: correspondence });
      }
      return result;
    });
    http.post.mockImplementation(async (_url: string, body: { localId: string; content: { t: string; v: unknown } }) => {
      expect(body.content.t).toBe('plain');
      if (!body.content.v || typeof body.content.v !== 'object') throw new Error('Expected a plain input record');
      const parsed = UserMessageSchema.parse({ ...body.content.v, localId: body.localId, createdAt: 42 });
      admitted.push(parsed);
      pending.push({ localId: body.localId, content: { t: 'plain', v: body.content.v } });
      userSocket.trigger('update', { id: `pending-${body.localId}`, seq: admitted.length, createdAt: 42,
        body: { t: 'pending-changed', sid: sessionId, pendingCount: pending.length,
          pendingBlockedCount: 0, pendingVersion: admitted.length * 2 } });
      return { status: 200, data: { didWrite: true, terminal: false } };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null });
    const invoke = (localId: string, permissionModeOverride?: string) => executeExternalAction({
      actionId: 'session.message.send', envelope: { v: 1, requestId: localId,
        input: { sessionId, message: 'Read this turn', localId, wait: false,
          requestedAction: { v: 1, kind: 'enqueue' }, ...(permissionModeOverride ? { permissionModeOverride } : {}) } },
      principal: { authority: 'account_automation' }, currentMachineId: 'machine-a',
      resolveTarget: async () => ({ kind: 'session', sessionId }),
      executor: createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps }),
    });
    try {
      if (!Reflect.get(session, 'sessionSyncPendingInputServerContractResult')) {
        await new Promise<void>(resolve => session.once('session-sync-server-contract', resolve));
      }
      expect(await invoke('external-mode', 'read_only')).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { status: 'accepted', localId: 'external-mode' },
      } } });
      expect(await session.materializeNextPendingMessageSafely()).toMatchObject({ type: 'materialized', localId: 'external-mode' });
      expect(state.messageQueue.size()).toBe(1);
      const turn = await state.messageQueue.waitForMessagesAndGetAsString();
      expect(turn?.mode.permissionMode).toBe('read-only');
      expect(session.getMetadataSnapshot()).toMatchObject({ permissionMode: 'default', permissionModeUpdatedAt: 1 });
      expect(state.getCurrentPermissionMode()).toBe('default');
      const latest = admitted.at(-1)!;
      expect(await resolveStartupPermissionModeFromSession({ sessionKind: 'resume', session: {
        getMetadataSnapshot: () => session.getMetadataSnapshot(),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: latest.meta!.permissionMode!, updatedAt: 42 }),
      } })).toEqual({ mode: 'default', updatedAt: 1 });
      expect(await invoke('external-default')).toMatchObject({ kind: 'response', response: { execution: { ok: true } } });
      expect(await session.materializeNextPendingMessageSafely()).toMatchObject({ type: 'materialized', localId: 'external-default' });
      expect(state.messageQueue.size()).toBe(1);
      expect((await state.messageQueue.waitForMessagesAndGetAsString())?.mode.permissionMode).toBe('default');
      expect(admitted.map(message => message.meta?.permissionMode)).toEqual(['read-only', 'default']);
    } finally { await session.close(); }
  });
  it.each([
    { signed: true, home: 'canonical', assertedCause: false, direct: false }, { signed: false, home: 'canonical', assertedCause: false, direct: false },
    { signed: false, home: 'legacy', assertedCause: false, direct: false }, { signed: false, home: 'unavailable', assertedCause: false, direct: false },
    { signed: true, home: 'canonical', assertedCause: true, direct: false },
    { signed: false, home: 'canonical', assertedCause: false, direct: true },
  ] as const)('admits a signed external CLI Send through the current E2EE layout-one owner and Machine socket (signed=$signed, Home=$home, asserted=$assertedCause, direct=$direct)', async ({ signed, home, assertedCause, direct }) => {
    const sendCredentials = { ...credentials,
      token: `fixture.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature` };
    const secret = credentials.encryption.secret;
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const dek = new Uint8Array(32).fill(19);
    const ctx = { encryptionKey: dek, encryptionVariant: 'dataKey' as const };
    const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: dek, recipientPublicKey: publicKey,
      randomBytes: length => new Uint8Array(length).fill(11) }));
    const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
      ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: { machineId: 'machine-a', path: '/workspace' },
        system: { sessionCreationCorrespondenceV1: correspondence } }),
      randomBytes: length => new Uint8Array(length).fill(24) });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: 'e2ee', dataEncryptionKey, metadataLayoutVersion: 1, ownerMetadata, share: null,
        metadata: encryptSessionPayload({ ctx, payload: { v: 1 } }),
      }) } };
      throw new Error(`Unexpected read: ${url}`);
    });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    // Installation identity is an OS/file boundary; signing and socket admission remain real.
    const identity = vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({
      version: 1, installationId: 'installation', createdAt: 1,
      publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') });
    const client = new ApiMachineClient('token', { id: 'machine-a', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const admitted: unknown[] = [];
    const authoredInputs: ReturnType<typeof UserMessageSchema.parse>[] = [];
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
      const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
      if (signed) {
        expect(request.externalAction?.authorization.binding.requestId).toBe('signed-cli-send');
        if (!request.externalAction) throw new Error('Expected original caller authorization');
        const { externalAction, ...unsignedRequest } = request;
        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: externalAction.authorization.token,
          effectActionId: 'session.message.send', target: externalAction.target, installationId: externalAction.installationId,
          event, method: event, requestId: 'signed-cli-send', params: unsignedRequest, publicKey: keys.publicKey,
          signature: externalAction.machineSignature })).toBe(true);
      } else expect(request.externalAction).toBeUndefined();
      expect(request.targetMachineId).toBe('machine-a');
      const authored = UserMessageSchema.parse(decryptSessionPayload({ ctx,
        ciphertextBase64: request.content.t === 'encrypted' ? request.content.c : '' }));
      authoredInputs.push(authored);
      admitted.push(request);
      return Promise.resolve({ v: 1, result: { status: 'accepted', localId: request.localId } });
    } }));
    const target = { kind: 'session' as const, sessionId };
    const input = { sessionId, message: 'Continue the replied session', localId: 'signed-cli-input', wait: false };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'terminal-proof', binding: {
      accountId: 'requester', authentication: { kind: 'terminal', tokenEpoch: 1 },
      serverIdentityId: 'srv_home', machineId: 'machine-a', custodianAccountId: 'requester', installationId: 'installation',
      actionId: 'session.message.send', requestId: 'signed-cli-send', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'signed-cli-send', target, input }),
      accountEncryptionMode: 'e2ee',
    } });
    const deps = createCliActionDeps({ token: sendCredentials.token, credentials: sendCredentials, sessionId, mode: 'plain', ctx: null,
      serverId: 'local-home-alias', serverHttpBaseUrl: 'http://fixture-home',
      machineActionDirectTargetTransport: createLocalMachineActionTransportFixture('machine-a'),
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation',
      ...(home === 'canonical' ? { serverIdentityId: 'srv_home' } : {}),
      resolveServerFeaturesSnapshot: async () => home === 'unavailable' ? { status: 'error', reason: 'network' }
        : { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) },
      machineAdmissionTransport: (request, options) => client.enqueueSessionPendingByMachine(request, options) });
    try {
      if (direct) {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {},
          capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } }), { status: 200 })));
        const result = await sendSessionMessage({ credentials: sendCredentials, idOrPrefix: sessionId,
          serverId: 'local-home-alias', message: input.message, localId: input.localId, wait: false,
          inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli'),
          timeoutMs: 1000, machineAdmissionTransport: (request, options) => client.enqueueSessionPendingByMachine(request, options) });
        expect(result).toMatchObject({ ok: true, admissionResult: { status: 'accepted' } });
        expect(authoredInputs[0]).toMatchObject({ meta: { happierInputRequestV1: {
          actionRequestAttributionV1: { requester: { serverId: 'srv_home', accountId: 'requester' } },
        } } });
        return;
      }
      const result = await createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps }).execute('session.message.send', input,
        { surface: 'cli', authority: 'present_user', externalActionTarget: target,
          ...(assertedCause ? { actionRequestAttributionV1: { requestRef: 'signed-cli-input',
            requester: { serverId: 'local-home-alias', accountId: 'requester' },
            persona: { serverId: 'local-home-alias', sessionId }, origin: null } } : {}),
          ...(signed ? { externalActionExecutionAuthorization: authorization } : {}) });
      expect(result, JSON.stringify(result)).toMatchObject(assertedCause
        ? { ok: true, result: { status: 'rejected', code: 'session_input_untrusted_assertion' } }
        : home === 'unavailable'
        ? { ok: true, result: { status: 'outcomeUnknown', localId: 'signed-cli-input', code: 'authority_unavailable' } }
        : { ok: true, result: { status: 'accepted', localId: 'signed-cli-input' } });
      expect(admitted).toHaveLength(assertedCause || home === 'unavailable' ? 0 : 1);
      if (!assertedCause && home !== 'unavailable') {
        expect(authoredInputs[0]).toMatchObject({ content: { text: 'Continue the replied session' }, meta: { permissionMode: 'default',
          happierInputRequestV1: { producer: 'cli', ...(home === 'canonical' ? { actionRequestAttributionV1: {
            requester: { serverId: 'srv_home', accountId: 'requester' },
            persona: { serverId: 'srv_home', sessionId },
          } } : {}) } } });
        if (home === 'legacy') expect(authoredInputs[0]).not.toHaveProperty('meta.happierInputRequestV1.actionRequestAttributionV1');
      }
      expect(http.post).not.toHaveBeenCalled();
    } finally { identity.mockRestore(); }
  });

  it('admits a granted permission alias on exactly its Send and inherits defaults on the next Send', async () => {
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (...args: unknown[]) => {
      const result = await read(...args);
      if (String(args[0]).includes(`/v2/sessions/${sessionId}`)) {
        result.data.session.active = true;
        result.data.session.metadata = JSON.stringify({ sessionCreationCorrespondenceV1: correspondence,
          permissionMode: 'default', permissionModeUpdatedAt: 1 });
      }
      return result;
    });
    const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['read-only'] });
    const target = { kind: 'session' as const, sessionId };
    const input = { sessionId, message: 'Read this turn', localId: 'alias-input', permissionModeOverride: 'read_only',
      requestedAction: { v: 1 as const, kind: 'enqueue' as const }, wait: false, timeoutSeconds: 1 };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: 'home', machineId: 'machine-a', custodianAccountId: 'requester', installationId: 'installation',
      actionId: 'session.message.send', requestId: 'alias-send', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'alias-send', target, input }),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const machineInputs: ReturnType<typeof SessionPendingEnqueueByMachineRequestV1Schema.parse>[] = [];
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: createLocalMachineActionTransportFixture('machine-a'),
      machineAdmissionTransport: async (request, options) => {
        expect(options?.callerInputAuthorization?.binding.requestId).toBe('alias-send');
        const admitted = SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
        machineInputs.push(admitted);
        return { status: 'accepted', localId: admitted.localId };
      },
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation', serverIdentityId: 'home' });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps });
    const result = await executor.execute('session.message.send', input, { surface: 'api', authority: 'account_automation',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'alias-input' } });
    if (!result.ok) throw new Error('Expected successful Send');
    expect(SessionMessageSendResultV1Schema.parse(result.result)).toEqual({ status: 'accepted', localId: 'alias-input' });
    expect(machineInputs.map(request => request.content)).toMatchObject([
      { t: 'plain', v: { meta: { permissionMode: 'read-only' } } },
    ]);
    expect(http.post).not.toHaveBeenCalled();
    const writesBeforeMiswiring = http.post.mock.calls.length;
    const miswiredDeps = {
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps };
    Reflect.deleteProperty(miswiredDeps, 'sessionSendMessage');
    const miswiredResult = await createActionExecutor(miswiredDeps).execute('session.message.send', input, {
      surface: 'api', authority: 'account_automation', externalActionTarget: target,
      externalActionExecutionAuthorization: authorization,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
    });
    // The same deciding assertion must fail when the Action's Send port is removed.
    expect(miswiredResult).toMatchObject({ ok: false });
    expect(() => expect(miswiredResult).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'alias-input' } })).toThrow();
    expect(http.post.mock.calls).toHaveLength(writesBeforeMiswiring);
    await deps.sessionSendMessage({ context: cliActionContext, sessionId, message: 'Use defaults',
      localId: 'ordinary-after-alias', requestedAction: { v: 1, kind: 'enqueue' }, wait: false, timeoutSeconds: 1 });
    expect(machineInputs).toHaveLength(1);
    expect(http.post.mock.calls.map(([, body]) => body.content.v.meta.permissionMode)).toEqual(['default']);
  });

  it('suppresses a recovery continuation superseded during Session lookup before Pending admission', async () => {
    let current = true;
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (...args: unknown[]) => {
      const result = await read(...args);
      if (String(args[0]).includes(`/v2/sessions/${sessionId}`)) current = false;
      return result;
    });
    const params = {
      credentials, idOrPrefix: sessionId, message: 'Continue after quota reset',
      localId: 'superseded-recovery', wait: false, timeoutMs: 1000,
      resumeInactiveSession: false,
      pendingAdmissionMode: 'continuation_if_no_queued_user_input' as const,
      canAdmitPendingInput: () => current,
    };
    const result = await sendSessionMessage(params);
    expect(result).toMatchObject({ ok: true, suppressed: true });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    { didWrite: true, status: 'accepted' },
    { didWrite: false, status: 'alreadyAccepted' },
    { didWrite: null, status: 'outcomeUnknown' },
  ] as const)('retains ordinary Session admission evidence: $status', async ({ didWrite, status }) => {
    if (didWrite === null) http.post.mockRejectedValueOnce(new Error('acknowledgement lost'));
    else http.post.mockResolvedValueOnce({ status: 200, data: { didWrite, terminal: false } });
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, message: 'ordinary input',
      localId: 'ordinary-retry', wait: false, timeoutMs: 1000,
      resumeInactiveSession: false,
    });
    expect(result.admissionResult).toMatchObject({ status, localId: 'ordinary-retry' });
  });

  it.each([true, false])('returns a valid external Action result after durable ordinary enqueue (didWrite=%s)', async (didWrite) => {
    http.post.mockResolvedValueOnce({ status: 200, data: { didWrite, terminal: true } });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId,
      mode: 'plain', ctx: null });
    const result = await executeExternalAction({
      actionId: 'session.message.send',
      envelope: { v: 1, requestId: 'external-send', input: {
        sessionId, message: 'ordinary input', localId: 'external-retry',
      } },
      principal: { authority: 'present_user' },
      currentMachineId: 'machine-a',
      resolveTarget: async () => ({ kind: 'session', sessionId }),
      executor: createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps }),
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: {
      ok: true, result: { status: didWrite ? 'accepted' : 'alreadyAccepted', localId: 'external-retry' },
    } } });
  });

  beforeEach(() => {
    http.get.mockReset();
    http.post.mockReset();
    sockets.createUserScopedSocket.mockReset();
    sockets.createSessionScopedSocketConnection.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), {
        connected: false, connect: () => {}, disconnect: () => {}, close: () => {},
      });
      observationSocket = socket;
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    rpc.callSessionRpc.mockReset();
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/machines/machine-a')) return { status: 200, data: { machine: {
        id: 'machine-a', kind: 'persistent', active: true, managedMachineRef: null,
        revokedAt: null, replacedByMachineId: null,
      } } };
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } },
      };
      if (url.includes(`/v2/sessions/${sessionId}`)) return {
        status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, active: false, encryptionMode: 'plain',
          metadata: JSON.stringify({ sessionCreationCorrespondenceV1: correspondence }),
        }) },
      };
      throw new Error(`Unexpected read: ${url}`);
    });
    http.post.mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {}, capabilities: { session: { pendingInput: { protocolVersion: 3 } } },
    }), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['failed', 'timeout'] as const)('returns the recorded failed turn or observer timeout through the public waiting Send Action (%s)', async (outcome) => {
    const retainedCredentials = { ...credentials, accountE2eeCustody: 'historical' as const };
    const read = http.get.getMockImplementation()!;
    const user = { id: 'input-message', seq: 1, localId: 'input-a', createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Reply OK' } } } };
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: outcome === 'failed' ? user : null } };
      if (url.includes('/pending')) return { status: 200, data: { pending: [] } };
      if (url.includes('/messages')) return { status: 200, data: { messages: [user,
        { id: 'failed', seq: 2, localId: null, createdAt: 2, updatedAt: 2,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'opencode',
            data: { type: 'turn_failed', id: 'native-turn-1' } } } } },
        { id: 'ready', seq: 3, localId: null, createdAt: 3, updatedAt: 3,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } } },
      ] } };
      if (url.includes('/turns')) return { status: 200, data: { turns: [] } };
      const result = await read(url);
      if (url.endsWith(`/v2/sessions/${sessionId}`)) Object.assign(result.data.session, {
        active: true, latestTurnStatus: 'failed', latestTurnStatusObservedAt: 2,
        pendingCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      });
      return result;
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials: retainedCredentials, sessionId, mode: 'plain', ctx: null });
    const result = await deps.sessionSendMessage!({ context: cliActionContext, sessionId,
      localId: 'input-a', message: 'Reply OK', requestedAction: { v: 1, kind: 'enqueue' }, wait: true, timeoutSeconds: 1 });
    if (outcome === 'failed') expect(result).toEqual({ status: 'failed', code: 'session_input_turn_failed', localId: 'input-a' });
    else expect(result).toMatchObject({ ok: false, errorCode: 'timeout' });
  });

  it.each(['plain', 'e2ee'] as const)('settles Send when native completion precedes assistant delivery without a busy edge (%s)', async mode => {
    const ctx = { encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy' as const };
    const content = (value: unknown) => SessionMessageContentSchema.parse(mode === 'plain'
      ? { t: 'plain', v: value }
      : { t: 'encrypted', c: encryptSessionPayload({ ctx, payload: value }) });
    const input = { id: 'input-message', seq: 34, localId: 'input-a', createdAt: 1794322917688, updatedAt: 1794322917688,
      content: content({ role: 'user', content: { type: 'text', text: 'No tools. Reply SWITCH_OK.' } }) };
    const assistant = { id: 'assistant-message', seq: 37, localId: null, createdAt: 1794322921815, updatedAt: 1794322921815,
      content: content({ role: 'agent', content: { type: 'acp', agentId: 'claude', data: { type: 'text', text: 'SWITCH_OK.' } } }) };
    let completed = false;
    let connections = 0;
    sockets.createSessionScopedSocketConnection.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { connected: false, connect: () => {}, disconnect: () => {}, close: () => {} });
      if (++connections === 2) setImmediate(() => {
        completed = true;
        socket.emit('update', { id: 'completed-update', seq: 36, createdAt: 1794322921749, body: {
          t: 'update-session', id: sessionId, latestTurnStatus: 'completed', latestTurnStatusObservedAt: 1794322921749,
          pendingCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
        } });
      });
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/currentness')) return { status: 200, data: { mode, version: 1, updatedAt: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null } };
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
      if (url.includes('/messages?')) return { status: 200, data: { messages: completed ? [input, assistant] : [input], hasMore: false } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: mode, share: null, dataEncryptionKey: null,
        latestTurnStatus: 'completed', latestTurnStatusObservedAt: completed ? 1794322921749 : 1794322864589,
        pendingCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
        metadata: mode === 'plain' ? '{}' : encryptSessionPayload({ ctx, payload: {} }),
      }) } };
      throw new Error(`Unexpected completion read: ${url}`);
    });
    const senderCredentials = mode === 'plain' ? { token: credentials.token, encryption: null } : credentials;
    const deps = createCliActionDeps({ token: credentials.token, credentials: senderCredentials, sessionId,
      ...(mode === 'plain' ? { mode: 'plain' as const, ctx: null } : { mode: 'e2ee' as const, ctx }) });
    const result = await createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps }).execute('session.message.send', {
      sessionId, localId: input.localId, message: 'No tools. Reply SWITCH_OK.', wait: true, timeoutSeconds: 1,
    }, { surface: 'mcp', authority: 'present_user', defaultSessionId: null });
    expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: input.localId } });
    expect(completed).toBe(true);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('keeps signed wait target reads and cancellation under the original requester', async () => {
    const observer = new AbortController();
    const read = http.get.getMockImplementation()!;
    const observedSignals: Array<AbortSignal | undefined> = [];
    http.get.mockImplementation(async (url: string, config?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
      if (config?.headers?.Authorization !== 'Original-requester-proof') return { status: 401, data: { error: 'invalid_token' } };
      observedSignals.push(config.signal);
      const response = await read(url, config);
      if (url.endsWith(`/v2/sessions/${sessionId}`)) observer.abort();
      return response;
    });
    const result = await waitForSessionInputResult({ credentials, idOrPrefix: sessionId, localId: 'native-input',
      resolveAuthorizationHeaders: () => ({ Authorization: 'Original-requester-proof' }), signal: observer.signal,
      observation: { kind: 'no_deadline' },
    });
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(observedSignals.length).toBeGreaterThan(0);
    expect(observedSignals.every(signal => signal === observer.signal)).toBe(true);
  });

  it.each(['complete', 'cancel'] as const)('keeps protected Send lookup under its caller lifecycle: %s', async outcome => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    let releaseDetail!: () => void;
    const detailRequested = new Promise<void>(resolveRequested => {
      http.get.mockImplementation(async (url: string, config?: { signal?: AbortSignal }) => {
        if (url.endsWith('/currentness')) return { status: 200, data: {
          mode: 'e2ee', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        } };
        if (!url.includes(`/v2/sessions/${sessionId}`)) throw new Error(`Unexpected read: ${url}`);
        // Only the network boundary is held. Resolution, crypto and the
        // protected Send producer/strict Machine consumer remain real.
        return await new Promise((resolve, reject) => {
          releaseDetail = () => resolve({ status: 200, data: { session: createSessionRecordFixture({
            id: sessionId, active: true, encryptionMode: 'e2ee', share: null,
            metadata: encryptSessionPayload({ ctx: { encryptionKey: credentials.encryption.secret,
              encryptionVariant: 'legacy' }, payload: { machineId: 'machine-a' } }),
          }) } });
          config?.signal?.addEventListener('abort', () => reject(new Error('HTTP request cancelled')), { once: true });
          resolveRequested();
        });
      });
    });
    const machineAdmissionTransport = vi.fn(async (raw: unknown) => {
      const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
      expect(request).toMatchObject({ sessionId, targetMachineId: 'machine-a', localId: 'slow-protected-send' });
      if (request.content.t !== 'encrypted') throw new Error('Expected encrypted input');
      expect(decryptSessionPayload({ ctx: { encryptionKey: credentials.encryption.secret,
        encryptionVariant: 'legacy' }, ciphertextBase64: request.content.c })).toMatchObject({
        role: 'user', content: { type: 'text', text: 'Continue after the held read' },
      });
      return { status: 'accepted' as const, localId: request.localId };
    });
    try {
      const pending = sendSessionMessage({ credentials, idOrPrefix: sessionId,
        message: 'Continue after the held read', localId: 'slow-protected-send', wait: false,
        timeoutMs: 120_000, signal: cancellation.signal,
        serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' },
        inputAdmission: buildTrustedHostSessionInputAdmissionV1('cli'), machineAdmissionTransport });
      await detailRequested;
      if (outcome === 'complete') {
        await vi.advanceTimersByTimeAsync(25_001);
        releaseDetail();
        await expect(pending).resolves.toMatchObject({ ok: true, admissionResult: { status: 'accepted', localId: 'slow-protected-send' } });
        expect(machineAdmissionTransport).toHaveBeenCalledOnce();
      } else {
        let observed: Awaited<typeof pending> | undefined;
        void pending.then(result => { observed = result; }, () => {});
        cancellation.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(observed).toMatchObject({ ok: false, code: 'cancelled',
          admissionResult: { status: 'rejected', code: 'session_input_cancelled' } });
        expect(machineAdmissionTransport).not.toHaveBeenCalled();
      }
    } finally {
      releaseDetail?.();
      vi.useRealTimers();
    }
  });

  it.each([
    { kind: 'agent_team_member' as const, teamId: 'team-a', memberId: 'member-a' },
    { kind: 'agent_team_broadcast' as const, teamId: 'team-a' },
  ])('refuses $kind through the real Action send owner before Pending or resume', async (nativeRecipient) => {
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps });
    const input = { sessionId, localId: 'native-input', message: 'Only the selected native recipient',
      recipient: nativeRecipient, wait: false };
    const result = await executor.execute('session.message.send', input, cliActionContext);
    expect(result).toMatchObject({ ok: true, result: { status: 'rejected', code: 'session_input_target_update_required' } });
    if (!result.ok) throw new Error('Expected a typed admission refusal');
    expect(SessionMessageSendResultV1Schema.parse(result.result)).toEqual({
      status: 'rejected', code: 'session_input_target_update_required',
    });
    expect(http.post).not.toHaveBeenCalled();
    expect(rpc.callSessionRpc).not.toHaveBeenCalled();
    const metadataOnly = await sendSessionMessage({ credentials, idOrPrefix: sessionId, message: input.message,
      messageMeta: withParticipantRecipientV1({}, nativeRecipient), wait: false, timeoutMs: 1_000 });
    expect(metadataOnly).toMatchObject({ ok: false, code: 'unsupported' });
    expect(http.post).not.toHaveBeenCalled();
    const miswiredDeps = {
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.message.send": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps };
    Reflect.deleteProperty(miswiredDeps, 'sessionSendMessage');
    const miswired = await createActionExecutor(miswiredDeps).execute('session.message.send', input, cliActionContext);
    expect(() => expect(miswired).toMatchObject({ ok: true,
      result: { status: 'rejected', code: 'session_input_target_update_required' } })).toThrow();
    const main = await executor.execute('session.message.send', { ...input, recipient: undefined,
      localId: 'primary-control', requestedAction: { v: 1, kind: 'enqueue' } }, cliActionContext);
    expect(main).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'primary-control' } });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('authors recipient once and admits to the exact nested resource without resuming the parent', async () => {
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null });
    const result = await deps.sessionSendMessage({
      context: cliActionContext,
      sessionId, localId: 'input-a', message: 'Continue the side conversation',
      messageMeta: { attachmentMarker: 'authored-file' }, displayText: 'Continue with this file',
      recipient, requestedAction: { v: 1, kind: 'enqueue' }, wait: false, timeoutSeconds: 1,
    });
    expect(result, JSON.stringify(result)).toEqual({ status: 'accepted', localId: 'input-a' });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v2/sessions/${sessionId}/execution-runs/run-a/pending`),
      expect.objectContaining({
        v: 1, targetMachineId: 'machine-a', localId: 'input-a',
        content: { t: 'plain', v: expect.objectContaining({
          meta: expect.objectContaining({ attachmentMarker: 'authored-file', displayText: 'Continue with this file', happier: { kind: 'participant_message.v1', payload: { recipient } } }),
        }) },
      }),
      expect.anything(),
    );
  });

  it('does not perform an uncached feature round trip before the authoritative strict target route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {}, capabilities: { session: { pendingInput: { protocolVersion: 2 } } },
    }), { status: 200 })));
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Private run input',
      recipient, wait: false, timeoutMs: 1000,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, admissionResult: { status: 'accepted', localId: 'input-a' },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('sends protected run input through the strict Machine V2 contract', async () => {
    const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted' as const, localId: 'input-a' }));
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Plugin run input',
      recipient, wait: false, timeoutMs: 1000,
      inputAdmission: {
        provenance: { v: 1, kind: 'pluginSession', pluginId: 'example.plugin', contributionLocalId: 'send', surface: 'background' },
        request: {
          v: 1, producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
          permission: { requestedPermissionCeiling: 'read-only' },
        },
      },
      machineAdmissionTransport,
    });
    expect(result).toMatchObject({ ok: true, admissionResult: { status: 'accepted', localId: 'input-a' } });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      v: 2, sessionId, recipient, targetMachineId: 'machine-a', localId: 'input-a',
    }), expect.objectContaining({ timeoutMs: 1000 }));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('keeps the Start admission budget through Message authoring and the real Machine ACK owner', async () => {
    vi.useFakeTimers();
    const client = new ApiMachineClient('token', { id: 'machine-a', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (_event, raw) => {
      const request = raw as { localId: string };
      return new Promise(resolve => setTimeout(() => resolve({ v: 1,
        result: { status: 'accepted', localId: request.localId } }), 11_000));
    } });
    Reflect.set(client, 'socket', socket);
    try {
      const pending = sendSessionMessage({ credentials, idOrPrefix: sessionId, message: 'First turn',
        localId: 'start-input', wait: false, timeoutMs: 60_000, resumeInactiveSession: false,
        inputAdmission: { provenance: { v: 1, kind: 'pluginSession', pluginId: 'example.plugin',
          contributionLocalId: 'start', surface: 'background' },
          request: { v: 1, producer: 'pluginSession',
            caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'start' }, permission: {} } },
        machineAdmissionTransport: (request, options) => client.enqueueSessionPendingByMachine(request, options) });
      // Resolve authoring's HTTP reads before advancing the actual ACK owner.
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.emitWithAck).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(pending).resolves.toMatchObject({ ok: true,
        admissionResult: { status: 'accepted', localId: 'start-input' } });
      expect(socket.emitWithAck).toHaveBeenCalledOnce();
      expect(http.post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('classifies a missing strict target resource as unavailable without a main retry', async () => {
    http.post.mockRejectedValue({ response: { status: 404 } });
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Private run input',
      recipient, wait: false, timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      ok: false, admissionResult: { status: 'rejected', code: 'session_input_target_unavailable' },
    });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0]?.[0]).toContain('/execution-runs/run-a/pending');
  });

  it('does not infer a Machine update from an untyped strict-route failure', async () => {
    http.post.mockRejectedValue({ response: { status: 405 } });
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Private run input',
      recipient, wait: false, timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      ok: false, admissionResult: { status: 'outcomeUnknown' },
    });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 400, code: 'session_input_target_update_required' },
    { status: 404, code: 'session_input_target_unavailable' },
    { status: 405, code: 'session_input_target_update_required' },
  ] as const)('preserves a current server target rejection before legacy HTTP fallback ($code)', async ({ status, code }) => {
    http.post.mockRejectedValue({ response: { status, data: { error: status === 404 ? 'session-not-found' : 'invalid-params', code } } });
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: `input-${status}`, message: 'Private run input',
      recipient, wait: false, timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      ok: false, admissionResult: { status: 'rejected', code },
    });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0]?.[0]).toContain('/execution-runs/run-a/pending');
  });

  it.each([undefined, recipient])('returns withdrawn Team access through Session Send (%s)', async target => {
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: null } };
      if (url.includes('/pending')) return { status: 200, data: { ...(target ? { recipient: target } : {}), pending: [
        { localId: 'withdrawn-team-input', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'team_access_removed' },
      ] } };
      const result = await originalGet(url);
      if (url.endsWith(`/v2/sessions/${sessionId}`)) Object.assign(result.data.session, { active: true });
      return result;
    });
    const result = await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId: 'withdrawn-team-input',
      message: 'Next prompt', ...(target ? { recipient: target } : {}), wait: true, timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, code: 'wait_failed',
      admissionResult: { status: 'outcomeUnknown', localId: 'withdrawn-team-input', code: 'session_input_turn_outcome_unknown' } });
    expect(result).toMatchObject({ message: expect.stringContaining('Team access') });
  });

  it.each([
    { signed: false, target: undefined },
    { signed: true, target: undefined },
    { signed: false, target: recipient },
    { signed: true, target: recipient },
  ])('observes Team refusal after the user row is committed (signed=$signed, target=$target)', async ({ signed, target }) => {
    // r1113b recorded the refused user at seq 11 before Pending became blocked;
    // no corresponding accepted host turn exists. The former fixture returned null.
    const localId = 'withdrawn-team-materialized';
    const user = { id: 'cmweikxxt007umcoa6d57pqcj', seq: 11, localId, createdAt: 1794546381518, updatedAt: 1794546381518,
      sidechainId: target ? 'sidechain-a' : null,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'No tools. Reply QA_TEAM_DENIED.' } } } };
    let blocked = false;
    let scheduled = false;
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) {
        if (!scheduled) {
          scheduled = true;
          setImmediate(() => {
            blocked = true;
            observationSocket.emit('update', { id: 'team-refusal', seq: 12, createdAt: 1794546382712,
              body: { t: 'pending-changed', sid: sessionId, pendingVersion: 12, pendingCount: 1, pendingBlockedCount: 1 } });
          });
        }
        return { status: 200, data: { message: user } };
      }
      if (url.includes('/messages?')) return { status: 200, data: { messages: [user], hasMore: false } };
      if (url.includes('/turns')) return { status: 200, data: { turns: [] } };
      if (url.includes('/pending')) return { status: 200, data: { ...(target ? { recipient: target } : {}), pending: [
        { localId, status: 'queued', deliveryState: blocked ? 'blocked' : 'delivering', deliveryBlockedReason: blocked ? 'team_access_removed' : null },
      ] } };
      const response = await originalGet(url);
      if (url.endsWith('/v2/sessions/' + sessionId)) Object.assign(response.data.session, { active: true });
      return response;
    });
    mockRunReads([{ occurrenceId: 'occurrence-a', current: null, last: null }]);
    const result = await sendSessionMessage({ credentials, idOrPrefix: sessionId, localId,
      message: 'No tools. Reply QA_TEAM_DENIED.', ...(target ? { recipient: target } : {}), wait: true, timeoutMs: 100,
      ...(signed ? { resolveAuthorizationHeaders: () => ({ Authorization: 'Original-requester-proof' }) } : {}) });
    expect(result).toMatchObject({ ok: false, code: 'wait_failed',
      admissionResult: { status: 'outcomeUnknown', localId, code: 'session_input_turn_outcome_unknown' } });
    if (!target) {
      expect(await waitForSessionInputResult({ credentials, idOrPrefix: sessionId, localId, timeoutMs: 100,
        ...(signed ? { resolveAuthorizationHeaders: () => ({ Authorization: 'Original-requester-proof' }) } : {}) }))
        .toMatchObject({ ok: true, result: { kind: 'pending' } });
    }
  });

  it('returns the exact target Pending refusal through Session Send without re-polling or resending', async () => {
    const originalGet = http.get.getMockImplementation()!;
    const pendingReads: string[] = [];
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: null } };
      if (url.includes('/pending')) {
        pendingReads.push(url);
        return { status: 200, data: { recipient, pending: [
          { localId: 'other-input', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'session_input_invalid' },
          { localId: 'blocked-run-input', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'session_input_target_unavailable' },
        ] } };
      }
      return originalGet(url);
    });
    const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global', serverId: 'cloud', serverHttpBaseUrl: configuration.serverUrl, mode: 'plain', ctx: null });
    const result = await deps.sessionSendMessage!({ context: cliActionContext, sessionId, localId: 'blocked-run-input',
      message: 'Targeted input before the first turn', recipient, wait: true, timeoutSeconds: 1,
      requestedAction: { v: 1, kind: 'enqueue' } });
    expect(result).toMatchObject({ status: 'rejected', code: 'session_input_target_unavailable' });
    expect(pendingReads).toEqual([expect.stringContaining(`/execution-runs/${recipient.runId}/pending?includeDiscarded=true`)]);
    expect(http.post).toHaveBeenCalledOnce();
    expect(rpc.callSessionRpc).not.toHaveBeenCalled();
  });

  it('returns outcome-unknown when exact target-turn evidence is unavailable', async () => {
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Wait for this run input',
      recipient, wait: true, timeoutMs: 1,
    });
    expect(result).toMatchObject({
      ok: false, code: 'wait_failed',
      admissionResult: { status: 'outcomeUnknown', localId: 'input-a' },
    });
    expect(http.get.mock.calls.some(([url]) => String(url).endsWith(`/sessions/${sessionId}/pending`))).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'failed'] as const)('waits on the exact target turn after a terminal admission replay (%s)', async (state) => {
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'message-a', seq: 1, localId: 'input-a', sidechainId: 'sidechain-a',
        createdAt: 1, updatedAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Wait for this run input' } } },
      } } };
      return originalGet(url);
    });
    // The exact Pending row is already gone: the server answers the replay as terminal.
    http.post.mockResolvedValue({ status: 200, data: { didWrite: false, terminal: true } });
    const run = mockRunReads([
      { occurrenceId: 'occurrence-a', current: { turnId: 'turn-a', inputIds: ['input-a'], state: 'active' },
        last: { turnId: 'sibling-turn', inputIds: ['sibling-input'], state: 'failed' } },
      { occurrenceId: 'occurrence-a', last: { turnId: 'turn-a', inputIds: ['input-a'], state } },
    ]);

    const pendingResult = sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Wait for this run input',
      recipient, wait: true, timeoutMs: 1_000,
    });
    await run.firstRead;
    run.advance();
    const result = await pendingResult;

    if (state === 'completed') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, localId: 'input-a', waited: true });
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false, code: 'wait_failed',
        settlementResult: { status: 'failed', localId: 'input-a', code: 'session_input_turn_failed' },
      });
    }
    // One admission, no resend and no parent resume.
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('reports outcome-unknown when a terminal admission replay has no exact turn evidence', async () => {
    http.post.mockResolvedValue({ status: 200, data: { didWrite: false, terminal: true } });
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Wait for this run input',
      recipient, wait: true, timeoutMs: 1,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false, code: 'wait_failed',
      admissionResult: { status: 'outcomeUnknown', localId: 'input-a' },
    });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the terminal admission replay shortcut when the caller did not ask to wait', async () => {
    http.post.mockResolvedValue({ status: 200, data: { didWrite: false, terminal: true } });
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Private run input',
      recipient, wait: false, timeoutMs: 1_000,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, waited: false, terminal: true,
      admissionResult: { status: 'alreadyAccepted', localId: 'input-a' },
    });
    expect(rpc.callSessionRpc).not.toHaveBeenCalled();
  });

  it('cancels only exact-turn observation after admission and preserves the admitted local id', async () => {
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'message-a', seq: 1, localId: 'input-a', sidechainId: 'sidechain-a',
        createdAt: 1, updatedAt: 1, content: { t: 'plain', v: {
          role: 'user', content: { type: 'text', text: 'Wait for this run input' },
        } },
      } } };
      return originalGet(url);
    });
    const abortController = new AbortController();
    rpc.callSessionRpc.mockImplementation(async () => {
      abortController.abort();
      return { ok: true, data: { run: {
        runId: 'run-a', callId: 'call-a', sidechainId: 'sidechain-a', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read-only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: 'occurrence-a', current: {
          turnId: 'turn-a', inputIds: ['input-a'], state: 'active',
        } },
      } } };
    });

    const startedAt = Date.now();
    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Wait for this run input',
      recipient, wait: true, timeoutMs: 5_000, signal: abortController.signal,
    });

    expect(result).toEqual({
      ok: false,
      code: 'cancelled',
      message: 'Execution Run turn observation was cancelled after admission',
      admissionResult: { status: 'accepted', localId: 'input-a' },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('interrupts the exact transcript-anchor read after admission without resending input', async () => {
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string, config?: { signal?: AbortSignal }) => {
      if (url.includes('/messages/by-local-id/')) {
        await new Promise<never>((_resolve, reject) => {
          const rejectCancelled = () => reject(new Error('lookup cancelled'));
          if (config?.signal?.aborted) rejectCancelled();
          else {
            config?.signal?.addEventListener('abort', rejectCancelled, { once: true });
            setTimeout(() => abortController.abort(), 0);
          }
        });
      }
      return originalGet(url);
    });
    const abortController = new AbortController();

    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Wait for this run input',
      recipient, wait: true, timeoutMs: 5_000, signal: abortController.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'cancelled',
      admissionResult: { status: 'accepted', localId: 'input-a' },
    });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(rpc.callSessionRpc).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('settles the exact admitted Run turn as %s even while the parent is inactive', async (state) => {
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'message-a', seq: 1, localId: 'input-a', sidechainId: 'sidechain-a',
        createdAt: 1, updatedAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Wait for this run input' } } },
      } } };
      return originalGet(url);
    });
    const run = mockRunReads([
      { occurrenceId: 'occurrence-a', current: { turnId: 'turn-a', inputIds: ['input-a'], state: 'active' },
        last: { turnId: 'sibling-turn', inputIds: ['sibling-input'], state: 'completed' } },
      { occurrenceId: 'occurrence-a', last: { turnId: 'turn-a', inputIds: ['input-a'], state } },
    ]);
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null });
    const pendingResult = deps.sessionSendMessage({
      context: cliActionContext,
      sessionId, localId: 'input-a', message: 'Wait for this run input', recipient, wait: true, timeoutSeconds: 1,
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });
    await run.firstRead;
    run.advance();
    const result = await pendingResult;
    if (state === 'completed') expect(result).toEqual({ status: 'accepted', localId: 'input-a' });
    else expect(result).toEqual({
      status: state,
      localId: 'input-a',
      code: state === 'failed'
        ? 'session_input_turn_failed'
        : 'session_input_turn_cancelled',
    });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completed', 'task_complete', true],
    ['failed', 'turn_failed', false],
    ['cancelled', 'turn_cancelled', false],
  ] as const)('preserves an exact %s Run-turn result after later turns replace the public projection', async (_state, terminalType, succeeds) => {
    const originalGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'message-a', seq: 10, localId: 'input-a', sidechainId: 'sidechain-a',
        createdAt: 10, updatedAt: 10, content: { t: 'plain', v: {
          role: 'user', content: { type: 'text', text: 'Wait for this run input' },
        } },
      } } };
      if (url.includes(`/v1/sessions/${sessionId}/messages?`)) {
        const query = new URL(url).searchParams;
        // Home defaults to main-chain reads. A nested result is visible only
        // when this reader selects its exact admitted sidechain.
        const messages = [
        {
          id: 'main-terminal', seq: 11, localId: null, createdAt: 11,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: { type: 'task_complete', id: 'main-turn' } } } },
        },
        {
          id: 'sibling-terminal', seq: 12, localId: null, createdAt: 12,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: {
            type: 'task_complete', id: 'sibling-turn', sidechainId: 'sidechain-b',
          } } } },
        },
        {
          id: 'later-same-turn-user', seq: 13, localId: 'input-b', createdAt: 13,
          content: { t: 'plain', v: { role: 'user', content: {
            type: 'text', text: 'Steered input in the same turn', sidechainId: 'sidechain-a',
          } } },
        },
        {
          id: 'wrong-turn-terminal', seq: 14, localId: null, createdAt: 14,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: {
            type: 'task_complete', id: 'wrong-turn', sidechainId: 'sidechain-a',
          } }, meta: { happierExecutionRunInputTurnV1: {
            turnId: 'wrong-turn', inputIds: ['wrong-input'], state: 'completed',
          } } } },
        },
        {
          id: 'exact-active-progress', seq: 14, localId: null, createdAt: 14,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: {
            type: 'message', message: 'Still working', sidechainId: 'sidechain-a',
          } }, meta: { happierExecutionRunInputTurnV1: {
            turnId: 'turn-a', inputIds: ['input-a', 'input-b'], state: 'active',
          } } } },
        },
        {
          id: 'exact-terminal', seq: 15, localId: null, createdAt: 15,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: {
            type: terminalType, id: 'turn-a', sidechainId: 'sidechain-a',
          } }, meta: { happierExecutionRunInputTurnV1: {
            turnId: 'turn-a', inputIds: ['input-a', 'input-b'], state: _state, retiredField: true,
          } } } },
        },
        ];
        return { status: 200, data: { hasMore: false, messages: messages.filter(row => {
          const sidechainId = row.content.v.content.data?.sidechainId;
          return query.get('scope') === 'sidechain'
            ? sidechainId === query.get('sidechainId')
            : sidechainId === undefined;
        }) } };
      }
      return originalGet(url);
    });
    mockRunReads([
      { occurrenceId: 'occurrence-a', current: { turnId: 'turn-c', inputIds: ['input-c'], state: 'active' },
        last: { turnId: 'turn-before-a', inputIds: ['input-before-a'], state: 'completed' } },
    ]);

    const result = await sendSessionMessage({
      credentials, idOrPrefix: sessionId, localId: 'input-a', message: 'Wait for this run input',
      recipient, wait: true, timeoutMs: 20,
    });

    if (succeeds) {
      expect(result).toMatchObject({ ok: true, localId: 'input-a', waited: true });
    } else {
      expect(result).toEqual({
        ok: false,
        code: 'wait_failed',
        message: terminalType === 'turn_failed'
          ? 'Execution Run turn failed'
          : 'Execution Run turn cancelled',
        settlementResult: {
          status: _state,
          localId: 'input-a',
          code: terminalType === 'turn_failed'
            ? 'session_input_turn_failed'
            : 'session_input_turn_cancelled',
        },
      });
    }
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});
