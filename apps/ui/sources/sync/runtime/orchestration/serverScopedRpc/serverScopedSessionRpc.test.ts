import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSerializedJsonValue, stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import {
  publishAppliedActiveServerSnapshot,
  publishAppliedActiveServerRuntimeAvailability,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { VoiceAgentHandle } from '@/voice/agent/types';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, SESSION_RPC_METHODS, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD } from '@happier-dev/protocol/sessions';
import { raceSocketIoAckTimeout, socketRpcCodec } from '@happier-dev/sync-client';

import { resetSessionByIdHttpReadsForTests } from '@/sync/engine/sessions/sessionByIdHttp';
import { sessionRpcWithPreferredSessionScope } from './sessionRpcWithPreferredSessionScope';

const TOKEN_A = `hdr.${btoa(JSON.stringify({ sub: 'account-a' }))}.sig`;
const TOKEN_B = `hdr.${btoa(JSON.stringify({ sub: 'account-b' }))}.sig`;

const scopedAccount = vi.hoisted(() => ({ mode: 'plain' as 'plain' | 'e2ee' }));

const sessionListByIdFixture = {
  id: 'session-1',
  seq: 1,
  createdAt: 1,
  updatedAt: 1,
  active: false,
  activeAt: 1,
  archivedAt: null,
  metadata: 'metadata',
  metadataVersion: 1,
  agentState: null,
  agentStateVersion: 0,
  pendingCount: 0,
  pendingVersion: 0,
  dataEncryptionKey: 'k1',
} as const;

const sessionRpcSpy = vi.hoisted(() => vi.fn());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn(() => ({
  serverId: 'server-a',
  serverUrl: 'https://server-a.example.test',
  kind: 'custom',
  generation: 1,
})));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
  createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    getSessionScopedTarget: () => null,
    sessionRPC: (...args: unknown[]) => sessionRpcSpy(...args),
  },
}));

// Envelope-only doubles still join the shared Account encryption owner (3b75c5855f), which
// binds, scopes and retires the instance it receives; the real Encryption implements these.
vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/auth/encryption/createEncryptionFromAuthCredentials')>(),
  createEncryptionFromAuthCredentials: async (...args: unknown[]) => {
    const encryption = await createEncryptionSpy(...args);
    if (!encryption || typeof encryption !== 'object') return encryption;
    return Object.assign(encryption, {
      configureNativeCryptoWorker: (encryption as { configureNativeCryptoWorker?: unknown }).configureNativeCryptoWorker ?? (() => {}),
      bindAccountMaterialCurrentness: (encryption as { bindAccountMaterialCurrentness?: unknown }).bindAccountMaterialCurrentness ?? (() => {}),
      retireAccountMaterial: (encryption as { retireAccountMaterial?: unknown }).retireAccountMaterial ?? (() => {}),
    });
  },
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
  const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
  return { ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(), ...createServerProfilesModuleMock({
    listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
  }) };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  subscribeActiveServer: () => () => {},
  getActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
}));

// The request-context owner reads the applied active server (as its sibling tests mock it).
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
  getAppliedActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
  isAppliedActiveServerRuntimeAvailable: () => true,
}));

vi.mock('@/utils/system/runtimeFetch', async () => {
  const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
  const {
    createLegacyAccountEncryptionCurrentnessFixture,
    createPlainAccountEncryptionCurrentnessFixture,
  } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
  return { runtimeFetch: createSessionReadBatchFetchBoundary((input: RequestInfo | URL, init?: RequestInit) => {
    // Account admission precedes Session reads. Mirror its independent HTTP
    // resource rather than returning a Session row to the strict mode parser.
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') {
      return Promise.resolve(Response.json(scopedAccount.mode === 'e2ee'
        ? createLegacyAccountEncryptionCurrentnessFixture({ secret: scopedAccountSecret })
        : createPlainAccountEncryptionCurrentnessFixture()));
    }
    if (path === '/v1/account/encryption') {
      return Promise.resolve(Response.json({ mode: scopedAccount.mode, updatedAt: 0 }));
    }
    if (String(input).endsWith('/v1/auth/ping')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return globalThis.fetch(input, init);
  }) ,
      get runtimeFetchManualResponse() { return this.runtimeFetch; },
  };
});

vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation((...args) => getCredentialsSpy(...args));

const initialStorageState = storage.getState();

const scopedAccountSecret = new Uint8Array(32).fill(21);
const scopedSessionDataKey = new Uint8Array(32).fill(9);

/**
 * Uses the real Account encryption owner for the scoped credentials, and returns the real
 * data-key envelope sealed to that Account plus a daemon-side codec holding the same DEK.
 */
async function useRealScopedEncryption() {
  scopedAccount.mode = 'e2ee';
  const actual = await vi.importActual<typeof import('@/auth/encryption/createEncryptionFromAuthCredentials')>(
    '@/auth/encryption/createEncryptionFromAuthCredentials',
  );
  createEncryptionSpy.mockImplementation(actual.createEncryptionFromAuthCredentials);
  const { Encryption } = await import('@/sync/encryption/encryption');
  const { encodeBase64 } = await import('@/encryption/base64');
  const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
  const account = await Encryption.create(scopedAccountSecret);
  const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: scopedSessionDataKey,
    recipientPublicKey: account.contentDataKey,
    randomBytes: (length) => new Uint8Array(length).fill(3),
  }), 'base64');
  await account.initializeSessions(new Map([['session-1', scopedSessionDataKey]]));
  const daemon = account.getSessionEncryption('session-1')!;
  return {
    credentials: { token: TOKEN_B, secret: Buffer.from(scopedAccountSecret).toString('base64url') },
    envelope,
    daemon,
  };
}

describe('sessionRpcWithServerScope', () => {
  afterEach(() => {
    scopedAccount.mode = 'plain';
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialStorageState, true);
    vi.useRealTimers();
    sessionRpcSpy.mockReset();
    createEphemeralSocketSpy.mockReset();
    getCredentialsSpy.mockReset();
    createEncryptionSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    vi.unstubAllGlobals();
    resetSessionByIdHttpReadsForTests();
  });

  it('keeps a native permission answer pending until the owner acknowledges beyond the generic RPC cutoff', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1 });
    storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: 'server-a', active: true }) } });
    const { sessionRespondToPermission } = await import('@/sync/ops/sessions');
    vi.useFakeTimers();
    // Socket acknowledgement is the system boundary. Keep permission routing,
    // Home context and response mapping real for the observed 50.8-second reply.
    sessionRpcSpy.mockImplementation((_sessionId, _method, _payload, options) => raceSocketIoAckTimeout(
      new Promise(resolve => setTimeout(() => resolve({ ok: true }), 50_805)), options.timeoutMs, options.signal,
    ));
    const result = sessionRespondToPermission('session-1', { id: 'native-request', approved: true, turnId: 'native-turn' },
      { serverId: 'server-a' }).then(() => ({ ok: true }), error => ({ ok: false, error }));
    await vi.advanceTimersByTimeAsync(50_805);
    expect(await result).toEqual({ ok: true });
    expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
  });

  it('acknowledges delayed Review admission once, without the generic RPC deadline', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1 });
    storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: 'server-a', active: true }) } });
    const { sessionExecutionRunStart } = await import('@/sync/ops/sessionExecutionRuns');
    vi.useFakeTimers();
    const admission = { runId: 'review-run', callId: 'review-call', sidechainId: 'review-sidechain' };
    // Only the socket boundary is substituted; the operation, route and timeout owner are real.
    sessionRpcSpy.mockImplementation((_sessionId, _method, _payload, options) => raceSocketIoAckTimeout(
      new Promise(resolve => setTimeout(() => resolve(admission), 181_000)), options.timeoutMs, options.signal,
    ));
    const pending = sessionExecutionRunStart('session-1', { intent: 'review',
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      instructions: 'Review these changes', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming',
    }, { serverId: 'server-a' });
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await pending).toEqual(admission);
    expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps Review admission cancellable before socket issuance', async () => {
    storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: 'server-a', active: true }) } });
    const { sessionExecutionRunStart } = await import('@/sync/ops/sessionExecutionRuns');
    const controller = new AbortController();
    controller.abort();
    expect(await sessionExecutionRunStart('session-1', { intent: 'review',
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
    }, { serverId: 'server-a', signal: controller.signal })).toMatchObject({
      ok: false,
    });
    expect(sessionRpcSpy).not.toHaveBeenCalled();
  });

  it('delegates to apiSocket.sessionRPC when target server is omitted', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 1 },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith(
      'session-1',
      'method-test',
      { value: 1 },
      expect.objectContaining({
        timeoutMs: 5000,
        onIssued: expect.any(Function),
      }),
    );
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('rejects a pre-aborted session call before resolving or issuing it', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });
    const controller = new AbortController();
    controller.abort();

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const outcome = sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 1 },
      timeoutMs: 5000,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await expect(outcome).resolves.toMatchObject({
      name: 'AbortError',
      code: 'SOCKET_RPC_ABORTED',
    });
    const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
    expect(readRpcRequestDisposition(await outcome)).toBe('notSent');

    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('preserves an explicit unbounded RPC lifetime for the active server', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-watch',
      payload: { value: 1 },
      timeoutMs: null,
    })).resolves.toEqual({ ok: true });

    expect(sessionRpcSpy).toHaveBeenCalledWith(
      'session-1',
      'method-watch',
      { value: 1 },
      expect.objectContaining({
        timeoutMs: null,
        onIssued: expect.any(Function),
      }),
    );
  });

  it('keeps scoped connection setup bounded while preserving an unbounded RPC lifetime', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => null),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { watched: true } }));
    const timeout = vi.fn((_timeoutMs?: number) => ({ emitWithAck: vi.fn() }));
    const fakeSocket = {
      timeout,
      emitWithAck,
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      serverId: 'server-b',
      method: 'session.permission.remote.grants.list',
      payload: { sessionId: 'session-1' },
      timeoutMs: null,
    })).resolves.toEqual({ watched: true });

    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 30_000,
    }));
    // Socket.IO's incumbent timeout flag may be cleared; no finite RPC deadline may be selected.
    expect(timeout.mock.calls.every(([value]) => value === undefined)).toBe(true);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:session.permission.remote.grants.list',
      params: { sessionId: 'session-1' },
      authorization: { kind: 'session.write', sessionId: 'session-1' },
      timeoutMs: null,
      // Ordinary calls carry a diagnostic-only trace id (f3e31f32da).
      traceId: expect.any(String),
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['home-switch', 'account-replacement'] as const)('keeps delayed Voice cleanup bound to its admitting Account (%s)', async (transition) => {
    const { DaemonVoiceAgentClient } = await import('@/voice/agent/daemonVoiceAgentClient');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { createVoiceRunRecovery } = await import('@/voice/runtime/execution/voiceRunRecovery');
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
    });
    storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshotSpy());
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Missing admitting Account fixture');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    const handle: VoiceAgentHandle = {
      client, accountLifetime, metadataSessionId: 'session-1', backend: 'daemon',
      voiceAgentId: 'run-a', rpcSessionId: 'session-1', agentBackendId: 'claude', transcriptEpoch: 0,
    };
    const handles = new Map([['session-1', handle]]);
    const recovery = createVoiceRunRecovery({
      createHandle: async () => handle,
      voiceAgentBySessionId: handles,
      voiceAgentInitBySessionId: new Map(),
      voiceAttemptExplicitContextBySessionId: new Map(),
      deferredTargetSessionContextBySessionId: new Map(),
      latestAutomaticUiContextBySessionId: new Map(),
    });
    // Native capture teardown can finish after sync has installed another Home/Account.
    let finishCapture!: () => void;
    const captureStopped = new Promise<void>((resolve) => { finishCapture = resolve; });
    const cleanup = async () => {
      await captureStopped;
      await client.cancelTurnStream({ sessionId: 'session-1', voiceAgentId: 'run-a', streamId: 'stream-a' });
      await client.stop({ sessionId: 'session-1', voiceAgentId: 'run-a' });
    };
    const pending = cleanup();
    const recoveryStopped = recovery.prepareStop('session-1', () => captureStopped).run();
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: transition === 'home-switch' ? 'server-b' : 'server-a',
      serverUrl: transition === 'home-switch' ? 'https://server-b.example.test' : 'https://server-a.example.test',
      kind: 'custom', generation: 2,
    });
    const nextServerId = transition === 'home-switch' ? 'server-b' : 'server-a';
    const nextMetadata = { path: '/next', host: 'next', voiceAgentRunV1: { runId: 'run-b' } };
    storage.setState({
      profileScope: { serverId: nextServerId, accountId: 'account-b' },
      sessions: { 'session-1': createSessionFixture({ serverId: nextServerId, metadata: nextMetadata }) },
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshotSpy());
    const nextLifetime = captureActiveServerAccountScopeLifetime();
    if (!nextLifetime) throw new Error('Missing replacement Account fixture');
    const nextHandle = { ...handle, accountLifetime: nextLifetime, voiceAgentId: 'run-b' };
    handles.set('session-1', nextHandle);
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-a', serverUrl: 'https://server-a.example.test', name: 'Server A' },
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: transition === 'home-switch' ? TOKEN_A : TOKEN_B });
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => null),
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      session: { ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null },
    })));
    const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({
      ok: true,
      result: payload.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)
        ? { runs: [{
          runId: 'run-a-duplicate', callId: 'call-a', sidechainId: 'sidechain-a', intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
          retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        }] }
        : { ok: true },
    }));
    createEphemeralSocketSpy.mockResolvedValue({
      timeout: vi.fn(() => ({ emitWithAck })), emitWithAck, disconnect: vi.fn(),
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });
    finishCapture();
    if (transition === 'account-replacement') {
      await Promise.all([
        expect(pending).rejects.toThrow(/account.*match/i),
        expect(recoveryStopped).rejects.toMatchObject({ rpcErrorCode: 'action_account_scope_changed' }),
      ]);
      expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    } else {
      await pending;
      await recoveryStopped;
      expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
        serverUrl: 'https://server-a.example.test', token: TOKEN_A,
      }));
      const cancel = emitWithAck.mock.calls.find((call) => JSON.stringify(call).includes('stream-a'));
      expect(cancel).toBeDefined();
      expect(cancel?.[1]).toHaveProperty('timeoutMs', null);
      expect(emitWithAck.mock.calls.map((call) => call[1].method)).toContain(`session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`);
      expect(emitWithAck.mock.calls.map((call) => call[1].params)).toContainEqual({ runId: 'run-a-duplicate' });
      expect(createEphemeralSocketSpy.mock.calls.every(([options]) => options.serverUrl === 'https://server-a.example.test')).toBe(true);
    }
    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(storage.getState().sessions['session-1'].metadata).toEqual(nextMetadata);
    expect(handles.get('session-1')).toBe(nextHandle);
  });

  it('falls back to a scoped plaintext RPC when active session RPC lacks local encryption context', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockRejectedValueOnce(new Error('Session encryption not found for session-1'));
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_A });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { decodedPlain: true } }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 4 },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith(
      'session-1',
      'method-test',
      { value: 4 },
      expect.objectContaining({
        timeoutMs: 5000,
        onIssued: expect.any(Function),
      }),
    );
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-a.example.test',
      token: TOKEN_A,
      timeoutMs: 5000,
    }));
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 4 },
      timeoutMs: 5000,
      traceId: expect.any(String),
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('preserves an active presentation bind pre-issuance failure without creating an ephemeral socket', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const encryptionFailure = Object.assign(
      new Error('Session encryption not found for session-1'),
      { rpcErrorCode: 'session_encryption_not_found' },
    );
    sessionRpcSpy.mockRejectedValueOnce(encryptionFailure);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
      payload: { clientId: 'client-1', focused: true, draftRevision: 1 },
      timeoutMs: 5000,
    })).rejects.toBe(encryptionFailure);

    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('refuses a presentation bind for a non-active Home without creating an ephemeral socket', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => null),
    });

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      serverId: 'server-b',
      method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
      payload: { clientId: 'client-1', focused: true, draftRevision: 1 },
      timeoutMs: 5000,
    })).rejects.toMatchObject({
      name: 'RpcError',
      rpcErrorCode: 'current_session_presentation_active_home_required',
    });

    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('falls back to a scoped plaintext RPC when active session RPC reports method not available', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const methodUnavailableError = new Error('RPC method not available');
    Object.assign(methodUnavailableError, { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    sessionRpcSpy.mockRejectedValueOnce(methodUnavailableError);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_A });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    const calls: string[] = [];
    const emitWithAck = vi.fn(async () => {
      calls.push('emit');
      return { ok: true, result: { decodedPlain: true } };
    });
    const fakeSocket = {
      timeout: vi.fn(() => {
        calls.push('timeout-emitter');
        return { emitWithAck };
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);
    const onIssued = vi.fn(() => calls.push('issued'));

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 5 },
      timeoutMs: 5000,
      onIssued,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith('session-1', 'method-test', { value: 5 }, {
      timeoutMs: 5000,
      onIssued: expect.any(Function),
    });
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-a.example.test',
      token: TOKEN_A,
      timeoutMs: 5000,
    }));
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 5 },
      timeoutMs: 5000,
      traceId: expect.any(String),
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['timeout-emitter', 'issued', 'emit']);
    expect(onIssued).toHaveBeenCalledTimes(1);
  });

  it('does not fall back after an exact active session RPC crosses the socket issuance boundary', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const methodUnavailableError = new Error('RPC method not available after emit');
    Object.assign(methodUnavailableError, { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    sessionRpcSpy.mockImplementationOnce(async (_sessionId, _method, _payload, options) => {
      options.onIssued();
      throw methodUnavailableError;
    });
    const onIssued = vi.fn();

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 8 },
      timeoutMs: 5000,
      onIssued,
    })).rejects.toBe(methodUnavailableError);

    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('does not fall back after issuance when the caller does not request an issuance callback', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const methodUnavailableError = new Error(
      'RPC method not available after emit',
    );
    Object.assign(methodUnavailableError, {
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
    });
    sessionRpcSpy.mockImplementationOnce(
      async (_sessionId, _method, _payload, options) => {
        options.onIssued();
        throw methodUnavailableError;
      },
    );

    const { sessionRpcWithServerScope } = await import(
      './serverScopedSessionRpc'
    );
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'session.model.transition',
      payload: { value: 9 },
      timeoutMs: 5000,
    })).rejects.toBe(methodUnavailableError);

    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('routes RPC through a scoped socket when target server differs from active server', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    const { credentials, envelope, daemon } = await useRealScopedEncryption();
    getCredentialsSpy.mockResolvedValue(credentials);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: { ...sessionListByIdFixture, dataEncryptionKey: envelope } })),
    );

    const daemonSaw: unknown[] = [];
    const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: string }) => {
      const content = { mode: 'e2ee' as const, cipher: daemon };
      const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
      daemonSaw.push(decoded.params);
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, { decoded: true }, decoded.callId) };
    });
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 2 },
      serverId: 'server-b',
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decoded: true });
    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-b.example.test',
      token: TOKEN_B,
      timeoutMs: 5000,
    }));
    expect(daemonSaw).toEqual([{ value: 2 }]);
    expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: expect.any(String),
      timeoutMs: 5000,
      traceId: expect.any(String),
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses a repaired Session envelope on the next scoped RPC with the same bearer', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    const { credentials, envelope, daemon } = await useRealScopedEncryption();
    getCredentialsSpy.mockResolvedValue(credentials);
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
    const account = await Encryption.create(scopedAccountSecret);
    // This is a valid envelope for the right recipient, but contains the wrong
    // Session DEK. Opening the envelope alone cannot establish its freshness.
    let publishedEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(32).fill(10),
      recipientPublicKey: account.contentDataKey,
      randomBytes: (length) => new Uint8Array(length).fill(4),
    }), 'base64');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      session: { ...sessionListByIdFixture, encryptionMode: 'e2ee', dataEncryptionKey: publishedEnvelope },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const daemonSaw: unknown[] = [];
    const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: string }) => {
      const opened = await daemon.decryptRaw(payload.params);
      if (opened === null) {
        daemonSaw.push(null);
        return { ok: false, error: 'Session key does not match', errorCode: 'invalid_session_key' };
      }
      const content = { mode: 'e2ee' as const, cipher: daemon };
      const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
      daemonSaw.push(decoded.params);
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, { accepted: true }, decoded.callId) };
    });
    createEphemeralSocketSpy.mockResolvedValue({
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    });
    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const call = () => sessionRpcWithServerScope({
      sessionId: 'session-1', serverId: 'server-b', method: 'method-test',
      payload: { value: 2 }, timeoutMs: 5000,
    });

    await expect(call()).rejects.toMatchObject({ rpcErrorCode: 'invalid_session_key' });
    publishedEnvelope = envelope;
    await expect(call()).resolves.toEqual({ accepted: true });
    expect(daemonSaw).toEqual([null, { value: 2 }]);
  });

  it('uses an exact same-URL alternate profile context instead of the active socket', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test/',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-a.example.test', name: 'Server A (alt id)' },
    ]);
    const { credentials, envelope, daemon } = await useRealScopedEncryption();
    getCredentialsSpy.mockResolvedValue(credentials);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: { ...sessionListByIdFixture, dataEncryptionKey: envelope } })),
    );

    const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: string }) => {
      const content = { mode: 'e2ee' as const, cipher: daemon };
      const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, { ok: true, source: 'alternate-profile' }, decoded.callId) };
    });
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(
      sessionRpcWithServerScope({
        sessionId: 'session-1',
        method: 'method-test',
        payload: { value: 6 },
        serverId: 'server-b',
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({ ok: true, source: 'alternate-profile' });

    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(getCredentialsSpy).toHaveBeenCalledWith('https://server-a.example.test', { serverId: 'server-b' });
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-a.example.test',
      token: TOKEN_B,
      timeoutMs: 5000,
    }));
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('routes plaintext RPC through a scoped socket when session encryptionMode is plain', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { decodedPlain: true } }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 3 },
      serverId: 'server-b',
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-b.example.test',
      token: TOKEN_B,
      timeoutMs: 5000,
    }));
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 3 },
      timeoutMs: 5000,
      traceId: expect.any(String),
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit Home B permission response off the active Home A socket', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    const emitWithAck = vi.fn(async () => ({
      ok: true,
      result: { decodedPlain: true },
    }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    await expect(sessionRpcWithPreferredSessionScope({
      sessionId: 'session-1',
      method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
      payload: { id: 'permission-b', approved: true },
      serverId: 'server-b',
      timeoutMs: 5000,
    })).resolves.toEqual({ decodedPlain: true });

    expect(createEncryptionSpy).not.toHaveBeenCalled();
    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(getCredentialsSpy).toHaveBeenCalledWith('https://server-b.example.test', { serverId: 'server-b' });
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: `session-1:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
      params: { id: 'permission-b', approved: true },
      authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId: 'session-1' },
      timeoutMs: 5000,
      traceId: expect.any(String),
    });
  });

  it('rejects when a scoped socket ACK never settles', async () => {
    vi.useFakeTimers();
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 7 },
      serverId: 'server-b',
      timeoutMs: 5000,
    }).then(
      () => ({ state: 'resolved' as const }),
      (error: unknown) => ({
        state: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    await vi.waitFor(() => {
      expect(emitWithAck).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(Promise.race([
      result,
      Promise.resolve({ state: 'pending' as const }),
    ])).resolves.toEqual({
      state: 'rejected',
      message: 'operation has timed out',
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('locally fences an old scoped peer that ignores cancellation and replies late', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => null),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ session: {
        ...sessionListByIdFixture, encryptionMode: 'plain', dataEncryptionKey: null,
      } })),
    );

    let resolveLateAck!: (value: unknown) => void;
    const emitWithAck = vi.fn<(event: string, payload: unknown) => Promise<unknown>>(() => new Promise<unknown>((resolve) => {
      resolveLateAck = resolve;
    }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);
    const controller = new AbortController();

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const pending = sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 8 },
      serverId: 'server-b',
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));
    const issuedPayload = emitWithAck.mock.calls[0]?.[1] as { requestId?: unknown };

    controller.abort();

    const settled = await Promise.race([
      pending.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(settled).toMatchObject({
      status: 'rejected',
      error: { name: 'AbortError', code: 'SOCKET_RPC_ABORTED' },
    });
    const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
    expect(settled.status === 'rejected' && readRpcRequestDisposition(settled.error)).toBe('outcomeUnknown');
    expect(issuedPayload.requestId).toEqual(expect.any(String));
    expect(fakeSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
      requestId: issuedPayload.requestId,
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);

    resolveLateAck({ ok: true, result: { stale: true } });
    await Promise.resolve();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'SOCKET_RPC_ABORTED',
    });
  });

  describe('historical 0.2 owner Session with no data-key envelope over explicit scoped RPC', () => {
    // A 0.2 legacy-secret Account created this Session: the row carries no `share`, no
    // current access projection and `dataEncryptionKey: null`, and the 0.2 daemon seals RPC
    // traffic with `encryptLegacy` (tweetnacl secretbox over the Account secret of the
    // serialized-JSON envelope, nonce||box, base64) — `../0.2`
    // `apps/cli/src/api/encryption.ts#encryptLegacy`/`decryptLegacy` at 7fc35fe14a.
    const accountSecret = scopedAccountSecret;
    const released02OwnerRow = {
      ...sessionListByIdFixture,
      encryptionMode: 'e2ee',
      dataEncryptionKey: null,
    } as const;

    function sealLikeReleased02Daemon(value: unknown): string {
      const nonce = new Uint8Array(tweetnacl.secretbox.nonceLength).fill(4);
      const box = tweetnacl.secretbox(new TextEncoder().encode(stringifySerializedJsonValue(value)), nonce, accountSecret);
      const bundle = new Uint8Array(nonce.length + box.length);
      bundle.set(nonce);
      bundle.set(box, nonce.length);
      return Buffer.from(bundle).toString('base64');
    }

    function openLikeReleased02Daemon(value: string): unknown {
      const bundle = new Uint8Array(Buffer.from(value, 'base64'));
      const opened = tweetnacl.secretbox.open(
        bundle.slice(tweetnacl.secretbox.nonceLength),
        bundle.slice(0, tweetnacl.secretbox.nonceLength),
        accountSecret,
      );
      return opened ? parseSerializedJsonValue(new TextDecoder().decode(opened)) : null;
    }

    async function arrangeScopedHomeB(row: Record<string, unknown>, bound = true) {
      getActiveServerSnapshotSpy.mockReturnValue({
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        kind: 'custom',
        generation: 1,
      });
      listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
      // The real Account encryption owner, built from the real stored legacy-secret credentials.
      const { credentials } = await useRealScopedEncryption();
      getCredentialsSpy.mockResolvedValue(credentials);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: row }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })));
      const daemonSaw: unknown[] = [];
      const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: string }) => {
        const content = { mode: 'e2ee' as const, cipher: {
          encryptRaw: async (value: unknown) => sealLikeReleased02Daemon(value),
          decryptRaw: async (value: string) => openLikeReleased02Daemon(value),
        } };
        if (!bound) return { ok: true, result: sealLikeReleased02Daemon({ answered: true }) };
        const request = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
        daemonSaw.push(request.params);
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, { answered: true }, request.callId) };
      });
      const fakeSocket = { timeout: vi.fn(() => ({ emitWithAck })), emit: vi.fn(), disconnect: vi.fn() };
      createEphemeralSocketSpy.mockResolvedValue(fakeSocket);
      return { daemonSaw, emitWithAck };
    }

    it('reaches retained 0.2 Session data with the historical cipher and v0.3 RPC binding', async () => {
      const { daemonSaw } = await arrangeScopedHomeB(released02OwnerRow);

      const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
      const result = await sessionRpcWithServerScope({
        sessionId: 'session-1',
        method: 'method-test',
        payload: { value: 7 },
        serverId: 'server-b',
        timeoutMs: 5000,
      });

      expect(daemonSaw).toEqual([{ value: 7 }]);
      expect(result).toEqual({ answered: true });
    });

    it('requires an update for an unbound response from a 0.2 daemon', async () => {
      await arrangeScopedHomeB(released02OwnerRow, false);
      const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
      await expect(sessionRpcWithServerScope({
        sessionId: 'session-1', method: 'method-test', payload: { value: 7 }, serverId: 'server-b', timeoutMs: 5000,
      })).rejects.toMatchObject({ rpcErrorCode: 'RPC_UPDATE_REQUIRED' });
    });

    it.each([
      ['a recipient with no envelope of its own', { ...released02OwnerRow, share: { accessLevel: 'edit', canApprovePermissions: false } }],
      ['an owner whose present envelope is malformed', { ...released02OwnerRow, dataEncryptionKey: '' }],
    ])('keeps %s unavailable instead of reaching the Account-secret reader', async (_label, row) => {
      const { emitWithAck } = await arrangeScopedHomeB(row);

      const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
      await expect(sessionRpcWithServerScope({
        sessionId: 'session-1',
        method: 'method-test',
        payload: { value: 7 },
        serverId: 'server-b',
        timeoutMs: 5000,
      })).rejects.toMatchObject({ rpcErrorCode: 'scoped_session_encryption_unavailable' });
      expect(emitWithAck).not.toHaveBeenCalled();
    });
  });
});
