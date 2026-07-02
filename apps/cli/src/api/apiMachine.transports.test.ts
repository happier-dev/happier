import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { logger } from '@/ui/logger';
import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { Machine } from './types';

const { configurationMock, mockAxiosIsAxiosError, mockAxiosPost, mockIo } = vi.hoisted(() => ({
  configurationMock: {
    apiServerUrl: 'http://localhost:3005',
    activeServerDir: '',
    socketIoTransports: ['polling', 'websocket'] as string[],
  },
  mockAxiosIsAxiosError: vi.fn((error: unknown) => (
    typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true
  )),
  mockAxiosPost: vi.fn(),
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => any>(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    io: { on: vi.fn() },
  })),
}));

const registerFileSystemHandlersMock = vi.hoisted(() => vi.fn(() => ({
  transferSessionStore: {},
})));
const registerMachineRpcHandlersMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('axios', () => ({
  default: {
    isAxiosError: mockAxiosIsAxiosError,
    post: mockAxiosPost,
  },
  isAxiosError: mockAxiosIsAxiosError,
}));

vi.mock('@/configuration', () => ({
  configuration: configurationMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/scm', () => ({ registerScmHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/fileSystem', () => ({ registerFileSystemHandlers: registerFileSystemHandlersMock }));
vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({ registerMachineFileBrowserHandlers: vi.fn() }));
vi.mock('./machine/rpcHandlers', () => ({ registerMachineRpcHandlers: registerMachineRpcHandlersMock }));
vi.mock('./rpc/RpcHandlerManager', () => ({
  RpcHandlerManager: class {
    registerHandler() {}
    onSocketConnect() {}
    onSocketDisconnect() {}
    async handleRequest() {
      return { ok: true };
    }
    async invokeLocal() {
      return { ok: true };
    }
  },
}));
vi.mock('./changes', () => ({ fetchChanges: vi.fn() }));
vi.mock('@/persistence', () => ({ readLastChangesCursor: vi.fn(), writeLastChangesCursor: vi.fn() }));
vi.mock('./client/loopbackUrl', () => ({ resolveLoopbackHttpUrl: (value: string) => value }));
vi.mock('@/utils/proxy/socketIoProxy', () => ({ getSocketIoProxyOptions: () => ({}) }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(fn: () => Promise<T>) => await fn() }));

describe('ApiMachineClient transports', () => {
  beforeEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    mockAxiosPost.mockResolvedValue({ status: 200, data: { success: true, applied: true } });
    registerFileSystemHandlersMock.mockReset();
    registerFileSystemHandlersMock.mockReturnValue({ transferSessionStore: {} });
    registerMachineRpcHandlersMock.mockReset();
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
  });

  afterEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.activeServerDir = '';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    vi.mocked(logger.warn).mockReset();
    mockAxiosPost.mockReset();
  });

  it('uses polling-first transports by default (upgrade to websocket when available)', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates/');
    expect(opts.transports).toEqual(['polling', 'websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('can force websocket-only via config flag', async () => {
    configurationMock.socketIoTransports = ['websocket'];

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates/');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('confirms session-end over HTTP even when the machine socket is absent', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.emitSessionEnd({ sid: 'session-1', time: 1234 });

    await vi.waitFor(() => {
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3005/v1/sessions/session-1/end',
        { time: 1234 },
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer fake-token',
          }),
        }),
      );
    });
  });

  it('keeps startup cleanup session-end queued when HTTP delivery fails', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-session-end-'));
    configurationMock.activeServerDir = tempServerDir;
    mockAxiosPost.mockRejectedValue(new Error('server offline'));
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);

    try {
      const durableClient: {
        enqueueSessionEndMutation?: (payload: { sid: string; time: number; exit?: unknown }) => void;
      } = client;

      expect(durableClient.enqueueSessionEndMutation).toBeTypeOf('function');
      durableClient.enqueueSessionEndMutation?.({
        sid: 'session-1',
        time: 1234,
        exit: { observedBy: 'daemon', reason: 'process-missing' },
      });

      await vi.waitFor(async () => {
        const parsed = JSON.parse(
          await readFile(join(tempServerDir, 'session-mutations', 'session-session-1.json'), 'utf8'),
        ) as { mutations?: Array<{ kind?: string; payload?: { sessionId?: string; observedAt?: number } }> };
        expect(parsed.mutations).toEqual([
          expect.objectContaining({
            kind: 'session_end',
            payload: expect.objectContaining({
              sessionId: 'session-1',
              observedAt: 1234,
            }),
          }),
        ]);
      });
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('keeps daemon turn settlement queued durably when delivery fails', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-turn-settlement-'));
    configurationMock.activeServerDir = tempServerDir;
    mockAxiosPost.mockRejectedValue(new Error('server offline'));
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);

    try {
      const durableClient: {
        enqueueSessionTurnSettlementMutation?: (payload: { sid: string; time: number }) => void;
      } = client;

      expect(durableClient.enqueueSessionTurnSettlementMutation).toBeTypeOf('function');
      durableClient.enqueueSessionTurnSettlementMutation?.({
        sid: 'session-1',
        time: 1234,
      });

      await vi.waitFor(async () => {
        const parsed = JSON.parse(
          await readFile(join(tempServerDir, 'session-mutations', 'session-session-1.json'), 'utf8'),
        ) as { mutations?: Array<{ kind?: string; payload?: { sessionId?: string; action?: string; mutationId?: string; observedAt?: number } }> };
        expect(parsed.mutations).toEqual([
          expect.objectContaining({
            kind: 'session_turn_mutation',
            payload: expect.objectContaining({
              sessionId: 'session-1',
              action: 'end_session',
              mutationId: 'daemon-exit-turn-settlement:session-1:1234',
              observedAt: 1234,
            }),
          }),
        ]);
      });
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('redacts authorization headers when session-end HTTP confirmation fails', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    mockAxiosPost.mockRejectedValueOnce({
      isAxiosError: true,
      name: 'AxiosError',
      message: 'socket hang up',
      code: 'ECONNRESET',
      config: {
        method: 'post',
        url: 'http://localhost:3005/v1/sessions/session-1/end?token=secret',
        headers: { Authorization: 'Bearer fake-token' },
        data: { time: 1234 },
      },
    });

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.emitSessionEnd({ sid: 'session-1', time: 1234 });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalled();
    });

    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('fake-token');
    expect(logged).not.toContain('Authorization');
    expect(logged).not.toContain('token=secret');
  });

  it('does not warn when connected legacy session-end delivery reaches a server without the durable route', async () => {
    const machineSocket = createApiSessionSocketStub({ connected: true });
    bindApiSessionSocketMock(mockIo, machineSocket);
    mockAxiosPost.mockResolvedValueOnce({ status: 404, data: { error: 'not found' } });

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();
    client.emitSessionEnd({ sid: 'session-1', time: 1234 });

    await vi.waitFor(() => {
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3005/v1/sessions/session-1/end',
        { time: 1234 },
        expect.any(Object),
      );
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('session-end', { sid: 'session-1', time: 1234 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('includes takeover auth when explicitly requested', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect({ takeover: true });

    const opts = mockIo.mock.calls.at(-1)?.[1] as any;
    expect(opts.auth.takeover).toBe(true);
  });

  it('emits and receives machine transfer envelopes over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    const received: unknown[] = [];
    client.onMachineTransferEnvelope((payload) => {
      received.push(payload);
    });
    client.connect();

    client.sendMachineTransferEnvelope({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(machineSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    machineSocket.trigger(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'test-machine',
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 2,
      },
    });

    expect(received).toEqual([
      {
        sourceMachineId: 'machine-source',
        targetMachineId: 'test-machine',
        envelope: {
          transferId: 'transfer_1',
          kind: 'ack',
          nextSequence: 2,
        },
      },
    ]);
  });

  it('emits and receives relay v2 envelopes over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const { TRANSFER_RELAY_V2_SOCKET_EVENT } = await import('@happier-dev/protocol');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    const received: unknown[] = [];
    client.onTransferRelayV2Envelope((payload) => {
      received.push(payload);
    });
    client.connect();

    client.sendTransferRelayV2Envelope({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'test-machine',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 2,
      },
    });

    expect(machineSocket.emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, {
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'test-machine',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 2,
      },
    });

    machineSocket.trigger(TRANSFER_RELAY_V2_SOCKET_EVENT, {
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
        socketId: 'socket-source',
      },
      recipient: {
        kind: 'machine',
        machineId: 'test-machine',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        recipientPublicKeyBase64: 'YQ==',
      },
    });

    expect(received).toEqual([
      {
        scopeUserId: 'user-1',
        sender: {
          kind: 'user',
          socketId: 'socket-source',
        },
        recipient: {
          kind: 'machine',
          machineId: 'test-machine',
        },
        envelope: {
          transferId: 'transfer_1',
          kind: 'open',
          recipientPublicKeyBase64: 'YQ==',
        },
      },
    ]);
  });

  it('emits and receives TCP tunnel relay envelopes over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } = await import('@happier-dev/protocol');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    const received: unknown[] = [];
    client.onPeerTcpTunnelRelayEnvelope((payload) => {
      received.push(payload);
    });
    client.connect();

    const envelope = {
      v: 1,
      scopeUserId: 'user-1',
      sender: { kind: 'machine', machineId: 'test-machine' },
      recipient: { kind: 'user' },
      frame: {
        v: 1,
        kind: 'abort',
        tunnelId: 'tun_1',
        reasonCode: 'relay_authorization_invalid',
      },
    } as const;

    client.sendPeerTcpTunnelRelayEnvelope(envelope);

    expect(machineSocket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);

    machineSocket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
      ...envelope,
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'test-machine' },
    });

    expect(received).toEqual([{
      ...envelope,
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'test-machine' },
    }]);
  });

  it('emits and receives live-stream relay envelopes over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const { MACHINE_LIVE_STREAM_SOCKET_EVENT } = await import('@happier-dev/protocol');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    const received: unknown[] = [];
    client.onMachineLiveStreamRelayEnvelope((payload) => {
      received.push(payload);
    });
    client.connect();

    const envelope = {
      v: 1,
      sourceMachineId: 'test-machine',
      targetMachineId: 'viewer-machine',
      message: {
        kind: 'receipt',
        receipt: {
          v: 1,
          id: 'stream.paused',
          flowKind: 'live_stream',
          routeKind: 'server_relay',
          streamId: 'stream_1',
          reasonCode: 'capture_source_unavailable',
          maxBitrateBps: 64_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 8_192,
          maxDurationMs: 60_000,
        },
      },
    } as const;

    client.sendMachineLiveStreamRelayEnvelope(envelope);

    expect(machineSocket.emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, envelope);

    machineSocket.trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, envelope);

    expect(received).toEqual([envelope]);
  });

  it('emits direct-session transcript delta updates over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    client.emitExternalSessionTranscriptUpdate({
      type: 'direct-session-transcript-delta',
      sessionId: 'session-1',
      items: [
        {
          id: 'a2',
          createdAtMs: 1_050,
          localId: 'direct-2',
          raw: {
            type: 'assistant',
            uuid: 'a2',
            message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] },
          },
        },
      ],
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('direct-session-transcript-delta', expect.objectContaining({
      sessionId: 'session-1',
      truncated: false,
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'a2' }),
      ]),
    }));
  });

  it('forwards voice inference workers into machine RPC registration', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const voiceInference: VoiceInferenceWorkerHandle = {
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(async () => ({
        serviceState: 'ready' as const,
        normalization: {
          inputTransport: 'upload_transfer' as const,
          strategy: 'daemon_decode' as const,
          systemFfmpegAllowed: false as const,
        },
        models: [],
      })),
      listModels: vi.fn(async () => []),
      getModelsStatus: vi.fn(async () => []),
      warmModelPack: vi.fn(async () => {}),
      installModel: vi.fn(async () => ({
        packId: 'stt-pack',
        kind: 'stt_sherpa' as const,
        model: 'sherpa',
        version: '1',
        executionSupport: ['daemon' as const],
        installState: 'installed' as const,
        progress: null,
        lastError: null,
        updatedAtMs: 0,
      })),
      removeModel: vi.fn(async () => {}),
      synthesizeTts: vi.fn(async () => ({
        requestId: 'tts-1',
        output: { codec: 'wav', mimeType: 'audio/wav' } as const,
        filePath: '/tmp/fake.wav',
        sizeBytes: 4,
        name: 'fake.wav',
      })),
      cancelTts: vi.fn(async () => {}),
      transcribeAudio: vi.fn(async () => ({
        requestId: 'stt-1',
        text: 'hello',
        language: 'en',
        modelPackId: 'stt-pack',
      })),
      cancelStt: vi.fn(async () => {}),
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
      voiceInference,
    });

    expect(registerMachineRpcHandlersMock).toHaveBeenCalledWith(expect.objectContaining({
      handlers: expect.objectContaining({
        voiceInference,
      }),
    }));
  });

});
