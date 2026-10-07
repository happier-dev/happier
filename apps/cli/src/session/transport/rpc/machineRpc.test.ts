import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from '@/api/encryption';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';

const socketHandlers = new Map<string, () => void>();
const socketListeners = new Map<string, Set<() => void>>();
const pendingAcks = new Set<(error: Error) => void>();
function rejectPendingAcks() {
  for (const reject of pendingAcks) reject(new Error('Machine RPC socket disconnected before acknowledgement'));
  pendingAcks.clear();
}
const socket = {
  io: createSocketIoManagerStub(),
  connected: false,
  connect: vi.fn(() => socketHandlers.get('connect')?.()),
  on: vi.fn((event: string, handler: () => void) => {
    const listeners = socketListeners.get(event) ?? new Set<() => void>();
    listeners.add(handler);
    socketListeners.set(event, listeners);
    socketHandlers.set(event, () => {
      if (event === 'connect') socket.connected = true;
      if (event === 'disconnect') { socket.connected = false; rejectPendingAcks(); }
      for (const listener of listeners) listener();
    });
  }),
  off: vi.fn((event: string, handler?: () => void) => {
    const listeners = socketListeners.get(event);
    if (handler) listeners?.delete(handler); else listeners?.clear();
    if (!listeners?.size) { socketListeners.delete(event); socketHandlers.delete(event); }
  }),
  removeAllListeners: vi.fn(() => { socketListeners.clear(); socketHandlers.clear(); }),
  disconnect: vi.fn(() => { socket.connected = false; rejectPendingAcks(); }),
  close: vi.fn(),
  emit: vi.fn(),
  // Mirror Socket.IO's promise acknowledgement and its disconnect rejection.
  emitWithAck: vi.fn((event: string, payload: unknown) => new Promise<unknown>((resolve, reject) => {
    pendingAcks.add(reject);
    try {
      socket.emit(event, payload, (value: unknown) => { pendingAcks.delete(reject); resolve(value); });
    } catch (error) { pendingAcks.delete(reject); reject(error); }
  })),
};
const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
  },
}));
vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.test',
    apiServerUrl: 'https://api.example.test',
  },
}));

import {
  TERMINAL_STREAM_MAX_ENCODED_BYTES,
  TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
  TerminalStreamReadRequestSchema,
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  encodeTerminalStreamBytes,
  sealEncryptedDataKeyEnvelopeV1,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveBoxPublicKeyFromSeed,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1,
  verifyExternalActionMachineRpcRequestV1,
  computeRunnerMachineContentKeyFingerprintV1,
  encodeBase64 as encodeProtocolBase64,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { callExactMachineRpc, callMachineRpc, readMachineRpcRequestDisposition } from './machineRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { io } from 'socket.io-client';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';

/** Account content material exactly as the CLI persists it: a box seed plus its own public key. */
function accountDataKeyCredentials(seedByte: number) {
  const machineKey = new Uint8Array(32).fill(seedByte);
  return {
    token: 'account-token',
    encryption: {
      type: 'dataKey' as const,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
      machineKey,
    },
  };
}

function legacyCredentials(seedByte: number) {
  return {
    token: 'account-token',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(seedByte) },
  };
}

/** What a Machine actually publishes: its content key sealed to an Account content public key. */
function publishedMachineDataEncryptionKey(params: Readonly<{
  contentKey: Uint8Array;
  recipientPublicKey: Uint8Array;
}>): string {
  return encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: params.contentKey,
    recipientPublicKey: params.recipientPublicKey,
    randomBytes: getRandomBytes,
  }));
}

function rpcContent(key: Uint8Array, variant: 'dataKey' | 'legacy' = 'dataKey'): SocketRpcContent {
  return { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(key, variant, value)),
    decryptRaw: async value => decrypt(key, variant, decodeBase64(value)),
  } };
}
async function openedWith(key: Uint8Array, encoded: unknown, method: string, variant: 'dataKey' | 'legacy' = 'dataKey'): Promise<unknown> {
  try {
    return (await socketRpcCodec.decodeRequestParams(rpcContent(key, variant), encoded, method)).params;
  } catch {
    return null;
  }
}
async function responseForRequest(key: Uint8Array, request: { method: string; params: unknown }, result: unknown, variant: 'dataKey' | 'legacy' = 'dataKey') {
  const content = rpcContent(key, variant);
  const decoded = await socketRpcCodec.decodeRequestParams(content, request.params, request.method);
  return socketRpcCodec.encodeResponse(content, result, decoded.callId);
}

describe('callMachineRpc', () => {
  it('reattaches a read-only observation on reconnect with the same target and cursor', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const requests: unknown[] = [];
    socket.emit.mockImplementation((event, payload, ack) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      requests.push(payload.params);
      if (requests.length === 2) ack({ ok: true, result: { cursor: 81 } });
    });
    const controller = new AbortController();
    const observation = callExactMachineRpc({
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
      request: { cursor: 42 },
      timeoutMs: null,
      reattachOnReconnect: true,
      signal: controller.signal,
    });
    // Attach rejection immediately so the defective one-shot path is observable.
    const outcome = observation.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socketHandlers.get('disconnect')?.();
      socketHandlers.get('connect')?.();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests).toEqual([{ cursor: 42 }, { cursor: 42 }]);
      await expect(outcome).resolves.toEqual({ value: { cursor: 81 } });
    } finally {
      controller.abort();
      await outcome;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    socket.connected = false;
    socketListeners.clear();
    socketHandlers.clear();
    pendingAcks.clear();
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          id: 'machine-session',
          dataEncryptionKey: undefined,
        },
      },
    });
  });

  it('keeps exact Machine projection requests on the captured Home', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    socket.emit.mockImplementation((_event, _payload, ack) => ack({ ok: true, result: { generation: 1 } }));
    await expect(callExactMachineRpc({ credentials: { token: 'account-token', encryption: null }, machineId: 'machine-session',
      serverUrl: 'https://captured.example.test', method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId: 'machine-session' },
    })).resolves.toEqual({ generation: 1 });
    expect(axiosGet).toHaveBeenCalledWith('https://captured.example.test/v1/machines/machine-session', expect.any(Object));
    expect(io).toHaveBeenCalledWith('https://captured.example.test', expect.objectContaining({
      auth: expect.objectContaining({ token: 'account-token', clientType: 'user-scoped' }),
    }));
  });

  it('keeps passive change reads on the exact Machine socket and advances the accepted snapshot', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const accepted: number[] = [];
    let after = 0;
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.method).toBe('machine-session:execution.run.wait');
      ack({ ok: true, result: { revision: payload.params.after + 1 } });
    });
    const result = await callExactMachineRpc({ credentials: { token: 'account-token', encryption: null },
      machineId: 'machine-session', method: 'execution.run.wait', request: { after }, timeoutMs: null,
      reattachOnReconnect: { readRequest: () => ({ after }), onResult: async (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('revision' in raw) || typeof raw.revision !== 'number') throw new Error('invalid snapshot');
        after = raw.revision; accepted.push(after); return after === 2;
      } },
    });
    expect(result).toEqual({ revision: 2 });
    expect(accepted).toEqual([1, 2]);
  });

  it.each([
    'session.board.item.upsert',
    'session.follow.sources.set',
  ] as const)('carries a fresh exact-request Machine signature for external %s socket RPC', async (effectActionId) => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-one' };
    const authorization = {
      v: 1 as const,
      token: 'home-invocation-proof',
      binding: {
        serverIdentityId: 'home-one', accountId: 'account-one', principalId: 'account-one',
        credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine-caller',
        grant: API_TOKEN_FULL_GRANT_V1,
        actionId: effectActionId, requestId: 'outer-request',
        requestEnvelopeDigest: 'A'.repeat(43), target,
      },
    };
    axiosGet.mockResolvedValue({ data: { machine: { id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.requestId).toEqual(expect.any(String));
      expect(payload.externalActionExecution).toMatchObject({
        authorization,
        effectActionId,
        target,
        installationId: 'installation-one',
      });
      expect(verifyExternalActionMachineRpcRequestV1({
        authorizationToken: authorization.token,
        effectActionId,
        target,
        installationId: 'installation-one',
        event: SOCKET_RPC_EVENTS.CALL,
        method: payload.method,
        requestId: payload.requestId,
        params: payload.params,
        publicKey: keyPair.publicKey,
        signature: payload.externalActionExecution.machineSignature,
      })).toBe(true);
      ack({ ok: true, result: { generation: 1 } });
    });
    await expect(callExactMachineRpc({
      credentials: { token: 'daemon-token', encryption: null },
      machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId: 'machine-session' },
      externalAction: {
        context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
        effectActionId,
        installationId: 'installation-one',
        privateKey: keyPair.secretKey,
      },
    })).resolves.toEqual({ generation: 1 });
    const machineLookup = axiosGet.mock.calls.at(-1);
    expect(machineLookup?.[1]?.headers?.Authorization).toBeUndefined();
    expect(machineLookup?.[1]?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    expect(verifyExternalActionMachineRequestV1({
      authorizationToken: authorization.token,
      effectActionId,
      target,
      installationId: 'installation-one',
      requestId: authorization.binding.requestId,
      method: 'GET',
      path: '/v1/machines/machine-session',
      publicKey: keyPair.publicKey,
      signature: machineLookup?.[1]?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
    })).toBe(true);
  });

  it('encrypts and sends one account-scoped call to only the requested machine', async () => {
    const credentials = accountDataKeyCredentials(3);
    const machineKey = credentials.encryption.machineKey;
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          id: 'machine-session',
          dataEncryptionKey: publishedMachineDataEncryptionKey({
            contentKey: machineKey,
            recipientPublicKey: credentials.encryption.publicKey,
          }),
        },
      },
    });
    socket.emit.mockImplementation(async (_event, payload, callback) => {
      expect(payload.method).toBe('machine-session:spawn-happy-session');
      expect(payload.authorization).toEqual({
        kind: 'session.write',
        sessionId: 'session-1',
      });
      expect(payload.requestId).toEqual(expect.any(String));
      expect(await openedWith(machineKey, payload.params, payload.method)).toEqual({ sessionId: 'session-1' });
      callback({
        ok: true,
        result: await responseForRequest(machineKey, payload, { type: 'success', sessionId: 'session-1' }),
      });
    });

    await expect(callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: { sessionId: 'session-1' },
      authorization: {
        kind: 'session.write',
        sessionId: 'session-1',
      },
      timeoutMs: 100,
    })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('round-trips a bounded terminal base64 frame byte-exactly through the encrypted JSON socket envelope', async () => {
    const credentials = accountDataKeyCredentials(7);
    const machineKey = credentials.encryption.machineKey;
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          id: 'machine-session',
          dataEncryptionKey: publishedMachineDataEncryptionKey({
            contentKey: machineKey,
            recipientPublicKey: credentials.encryption.publicKey,
          }),
        },
      },
    });
    const bytes = new Uint8Array(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }
    bytes.set([0x00, 0xc0, 0x80, 0x81, 0x9f, 0xff], 0);
    bytes.set([0xff, 0x9f, 0x81, 0x80, 0xc0, 0x00], bytes.length - 6);

    const request = TerminalStreamReadRequestSchema.parse({
      terminalId: 'term-byte-exact',
      byteOffset: 0,
      maxBytes: TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
      maxFrames: 1,
    });
    const response = TerminalStreamReadResponseSchema.parse({
      ok: true,
      terminalId: request.terminalId,
      frames: [{
        t: 'bytes',
        terminalId: request.terminalId,
        seq: 0,
        byteOffset: 0,
        byteLength: bytes.byteLength,
        encoding: 'base64',
        data: encodeTerminalStreamBytes(bytes),
      }],
      nextByteOffset: bytes.byteLength,
      availableByteOffset: bytes.byteLength,
      droppedBeforeByteOffset: 0,
      done: false,
    });

    socket.emit.mockImplementation(async (_event, payload, callback) => {
      const socketPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      expect(socketPayload.method).toBe(`machine-session:${RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES}`);
      expect(typeof socketPayload.params).toBe('string');
      if (typeof socketPayload.params !== 'string') {
        throw new Error('expected encrypted machine RPC params');
      }
      expect(TerminalStreamReadRequestSchema.parse(
        await openedWith(machineKey, socketPayload.params, String(socketPayload.method)),
      )).toEqual(request);

      callback(JSON.parse(JSON.stringify({
        ok: true,
        result: await responseForRequest(machineKey, payload, response),
      })));
    });

    const result = TerminalStreamReadResponseSchema.parse(await callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      request,
      timeoutMs: 100,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected terminal byte stream response');
    const frame = result.frames[0];
    expect(frame?.t).toBe('bytes');
    if (!frame || frame.t !== 'bytes') throw new Error('expected terminal bytes frame');
    expect(frame.data).toHaveLength(TERMINAL_STREAM_MAX_ENCODED_BYTES);
    expect(decodeTerminalStreamBytesFrame(frame)).toEqual(bytes);
  });

  /**
   * The published envelope names the Machine's own content key. An ordinary
   * Machine seals the Account-wide machine key into it, so both readings agree
   * there — a Machine published with its own scoped key is where deriving the
   * Account key instead would encrypt for the wrong reader.
   */
  describe('published machine content key', () => {
    it('opens the published envelope and uses that scoped key, not account-wide material', async () => {
      const credentials = accountDataKeyCredentials(11);
      const machineKey = credentials.encryption.machineKey;
      const scopedMachineKey = new Uint8Array(32).fill(29);
      axiosGet.mockResolvedValue({
        data: {
          machine: {
            id: 'machine-scoped',
            dataEncryptionKey: publishedMachineDataEncryptionKey({
              contentKey: scopedMachineKey,
              recipientPublicKey: credentials.encryption.publicKey,
            }),
          },
        },
      });
      const receiver = new RpcHandlerManager({
        scopePrefix: 'machine-scoped',
        encryptionMode: 'e2ee',
        encryptionKey: scopedMachineKey,
        encryptionVariant: 'dataKey',
        logger: () => {},
      });
      receiver.registerHandler('prepare-source-key', async (request) => {
        expect(request).toEqual({ sourceKey: 'source-dek' });
        return { ok: true };
      });
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        expect(await openedWith(scopedMachineKey, payload.params, payload.method)).toEqual({ sourceKey: 'source-dek' });
        // The Account-wide machine key must not open what the scoped key sealed.
        expect(await openedWith(machineKey, payload.params, payload.method)).toBeNull();
        callback({
          ok: true,
          result: await receiver.handleRequest(payload),
        });
      });

      await expect(callExactMachineRpc({
        credentials,
        machineId: 'machine-scoped',
        expectedEncryptionMode: 'e2ee',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      })).resolves.toEqual({ ok: true });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('rejects a substituted plain marker before emitting an explicitly encrypted exact call', async () => {
      axiosGet.mockResolvedValue({ data: { machine: {
        id: 'machine-scoped',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } });
      socket.emit.mockImplementation((_event, _payload, callback) => callback({ ok: true, result: { ok: true } }));
      const error = await callExactMachineRpc({
        credentials: accountDataKeyCredentials(11), machineId: 'machine-scoped',
        expectedEncryptionMode: 'e2ee', method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' }, timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'revoked', currentness: { revokedAt: 1234 } },
      { name: 'replaced', currentness: { replacedByMachineId: 'runner-successor' } },
    ])('rejects a $name exact target before encrypting private material', async ({ currentness }) => {
      axiosGet.mockResolvedValue({ data: { machine: {
        id: 'runner-stale',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
        ...currentness,
      } } });

      const error = await callExactMachineRpc({
        credentials: { token: 'plain-token', encryption: null },
        machineId: 'runner-stale',
        requireCurrentMachine: true,
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({ code: 'machine_target_not_current' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('rejects a substituted exact Machine projection before private RPC emission', async () => {
      axiosGet.mockResolvedValue({ data: { machine: {
        id: 'runner-substituted',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } });

      const error = await callExactMachineRpc({
        credentials: { token: 'plain-token', encryption: null },
        machineId: 'runner-expected',
        requireCurrentMachine: true,
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({
        message: expect.stringContaining('runner-expected was not returned'),
      });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('rejects a persistent Machine before emitting a Runner-only private RPC', async () => {
      axiosGet.mockResolvedValue({ data: { machine: {
        id: 'machine-persistent',
        kind: 'persistent',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } });

      const error = await callExactMachineRpc({
        credentials: { token: 'plain-token', encryption: null },
        machineId: 'machine-persistent',
        requiredMachineKind: 'ephemeral_session_runner',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({ code: 'machine_kind_mismatch' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('requires the creator-signed exact Runner Machine tuple before emitting private RPC', async () => {
      const credentials = legacyCredentials(31);
      const scopedMachineKey = new Uint8Array(32).fill(37);
      const signing = tweetnacl.sign.keyPair.fromSeed(credentials.encryption.secret);
      const bindingPayload = {
        v: 1 as const,
        purpose: 'happier.ephemeral-runner.machine-content-key' as const,
        homeServerIdentityId: 'home-one',
        activationId: '11111111-1111-4111-8111-111111111111',
        creatorAccountId: 'account-one',
        machineId: 'runner-one',
        installationId: 'runner-installation',
        machineContentKeyFingerprint:
          computeRunnerMachineContentKeyFingerprintV1(scopedMachineKey),
      };
      const binding = {
        ...signRunnerMachineContentKeyBindingV1({
          payload: bindingPayload,
          activationSigningSecretKey: signing.secretKey,
        }),
        // The daemon holds no creator device custody, so the verifier identity
        // comes from the creator-sealed Account-scoped fact.
        creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
          payload: {
            v: 1,
            activationId: bindingPayload.activationId,
            machineId: bindingPayload.machineId,
            activationSigningPublicKey: encodeProtocolBase64(signing.publicKey, 'base64url'),
          },
          material: { type: 'legacy', secret: credentials.encryption.secret },
          randomBytes: (length: number) => new Uint8Array(length).fill(3),
        }),
      };
      const machine = {
        id: 'runner-one',
        kind: 'ephemeral_session_runner',
        installationId: 'runner-installation',
        dataEncryptionKey: publishedMachineDataEncryptionKey({
          contentKey: scopedMachineKey,
          recipientPublicKey: deriveBoxPublicKeyFromSeed(
            deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret),
          ),
        }),
        runnerContentKeyBinding: binding,
      };
      axiosGet.mockResolvedValue({ data: { machine } });
      socket.emit.mockImplementation(async (_event, payload, callback) =>
        callback({
          ok: true,
          result: await responseForRequest(scopedMachineKey, payload, { installed: true }),
        }));

      await expect(callExactMachineRpc({
        credentials,
        machineId: 'runner-one',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        expectedEncryptionMode: 'e2ee',
        expectedRunnerMachineContentKeyBinding: {
          homeServerIdentityId: bindingPayload.homeServerIdentityId,
          creatorAccountId: bindingPayload.creatorAccountId,
          machineId: bindingPayload.machineId,
        },
        timeoutMs: 100,
      })).resolves.toEqual({ installed: true });
      expect(socket.emit).toHaveBeenCalledOnce();

      vi.clearAllMocks();
      axiosGet.mockResolvedValue({
        data: { machine: { ...machine, installationId: 'substituted-installation' } },
      });
      const error = await callExactMachineRpc({
        credentials,
        machineId: 'runner-one',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        expectedEncryptionMode: 'e2ee',
        expectedRunnerMachineContentKeyBinding: {
          homeServerIdentityId: bindingPayload.homeServerIdentityId,
          creatorAccountId: bindingPayload.creatorAccountId,
          machineId: bindingPayload.machineId,
        },
        timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('does not accept a Home-supplied Runner signer for DataKey credentials', async () => {
      const credentials = accountDataKeyCredentials(31);
      const scopedMachineKey = new Uint8Array(32).fill(37);
      const untrustedSigning = tweetnacl.sign.keyPair();
      const bindingPayload = {
        v: 1 as const,
        purpose: 'happier.ephemeral-runner.machine-content-key' as const,
        homeServerIdentityId: 'home-one',
        activationId: '11111111-1111-4111-8111-111111111111',
        creatorAccountId: 'account-one',
        machineId: 'runner-one',
        installationId: 'runner-installation',
        machineContentKeyFingerprint:
          computeRunnerMachineContentKeyFingerprintV1(scopedMachineKey),
      };
      axiosGet.mockResolvedValue({ data: { machine: {
        id: bindingPayload.machineId,
        kind: 'ephemeral_session_runner',
        installationId: bindingPayload.installationId,
        dataEncryptionKey: publishedMachineDataEncryptionKey({
          contentKey: scopedMachineKey,
          recipientPublicKey: credentials.encryption.publicKey,
        }),
        runnerContentKeyBinding: signRunnerMachineContentKeyBindingV1({
          payload: bindingPayload,
          activationSigningSecretKey: untrustedSigning.secretKey,
        }),
      } } });

      const error = await callExactMachineRpc({
        credentials,
        machineId: bindingPayload.machineId,
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        expectedEncryptionMode: 'e2ee',
        expectedRunnerMachineContentKeyBinding: {
          homeServerIdentityId: bindingPayload.homeServerIdentityId,
          creatorAccountId: bindingPayload.creatorAccountId,
          machineId: bindingPayload.machineId,
        },
        timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('fails closed when a present envelope cannot be opened with account material', async () => {
      const credentials = accountDataKeyCredentials(11);
      const unrelatedAccount = accountDataKeyCredentials(23);
      axiosGet.mockResolvedValue({
        data: {
          machine: {
            id: 'machine-foreign',
            dataEncryptionKey: publishedMachineDataEncryptionKey({
              contentKey: new Uint8Array(32).fill(29),
              recipientPublicKey: unrelatedAccount.encryption.publicKey,
            }),
          },
        },
      });

      const error = await callMachineRpc({
        credentials,
        machineId: 'machine-foreign',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(String((error as Error).message)).toContain('machine-foreign');
      // An unopenable present envelope is never downgraded to the absent case.
      expect(socket.emit).not.toHaveBeenCalled();
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
    });

    it.each(['', '   ', {}, 42])('rejects malformed-present envelope %j before sending', async (published) => {
      axiosGet.mockResolvedValue({ data: { machine: { id: 'machine-scoped', dataEncryptionKey: published } } });
      const error = await callMachineRpc({
        credentials: accountDataKeyCredentials(11),
        machineId: 'machine-scoped', method: 'status', request: { secret: 'private' }, timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('rejects noncanonical encoding of an otherwise valid scoped envelope before sending', async () => {
      const credentials = accountDataKeyCredentials(11);
      const envelope = publishedMachineDataEncryptionKey({
        contentKey: new Uint8Array(32).fill(29),
        recipientPublicKey: credentials.encryption.publicKey,
      });
      axiosGet.mockResolvedValue({ data: { machine: { id: 'machine-scoped', dataEncryptionKey: `!${envelope}` } } });
      const error = await callExactMachineRpc({
        credentials,
        machineId: 'machine-scoped', method: 'status', request: { secret: 'private' }, timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('opens a selected scoped envelope with recovery-secret credentials through the real receiver', async () => {
      const secret = new Uint8Array(32).fill(19);
      const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
      const scopedMachineKey = new Uint8Array(32).fill(29);
      axiosGet.mockResolvedValue({ data: { machine: {
        id: 'machine-scoped',
        dataEncryptionKey: publishedMachineDataEncryptionKey({
          contentKey: scopedMachineKey,
          recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        }),
      } } });
      const receiver = new RpcHandlerManager({
        scopePrefix: 'machine-scoped', encryptionMode: 'e2ee',
        encryptionKey: scopedMachineKey, encryptionVariant: 'dataKey', logger: () => {},
      });
      receiver.registerHandler('status', async (request) => ({ received: request }));
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        callback({ ok: true, result: await receiver.handleRequest(payload) });
      });
      await expect(callMachineRpc({
        credentials: { token: 'account-token', encryption: { type: 'legacy', secret } },
        machineId: 'machine-scoped', method: 'status', request: { ping: true }, timeoutMs: 100,
      })).resolves.toEqual({ received: { ping: true } });
    });

    it('keeps released account-key behavior for a machine that published no envelope', async () => {
      const credentials = accountDataKeyCredentials(5);
      const machineKey = credentials.encryption.machineKey;
      axiosGet.mockResolvedValue({
        data: { machine: { id: 'machine-historical' } },
      });
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        expect(await openedWith(machineKey, payload.params, payload.method)).toEqual({ ping: true });
        callback({
          ok: true,
          result: await responseForRequest(machineKey, payload, { status: 'running' }),
        });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-historical',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });
    });

    it('keeps released legacy-secret behavior', async () => {
      const secret = new Uint8Array(32).fill(9);
      const credentials = {
        token: 'account-token',
        encryption: { type: 'legacy' as const, secret },
      };
      axiosGet.mockResolvedValue({
        data: { machine: { id: 'machine-legacy' } },
      });
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        expect(await openedWith(secret, payload.params, payload.method, 'legacy'))
          .toEqual({ ping: true });
        callback({
          ok: true,
          result: await responseForRequest(secret, payload, { status: 'running' }, 'legacy'),
        });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-legacy',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });
    });
  });

  it('sends plaintext RPC for a marker-backed machine with token-only credentials', async () => {
    const semanticallyEquivalentPlainMarker = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }, null, 2)),
      'base64',
    );
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          id: 'machine-plain',
          dataEncryptionKey: semanticallyEquivalentPlainMarker,
        },
      },
    });
    socket.emit.mockImplementation((_event, payload, callback) => {
      expect(payload.method).toBe('machine-plain:status');
      expect(payload.params).toEqual({ ping: true });
      callback({
        ok: true,
        result: { status: 'running' },
      });
    });

    await expect(callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'status',
      request: { ping: true },
      timeoutMs: 100,
    })).resolves.toEqual({ status: 'running' });

    expect(String(axiosGet.mock.calls[0]?.[0])).toMatch(
      /\/v1\/machines\/machine-plain$/,
    );
    expect(axiosGet.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer plain-token',
      }),
    }));
    // A reached machine never pays for the replacement chain: the only server
    // read is the per-machine codec lookup this call already needed.
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('distinguishes failures before RPC emission from ambiguous failures after emission', async () => {
    axiosGet.mockRejectedValueOnce(new Error('machine lookup failed'));
    const credentials = { token: 'plain-token', encryption: null };

    const beforeEmission = await callMachineRpc({
      credentials,
      machineId: 'machine-plain',
      method: 'status',
      request: { ping: true },
      timeoutMs: 10,
    }).catch((error) => error);
    expect(readMachineRpcRequestDisposition(beforeEmission)).toBe('notSent');

    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    socket.emit.mockImplementationOnce(() => undefined);
    const afterEmission = await callMachineRpc({
      credentials,
      machineId: 'machine-plain',
      method: 'status',
      request: { ping: true },
      timeoutMs: 10,
    }).catch((error) => error);
    expect(readMachineRpcRequestDisposition(afterEmission)).toBe('outcomeUnknown');
  });

  it('keeps caller-lifecycle machine RPC acknowledgement open until cancellation', async () => {
    vi.useFakeTimers();
    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    socket.emit.mockImplementationOnce(() => undefined);
    const abort = new AbortController();
    const promise = callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      signal: abort.signal,
    });
    const errorPromise = promise.catch((error) => error);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    const callPayload = socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CALL)?.[1];
    expect(callPayload).not.toHaveProperty('timeoutMs');

    abort.abort();
    const error = await errorPromise;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('settles an emitted machine RPC when its socket disconnects before acknowledgement', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    let resolveEmitted = () => {};
    const emitted = new Promise<void>((resolve) => {
      resolveEmitted = resolve;
    });
    socket.emit.mockImplementationOnce(() => {
      resolveEmitted();
      return undefined;
    });
    const promise = callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
    });

    await emitted;
    socketHandlers.get('disconnect')?.();
    const error = await promise.catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Machine RPC socket disconnected before acknowledgement' });
    expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('settles a connect-then-disconnect race before emission even with no acknowledgement timeout', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    let resolveConnected = () => {};
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    socket.connect.mockImplementationOnce(() => {
      socketHandlers.get('connect')?.();
      socketHandlers.get('disconnect')?.();
      resolveConnected();
    });
    const observationFallback = new AbortController();
    const promise = callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      signal: observationFallback.signal,
    });

    await connected;
    observationFallback.abort(new Error('test observation fallback'));
    const error = await promise.catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Machine RPC socket disconnected before acknowledgement' });
    expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  /**
   * A user who replaces a machine keeps the Sessions the previous one hosted.
   * Nothing re-homes those rows, so a CLI/MCP send or resume still addresses the
   * PREDECESSOR; reaching the successor is what makes the replacement usable.
   */
  describe('replaced machine', () => {
    const PLAIN_MARKER = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
      'base64',
    );

    function mockServerReads(machines: ReadonlyArray<Record<string, unknown>>): void {
      axiosGet.mockImplementation(async (url: unknown) => {
        const href = String(url);
        if (/\/v1\/machines$/.test(href)) return { data: machines };
        const machineId = href.slice(href.lastIndexOf('/') + 1);
        return { data: { machine: { id: machineId, dataEncryptionKey: PLAIN_MARKER } } };
      });
    }

    function unreachable() {
      return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    const credentials = { token: 'plain-token', encryption: null };

    it('reaches the successor when the addressed machine was replaced', async () => {
      mockServerReads([
        { id: 'machine-old', replacedByMachineId: 'machine-mid' },
        { id: 'machine-mid', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, payload, callback) => {
        if (payload.method !== 'machine-new:status') {
          callback(unreachable());
          return;
        }
        callback({ ok: true, result: { status: 'running' } });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });

      // Exactly one retry, addressed to the end of the replacement chain, and
      // encoded with the SUCCESSOR's own codec rather than the predecessor's.
      expect(socket.emit).toHaveBeenCalledTimes(2);
      expect(socket.emit.mock.calls[0]?.[1]?.method).toBe('machine-old:status');
      expect(socket.emit.mock.calls[1]?.[1]?.method).toBe('machine-new:status');
      expect(axiosGet.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringMatching(/\/v1\/machines\/machine-old$/),
        expect.stringMatching(/\/v1\/machines$/),
        expect.stringMatching(/\/v1\/machines\/machine-new$/),
      ]);
    });

    /**
     * Delivering source key material is addressed to ONE verified machine. A
     * replacement is a different machine with different authority, so silently
     * re-addressing the delivery would hand the material to a target the caller
     * never authorized.
     */
    it('never redirects an exact-machine call to a replacement', async () => {
      mockServerReads([
        { id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      await expect(callExactMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });

      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit.mock.calls[0]?.[1]?.method).toBe('machine-old:status');
      // The replacement chain is never even read for an exact-machine call.
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original error unchanged when the machine has no successor', async () => {
      mockServerReads([{ id: 'machine-old', replacedByMachineId: null }]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      const error = await callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original error when the replacement chain cannot be read', async () => {
      axiosGet.mockImplementation(async (url: unknown) => {
        const href = String(url);
        if (/\/v1\/machines$/.test(href)) throw new Error('chain lookup failed');
        return { data: { machine: { id: 'machine-old', dataEncryptionKey: PLAIN_MARKER } } };
      });
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('never re-addresses an error the machine itself answered with', async () => {
      mockServerReads([
        { id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback({
        ok: false,
        error: 'Session is already running',
      }));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toThrow('Session is already running');

      // A successor EXISTS and is still not used: re-running an application
      // error against another machine would be a correctness bug.
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('never re-addresses a call whose outcome is unknown', async () => {
      mockServerReads([
        { id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation(() => undefined);

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 10,
      })).rejects.toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });

      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });
  });
});
