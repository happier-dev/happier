import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, FeaturesResponseSchema, SessionInputRequestV1Schema, settleSessionInputRequestV1, verifyExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { callSessionProviderInputAdmission } from '@/daemon/startup/providerInputAdmissionRuntime';
import { applySessionAgentTransitionCutover } from '@/session/transport/http/sessionsHttp';
import { requestSessionStop } from './requestSessionStop';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';
import type { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { waitForSessionIdle } from './waitForSessionIdle';
import { detectLatestSessionTurnActivity } from '@/session/query/detectLatestSessionTurnActivity';
import { buildBoundedActivationBrief } from '@/session/agentTransition/buildSessionAgentTransitionActivationBrief';
import { buildSessionAgentTransitionDividerPayload } from '@/session/agentTransition/sessionAgentTransitionCutoverPayload';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { UserMessageSchema } from '@/api/types';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

const sessionId = 'cmuo0nwxt11bptmszygswp8g3';
const machineId = 'owning-machine';
const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const credentials = { token: 'daemon-owner-token', encryption: null };
const target = { kind: 'session' as const, sessionId };
const authorization = { v: 1 as const, token: 'original-requester-proof', binding: {
  serverIdentityId: 'home', accountId: 'requester', custodianAccountId: 'requester', principalId: 'requester',
  credentialId: '11111111-1111-4111-8111-111111111111', machineId,
  actionId: 'session.agent.transition', requestId: 'transition-request', requestEnvelopeDigest: 'A'.repeat(43),
  target, installationId: 'installation', grant: API_TOKEN_FULL_GRANT_V1,
} } satisfies ExternalActionExecutionAuthorizationV1;
const externalAction = {
  context: { authority: 'account_automation' as const, surface: 'api' as const,
    externalActionTarget: target, externalActionExecutionAuthorization: authorization },
  effectActionId: 'session.agent.transition', installationId: 'installation', privateKey: keys.secretKey,
};
const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', machineId,
  metadata: JSON.stringify({ machineId, path: '/repo' }), dataEncryptionKey: null, active: false });
const metadata = { machineId, path: '/repo', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
  claudeSessionId: 'native-session' };
const cutoverInput = { token: credentials.token, sessionId,
  currentView: { kind: 'legacy_v0' as const, expectedMetadataVersion: 1, metadataCiphertext: 'metadata',
    expectedAgentStateVersion: 1, agentStateCiphertext: null },
  divider: { localId: 'agent-transition:transition-request', content: { t: 'plain', v: {} } },
};

type RpcPacket = { method: string; params: unknown; requestId: string;
  externalActionExecution?: { authorization: typeof authorization; effectActionId: string;
    target: typeof target; installationId: string; machineSignature: string } };

describe('Agent transition service effect transports', () => {
  const packets: RpcPacket[] = [];
  beforeEach(() => {
    vi.restoreAllMocks();
    io.mockReset();
    packets.length = 0;
    // Network adapters alone are substituted; service, discovery, codec and signing owners stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: {
        id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      } } };
      if (path === '/v1/account/machine-replacements') return { status: 200, data: { replacements: [] } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
    bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return undefined;
      const packet = payload as RpcPacket;
      packets.push(packet);
      const proof = packet.externalActionExecution;
      if (!proof || !verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
        effectActionId: proof.effectActionId, target: proof.target, installationId: proof.installationId,
        event, method: packet.method, requestId: packet.requestId, params: packet.params,
        signature: proof.machineSignature, publicKey: keys.publicKey })) {
        return { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' };
      }
      if (packet.method.endsWith(RPC_METHODS.STOP_SESSION)) return { ok: true, result: { status: 'stopped' } };
      if (packet.method.endsWith(RPC_METHODS.SPAWN_HAPPY_SESSION)) return { ok: true, result: { type: 'success', sessionId } };
      return { ok: true, result: { status: 'enforced' } };
    } }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); io.mockReset(); });

  it('retains a plugin requester when re-admitting an already committed Agent transition input', async () => {
    const localId = 'continued-input';
    const cause = { requestRef: 'original-question', requester: { serverId: 'home', accountId: 'person' },
      persona: { serverId: 'home', sessionId: 'source-session' }, origin: null };
    const divider = buildSessionAgentTransitionDividerPayload({ sessionId, submittedLocalId: localId,
      fromAgentId: 'claude', toAgentId: 'codex', sourceCutoffSeqInclusive: 1,
      returningAgentLastSeenSeqInclusive: null, mode: 'plain', ctx: null });
    const originalGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'divider', seq: 2, localId: divider.localId, sidechainId: null, createdAt: 1, updatedAt: 1,
        content: divider.content,
      } } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: {
        ...rawSession, active: true, metadata: JSON.stringify({ machineId, path: '/repo', flavor: 'codex' }),
      } } };
      return await originalGet(url, config);
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, agentSwitching: { enabled: true } } }, capabilities: {},
    }))));
    const admitted: unknown[] = [];
    const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'source-session',
      mode: 'plain', ctx: null, machineAdmissionTransport: async request => {
        if (request.content.t !== 'plain') throw new Error('Expected plain fixture input');
        const message = UserMessageSchema.parse(request.content.v);
        const inputAdmissionReceipt = { v: 1, issuer: 'authenticatedMachine' } as const;
        const inputAuthority = settleSessionInputRequestV1({ request: SessionInputRequestV1Schema.parse(message.meta?.happierInputRequestV1),
          currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
        admitted.push(deriveSessionInputActionRequestAttributionV1({ requestRef: request.localId,
          persona: { serverId: 'home', sessionId }, origin: null, messageRole: 'user', inputAdmissionReceipt, inputAuthority }));
        return { status: 'accepted', localId: request.localId };
      } });
    expect(await deps.sessionAgentTransition!({ request: { v: 1, sessionId, expectedCurrentAgentId: 'claude',
      selection: { v: 1, agentId: 'codex' }, input: { localId, text: 'Continue', meta: {} } },
      context: { surface: 'plugin', authority: 'account_automation', actionRequestAttributionV1: cause,
        actionCaller: { kind: 'plugin', pluginId: 'acme.plugin', contributionLocalId: 'continue' } },
    })).toMatchObject({ type: 'accepted', localId });
    expect(admitted).toEqual([cause]);
  });

  const invoke = (phase: 'fence' | 'stop' | 'activate', proof: NonNullable<Parameters<typeof callSessionRpc>[0]['externalAction']> = externalAction) => {
    if (phase === 'fence') return callSessionProviderInputAdmission({ credentials, sessionId,
      action: 'enforce', serviceId: 'session.agentTransition', groupId: 'transition-request', externalAction: proof });
    if (phase === 'stop') return requestSessionStop({ credentials, idOrPrefix: sessionId, stopIntent: 'lifecycle_control', externalAction: proof });
    return requestInactiveSessionResume({ credentials, sessionId, requestId: 'transition-request', rawSession, metadata,
      executionAuthority: 'account_automation', externalAction: proof });
  };

  it.each(['fence', 'stop', 'activate'] as const)('retains the original root proof and exact signed %s request', async phase => {
    const result = await invoke(phase);
    expect(result).toMatchObject(phase === 'fence' ? { status: 'enforced' } : phase === 'stop' ? { stopped: true } : { ok: true });
    const packet = packets[0];
    expect(packet?.externalActionExecution).toMatchObject({ authorization, target,
      effectActionId: 'session.agent.transition', installationId: 'installation' });
    const proof = packet.externalActionExecution!;
    expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
      effectActionId: proof.effectActionId, target, installationId: proof.installationId, event: SOCKET_RPC_EVENTS.CALL,
      method: packet.method, requestId: packet.requestId, params: 'tampered',
      signature: proof.machineSignature, publicKey: keys.publicKey })).toBe(false);
  });

  it.each(['fence', 'stop', 'activate'] as const)('refuses missing root proof before a %s RPC can be sent', async phase => {
    const input = { ...externalAction, context: { authority: 'account_automation' as const, surface: 'api' as const } };
    if (phase === 'fence') await expect(invoke(phase, input)).rejects.toThrow();
    else expect(await invoke(phase, input)).toMatchObject(phase === 'stop' ? { stopped: false } : { ok: false });
    expect(packets).toEqual([]);
  });

  it.each(['fence', 'stop', 'activate'] as const)('retains a forged-proof refusal for %s without an unsigned retry', async phase => {
    const forged = { ...externalAction, privateKey: tweetnacl.sign.keyPair().secretKey };
    if (phase === 'fence') await expect(invoke(phase, forged)).rejects.toThrow();
    else expect(await invoke(phase, forged)).toMatchObject(phase === 'stop' ? { ok: false, errorCode: 'RPC_FORBIDDEN' } : { ok: false });
    expect(packets).toHaveLength(1);
    expect(packets[0].externalActionExecution).toBeDefined();
  });

  it('uses the signed activation transport when a bare custom transport is also supplied', async () => {
    const unsigned = vi.fn(async () => ({ type: 'success', sessionId }));
    await expect(requestInactiveSessionResume({ credentials, sessionId, requestId: 'transition-request', rawSession, metadata,
      externalAction, executionAuthority: 'account_automation', machineRpcTransport: unsigned })).resolves.toEqual({ ok: true });
    expect(unsigned).not.toHaveBeenCalled();
    expect(packets[0]?.externalActionExecution?.authorization).toEqual(authorization);
  });

  it('binds cutover HTTP authorization to the exact Session path and body without the owner bearer', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, dividerSeq: 9 } });
    await expect(applySessionAgentTransitionCutover({ ...cutoverInput, externalAction })).resolves.toEqual({ ok: true, dividerSeq: 9 });
    const [url, body, config] = post.mock.calls[0];
    expect(config?.headers?.Authorization).toBeUndefined();
    expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    const signed = { authorizationToken: authorization.token, effectActionId: externalAction.effectActionId, target,
      installationId: externalAction.installationId, requestId: authorization.binding.requestId,
      method: 'POST', path: new URL(String(url)).pathname, body,
      signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey };
    expect(verifyExternalActionMachineRequestV1(signed)).toBe(true);
    expect(verifyExternalActionMachineRequestV1({ ...signed, body: { v: 1 } })).toBe(false);
  });

  it('refuses missing cutover authority without issuing an owner-authorized request', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, dividerSeq: 9 } });
    await expect(applySessionAgentTransitionCutover({ ...cutoverInput, externalAction: { ...externalAction,
      context: { authority: 'account_automation', surface: 'api' } } })).resolves.toEqual({ ok: false, effect: 'none', error: 'forbidden' });
    expect(post).not.toHaveBeenCalled();
  });

  it('retains a forged cutover proof refusal without retrying with the owner bearer', async () => {
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(config?.headers?.Authorization).toBeUndefined();
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
        effectActionId: externalAction.effectActionId, target, installationId: externalAction.installationId,
        requestId: authorization.binding.requestId, method: 'POST', path: new URL(String(url)).pathname, body,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(false);
      return { status: 403, data: { error: 'Forbidden' } };
    });
    await expect(applySessionAgentTransitionCutover({ ...cutoverInput,
      externalAction: { ...externalAction, privateKey: tweetnacl.sign.keyPair().secretKey } })).resolves.toEqual({
      ok: false, effect: 'none', error: 'forbidden',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) =>
    createExternalActionAuthorizedRequestHeaders({ ...externalAction, authorization, target, ...request });

  it('retains proof on idle discovery, transcript rechecks and socket reconnect snapshot reads', async () => {
    const get = vi.mocked(axios.get);
    const ordinaryGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => new URL(String(url)).pathname.endsWith('/messages')
      ? { status: 200, data: { messages: [], hasMore: false } } : ordinaryGet(url, config));
    await expect(waitForSessionIdle({ credentials, idOrPrefix: sessionId, timeoutMs: 1000,
      resolveAuthorizationHeaders })).resolves.toMatchObject({ ok: true, idle: true });
    const paths = get.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toContain(`/v1/sessions/${sessionId}/messages`);
    expect(paths.filter(path => path === `/v2/sessions/${sessionId}`).length).toBeGreaterThan(1);
    for (const [url, config] of get.mock.calls) {
      expect(config?.headers?.Authorization).toBeUndefined();
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      const parsedUrl = new URL(String(url));
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
        effectActionId: externalAction.effectActionId, target, installationId: externalAction.installationId,
        requestId: authorization.binding.requestId, method: 'GET', path: `${parsedUrl.pathname}${parsedUrl.search}`,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
    }
  });

  it('retains proof on refreshed activity projection and after-sequence transcript fallback', async () => {
    const get = vi.mocked(axios.get);
    const ordinaryGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => new URL(String(url)).pathname.endsWith('/messages')
      ? { status: 200, data: { messages: [], hasMore: false } } : ordinaryGet(url, config));
    await expect(detectLatestSessionTurnActivity({ token: credentials.token, sessionId, encryptionMode: 'plain',
      encryptionKey: null, encryptionVariant: null, afterSeqExclusive: 7, resolveAuthorizationHeaders,
    })).resolves.toMatchObject({ turnInFlight: false });
    expect(get.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v2/sessions/${sessionId}`, `/v1/sessions/${sessionId}/messages`,
    ]);
    for (const [, config] of get.mock.calls) {
      expect(config?.headers?.Authorization).toBeUndefined();
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    }
    expect(String(get.mock.calls[1]?.[0])).toContain('afterSeq=7');
  });

  it('uses scoped replay authority and the supplied requester seed budget for an activation brief', async () => {
    const get = vi.mocked(axios.get);
    const ordinaryGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, config) => {
      if (new URL(String(url)).pathname.endsWith('/messages')) return { status: 200, data: {
        messages: [{ id: 'message-1', seq: 1, createdAt: 1, content: { t: 'plain', v: {
          role: 'user', content: { type: 'text', text: 'Replay this task carefully. '.repeat(500) },
        } } }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      return ordinaryGet(url, config);
    });
    const result = await buildBoundedActivationBrief({ credentials, sessionId, sourceMetadata: metadata,
      departingAgentCurrentView: metadata, transcriptHeadSeqInclusive: 1,
      resolveAuthorizationHeaders, accountSettings: { sessionReplayMaxSeedChars: 4096 } });
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('Expected an activation brief');
    expect(result.seed?.seedText.length).toBeLessThanOrEqual(4096);
    expect(result.seed?.seedText).toContain('Replay this task');
    for (const [, config] of get.mock.calls) {
      expect(config?.headers?.Authorization).toBeUndefined();
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    }
  });

  it('refuses unavailable scoped replay authority before issuing an owner-authorized read', async () => {
    await expect(buildBoundedActivationBrief({ credentials, sessionId, sourceMetadata: metadata,
      departingAgentCurrentView: metadata, transcriptHeadSeqInclusive: 1,
      resolveAuthorizationHeaders: () => null, accountSettings: null })).resolves.toEqual({ status: 'unavailable' });
    expect(axios.get).not.toHaveBeenCalled();
  });
});
