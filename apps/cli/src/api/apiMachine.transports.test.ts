import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { Machine } from './types';

const { configurationMock, mockIo } = vi.hoisted(() => ({
  configurationMock: {
    apiServerUrl: 'http://localhost:3005',
    socketIoTransports: ['polling', 'websocket'] as string[],
  },
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
    registerFileSystemHandlersMock.mockReset();
    registerFileSystemHandlersMock.mockReturnValue({ transferSessionStore: {} });
    registerMachineRpcHandlersMock.mockReset();
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
  });

  afterEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
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
