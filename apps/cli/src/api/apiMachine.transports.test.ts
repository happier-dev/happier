import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext, type DirectSessionTranscriptDeltaEphemeral } from '@happier-dev/protocol';

import {
  bindApiSessionSocketMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { logger } from '@/ui/logger';
import type { Machine } from './types';

const { configurationMock, mockAxiosGet, mockAxiosIsAxiosError, mockAxiosPost, mockIo, rpcHandlerConfigs } = vi.hoisted(() => ({
  configurationMock: {
    apiServerUrl: 'http://localhost:3005',
    activeServerDir: '',
    socketIoTransports: ['polling', 'websocket'] as string[],
  },
  mockAxiosIsAxiosError: vi.fn((error: unknown) => (
    typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true
  )),
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => any>(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    io: { on: vi.fn() },
  })),
  rpcHandlerConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('axios', () => ({
  default: {
    isAxiosError: mockAxiosIsAxiosError,
    get: mockAxiosGet,
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
vi.mock('@/rpc/handlers/fileSystem', () => ({ registerFileSystemHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({ registerMachineFileBrowserHandlers: vi.fn() }));
vi.mock('./machine/rpcHandlers', () => ({ registerMachineRpcHandlers: vi.fn() }));
vi.mock('./rpc/RpcHandlerManager', () => ({
  RpcHandlerManager: class {
    constructor(config: Record<string, unknown>) {
      rpcHandlerConfigs.push(config);
    }
    registerHandler() {}
    hasHandler() { return true; }
    async waitForRegisteredHandlers() { return { status: 'ready' as const }; }
    onSocketConnect() {}
    onSocketDisconnect() {}
    async handleRequest() {
      return { ok: true };
    }
    async invokeLocal() {
      return { ok: true };
    }
    async waitForIdle() {}
  },
}));
vi.mock('./changes', () => ({ fetchChanges: vi.fn() }));
vi.mock('@/persistence', () => ({ readAccountChangesCursor: vi.fn(), writeAccountChangesCursor: vi.fn() }));
vi.mock('./client/loopbackUrl', () => ({ resolveLoopbackHttpUrl: (value: string) => value }));
vi.mock('@/utils/proxy/socketIoProxy', () => ({ getSocketIoProxyOptions: () => ({}) }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(fn: () => Promise<T>) => await fn() }));

describe('ApiMachineClient transports', () => {
  beforeEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    mockAxiosPost.mockResolvedValue({ status: 200, data: { success: true, applied: true } });
    mockAxiosGet.mockResolvedValue({ status: 200, data: { machine: null } });
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    rpcHandlerConfigs.length = 0;
  });

  afterEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.activeServerDir = '';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    vi.mocked(logger.warn).mockReset();
    vi.mocked(logger.debug).mockReset();
    mockAxiosGet.mockReset();
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
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['polling', 'websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('configures machine RPC to project only strict completed-stop transport proof', async () => {
    const mod = await import('./apiMachine');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');

    new mod.ApiMachineClient('fake-token', {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    const projector = rpcHandlerConfigs.at(-1)?.projectTransportAcknowledgement;
    expect(projector).toBeTypeOf('function');
    expect((projector as (input: { method: string; result: unknown }) => unknown)({
      method: `test-machine:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'stopped' },
    })).toEqual({ kind: 'session.stop', status: 'stopped' });
    expect((projector as (input: { method: string; result: unknown }) => unknown)({
      method: `test-machine:${RPC_METHODS.STOP_SESSION}`,
      result: { status: 'requested' },
    })).toBeNull();
  });

  it('serializes machine refresh errors without dumping axios request details', async () => {
    const mod = await import('./apiMachine');

    mockAxiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      name: 'AxiosError',
      message: 'refresh failed',
      code: 'ECONNABORTED',
      response: { status: 503 },
      config: {
        method: 'get',
        url: 'https://api.example.test/v1/machines/m1?token=SECRET',
        headers: { Authorization: 'Bearer SECRET' },
        data: { secret: 'SECRET_BODY' },
      },
    });

    const client = new mod.ApiMachineClient('fake-token', {
      id: 'm1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    await (client as unknown as { refreshMachineFromServer: () => Promise<void> }).refreshMachineFromServer();

    const calls = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(calls).toContain('[API MACHINE] Failed to refresh machine snapshot');
    expect(calls).toContain('https://api.example.test/v1/machines/m1');
    expect(calls).not.toContain('Authorization');
    expect(calls).not.toContain('Bearer SECRET');
    expect(calls).not.toContain('SECRET_BODY');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
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
    expect(opts.path).toBe('/v1/updates');
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

    expect(client.emitDirectSessionTranscriptUpdate).toEqual(expect.any(Function));

    client.emitDirectSessionTranscriptUpdate({
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
      fromCursor: 'cursor-1',
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

  it('emits operation revisions as opaque account-scoped ciphertext', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);
    const mod = await import('./apiMachine');
    const secret = new Uint8Array(32).fill(7);
    const machine: Machine = {
      id: 'test-machine', encryptionKey: secret, encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();
    const snapshot = {
      version: 1 as const, operationId: 'operation-1', requestId: 'request-1', revision: 1,
      actionId: 'session.spawn_new', state: 'accepted' as const,
      scope: { accountId: 'account-1', machineId: 'test-machine' },
      title: 'Create session', createdAt: 1, cancellation: 'supported' as const,
    };

    client.emitActionOperationRevision(snapshot);

    const emission = machineSocket.emit.mock.calls.find(([event]) => event === 'action-operation-updated');
    expect(emission?.[1]).toEqual({
      type: 'action-operation-updated',
      machineId: 'test-machine',
      content: { t: 'encrypted', c: expect.any(String) },
    });
    const ciphertext = (emission?.[1] as { content: { c: string } }).content.c;
    expect(openAccountScopedBlobCiphertext({
      kind: 'action_operation_snapshot',
      material: { type: 'legacy', secret },
      ciphertext,
    })?.value).toEqual(snapshot);
  });

  it('keeps exact daemon terminal custody queued in the suffixed journal when delivery fails', async () => {
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
      await client.enqueueDaemonTerminalExactTurnEnd({
        v: 1,
        sessionId: 'session-1',
        mutationId: 'daemon-observed-exit:exact-1',
        action: 'end_session',
        turnId: 'turn-1',
        observedAt: 1234,
      });

      await vi.waitFor(async () => {
        const parsed = JSON.parse(
          await readFile(join(tempServerDir, 'session-mutations', 'session-session-1.daemon-terminal.json'), 'utf8'),
        ) as { mutations?: Array<{ kind?: string; payload?: { sessionId?: string; turnId?: string; observedAt?: number } }> };
        expect(parsed.mutations).toEqual([
          expect.objectContaining({
            kind: 'session_turn',
            payload: expect.objectContaining({
              sessionId: 'session-1',
              turnId: 'turn-1',
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

  it('shares a recovered daemon terminal handle with exits observed during startup recovery', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-session-recovery-race-'));
    configurationMock.activeServerDir = tempServerDir;
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
    const seedClient = new mod.ApiMachineClient('fake-token', machine);
    mockAxiosPost.mockRejectedValue(new Error('seed offline'));
    await seedClient.enqueueDaemonTerminalExactTurnEnd({
      v: 1,
      sessionId: 'session-race',
      mutationId: 'daemon-observed-exit:seed',
      action: 'end_session',
      turnId: 'turn-seed',
      observedAt: 100,
    });
    await seedClient.shutdown();

    mockAxiosPost.mockReset();
    let rejectRecovery!: (error: Error) => void;
    let rejectObservedExit!: (error: Error) => void;
    const observedExitOffline = new Promise<never>((_, reject) => { rejectObservedExit = reject; });
    mockAxiosPost
      .mockImplementationOnce(async () => await new Promise((_, reject) => { rejectRecovery = reject; }))
      .mockImplementation(async () => await observedExitOffline);
    const client = new mod.ApiMachineClient('fake-token', machine);

    try {
      const recovery = client.recoverDaemonTerminalSessionMutationJournals();
      await vi.waitFor(() => expect(mockAxiosPost).toHaveBeenCalledTimes(1));
      await client.enqueueDaemonTerminalExactTurnEnd({
        v: 1,
        sessionId: 'session-race',
        mutationId: 'daemon-observed-exit:during-recovery',
        action: 'end_session',
        turnId: 'turn-during-recovery',
        observedAt: 200,
      });
      rejectRecovery(new Error('recovery offline'));
      await recovery;

      const parsed = JSON.parse(
        await readFile(join(tempServerDir, 'session-mutations', 'session-session-race.daemon-terminal.json'), 'utf8'),
      ) as { mutations?: Array<{ mutationId?: string }> };
      expect(parsed.mutations?.map((mutation) => mutation.mutationId).sort()).toEqual([
        'daemon-observed-exit:during-recovery',
        'daemon-observed-exit:seed',
      ]);
    } finally {
      const shutdown = client.shutdown();
      await vi.waitFor(() => expect(mockAxiosPost.mock.calls.length).toBeGreaterThanOrEqual(2));
      rejectObservedExit(new Error('observed exit offline'));
      await shutdown;
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('does not expose daemon full-end or broad no-turn settlement producers', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-single-owner-'));
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
      expect('enqueueSessionEndMutation' in client).toBe(false);
      expect('enqueueSessionTurnSettlementMutation' in client).toBe(false);
      expect(client.enqueueDaemonTerminalExactTurnEnd).toBeTypeOf('function');
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('threads direct-session transcript delta emission into machine RPC dependencies', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const rpcHandlers = await import('./machine/rpcHandlers');
    const registerMachineRpcHandlers = vi.mocked(rpcHandlers.registerMachineRpcHandlers);

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
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const lastCall = registerMachineRpcHandlers.mock.calls.at(-1)?.[0];
    const deps = lastCall?.deps as Partial<{
      emitDirectSessionTranscriptUpdate: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
    }> | undefined;

    expect(deps?.emitDirectSessionTranscriptUpdate).toEqual(expect.any(Function));

    deps?.emitDirectSessionTranscriptUpdate?.({
      type: 'direct-session-transcript-delta',
      sessionId: 'session-1',
      items: [{ id: 'a2', createdAtMs: 1_050, raw: { type: 'assistant' } }],
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('direct-session-transcript-delta', expect.objectContaining({
      sessionId: 'session-1',
      nextCursor: 'cursor-2',
    }));
  });

});
