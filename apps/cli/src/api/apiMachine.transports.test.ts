import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import {
  bindApiSessionSocketMock,
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { logger } from '@/ui/logger';
import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import { resolveSessionClientDurableMutationJournalPaths } from './session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import { decryptLegacy, decodeBase64 } from './encryption';

const { configurationMock, mockAxiosIsAxiosError, mockAxiosPost, mockIo } = vi.hoisted(() => ({
  configurationMock: {
    apiServerUrl: 'http://localhost:3005',
    serverUrl: 'http://localhost:3005',
    activeServerId: 'test-server',
    activeServerDir: '',
    currentCliVersion: '0.2.10-test',
    happyHomeDir: process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? process.env.TEMP ?? '.',
    socketIoTransports: ['polling', 'websocket'] as string[],
    // Canonical configuration defaults: no execution cap without an operator override.
    executionRunsMaxConcurrentPerSession: null,
    oneShotTasksMaxConcurrentPerSession: null,
    executionBudgetMaxConcurrentTotalPerSession: null,
    executionBudgetMaxConcurrentByClass: Object.freeze({}),
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

// Configuration is the environment boundary; use its canonical finite-transfer defaults.
vi.mock('@/configuration', async () => {
  const { readFiniteTransferConfig } = await import('@happier-dev/transfers/node');
  const transfer = readFiniteTransferConfig({});
  Object.assign(configurationMock, {
    filesTransferChunkBytes: transfer.chunkSizeBytes,
    filesTransferSessionTtlMs: transfer.ttlMs,
  });
  return { configuration: configurationMock };
});

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('./changes', () => ({ fetchChanges: vi.fn() }));
// Credential files and durable change cursors are filesystem boundaries, not RPC logic.
vi.mock('@/persistence', () => ({
  readAccountChangesCursor: vi.fn(),
  writeAccountChangesCursor: vi.fn(),
  readStoredCredentials: vi.fn(async () => null),
  readStoredCredentialsForServerId: vi.fn(async () => null),
}));
vi.mock('./client/loopbackUrl', () => ({ resolveLoopbackHttpUrl: (value: string) => value }));
vi.mock('@/utils/proxy/socketIoProxy', () => ({ getSocketIoProxyOptions: () => ({}) }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(fn: () => Promise<T>) => await fn() }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));

describe('ApiMachineClient transports', () => {
  beforeEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    mockAxiosPost.mockResolvedValue({ status: 200, data: { success: true, applied: true } });
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
  });

  afterEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.activeServerDir = '';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    vi.mocked(logger.warn).mockReset();
    mockAxiosPost.mockReset();
    vi.unstubAllEnvs();
  });

  it('publishes only safe retained Machine content and refuses new private peer flow fields before encryption', async () => {
    const key = new Uint8Array(32).fill(3);
    const published: unknown[] = [];
    const publishedMetadata: unknown[] = [];
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: vi.fn(async (event: string, payload: unknown) => {
      if (event === 'machine-update-metadata') {
        const update = payload as { metadata: string };
        publishedMetadata.push(decryptLegacy(decodeBase64(update.metadata), key));
        return { result: 'success', version: publishedMetadata.length, metadata: update.metadata };
      }
      if (event !== 'machine-update-state') return { success: true, applied: true };
      const update = payload as { daemonState: string };
      published.push(decryptLegacy(decodeBase64(update.daemonState), key));
      return { result: 'success', version: published.length, daemonState: update.daemonState };
    }) });
    bindApiSessionSocketMock(mockIo, socket);
    const privateState = {
      status: 'running',
      workspaceSync: {
        v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } },
        status: { relationshipId: 'private-relationship', alphaPath: '/private/work' },
      },
      peerMediation: { loopback: { flows: { machine_rpc: { active: true, token: 'private-token' } } } },
      transfer: {
        supported: { import: true, export: true },
        listenerClasses: {
          loopback_http: { enabled: true, configured: true, active: false, token: 'transfer-secret' },
          tailscale_serve_https: { enabled: false, configured: false, active: false },
        },
        lifecycle: { mode: 'lazy_idle_shutdown', version: 1 }, native: { privatePath: '/private/native' },
      },
      foreignSession: { id: 'foreign-session', command: 'private-command' },
    };
    const client = new ApiMachineClient('fake-token', {
      id: 'machine', encryptionKey: key, encryptionVariant: 'legacy',
      metadata: {
        host: 'workstation', platform: 'linux', happyCliVersion: '0.3',
        homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier',
        privateWorkspace: { relationshipId: 'private-relationship', path: '/private/work', token: 'metadata-secret' },
      },
      metadataVersion: 0, daemonState: privateState, daemonStateVersion: 0,
    } as Machine);
    client.connect();
    try {
      await client.updateMachineMetadata((metadata) => ({ ...metadata, displayName: 'Workstation' }));
      expect(publishedMetadata).toEqual([{
        host: 'workstation', platform: 'linux', happyCliVersion: '0.3',
        homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier', displayName: 'Workstation',
      }]);
      await client.updateDaemonState((state) => ({ ...state, status: 'running' }));
      expect(published).toEqual([{
        status: 'running',
        workspaceSync: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } },
        peerMediation: { loopback: { flows: { machine_rpc: { active: true } } } },
        transfer: {
          supported: { import: true, export: true },
          listenerClasses: {
            loopback_http: { enabled: true, configured: true, active: false },
            tailscale_serve_https: { enabled: false, configured: false, active: false },
          },
          lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        },
      }]);
      await expect(client.updateDaemonState((state) => ({
        ...state, status: 'running',
        peerMediation: { loopback: { flows: { machine_rpc: { active: true, token: 'new-private-token' } } } },
      }))).rejects.toThrow();
      expect(published).toHaveLength(1);
    } finally {
      await client.shutdown();
    }
  });

  it('uses polling-first transports by default (upgrade to websocket when available)', async () => {
    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates/');
    expect(opts.transports).toEqual(['polling', 'websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
    await client.shutdown();
  });

  it('routes a descriptor replacement through the existing connection supervisor', async () => {
    vi.useFakeTimers();
    try {
      const firstSocket = createApiSessionSocketStub();
      const replacementSocket = createApiSessionSocketStub();
      bindApiSessionSocketSequenceMock(mockIo, [firstSocket, replacementSocket]);
      const prepareServerTransportForReconnect = vi.fn(async () => ({ status: 'ready' as const }));
      const client = new ApiMachineClient('fake-token', {
        id: 'test-machine',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      });

      client.connect({ prepareServerTransportForReconnect });
      expect(mockIo).toHaveBeenCalledTimes(1);

      expect(client.requestServerTransportReconnect()).toBe(true);
      await vi.advanceTimersByTimeAsync(300);

      expect(prepareServerTransportForReconnect).toHaveBeenCalledOnce();
      expect(mockIo).toHaveBeenCalledTimes(2);
      await client.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the strict machine terminal capture/finalize socket contract', async () => {
    const {
      MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
      MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
    } = await import('@happier-dev/protocol');
    const machineSocket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: vi.fn(async (event: string) => {
        if (event === MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1) {
          return {
            v: 1,
            status: 'captured',
            sessionId: 's1',
            authority: { kind: 'generation', publisherGeneration: '7' },
          };
        }
        if (event === MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1) {
          return { v: 1, status: 'closed', sessionId: 's1' };
        }
        return { success: true, applied: true };
      }),
    });
    bindApiSessionSocketMock(mockIo, machineSocket);
    const mod = await import('./apiMachine');
    const client = new mod.ApiMachineClient('fake-token', {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.connect();

    await expect(client.captureMachineSessionTerminal('s1')).resolves.toEqual({
      v: 1,
      status: 'captured',
      sessionId: 's1',
      authority: { kind: 'generation', publisherGeneration: '7' },
    });
    await expect(client.finalizeMachineSessionTerminal({
      sessionId: 's1',
      authority: { kind: 'generation', publisherGeneration: '7' },
    })).resolves.toEqual({ v: 1, status: 'closed', sessionId: 's1' });
    expect(machineSocket.emitWithAck).toHaveBeenCalledWith(
      MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
      { v: 1, sessionId: 's1' },
    );
    expect(machineSocket.emitWithAck).toHaveBeenCalledWith(
      MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
      {
        v: 1,
        sessionId: 's1',
        authority: { kind: 'generation', publisherGeneration: '7' },
      },
    );
    await client.shutdown();
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

  it('keeps an exact daemon turn settlement in the disjoint daemon journal when delivery fails', async () => {
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
      expect(client.enqueueDaemonTerminalExactTurnEnd).toBeTypeOf('function');
      await client.enqueueDaemonTerminalExactTurnEnd({
        v: 1,
        sessionId: 'session-1',
        mutationId: 'daemon-observed-exit:exact-1',
        action: 'end_session',
        turnId: 'turn-1',
        observedAt: 1234,
      });

      const runtimePaths = resolveSessionClientDurableMutationJournalPaths({
        activeServerDir: tempServerDir,
        sessionId: 'session-1',
        custody: 'runtime',
      });
      const daemonPaths = resolveSessionClientDurableMutationJournalPaths({
        activeServerDir: tempServerDir,
        sessionId: 'session-1',
        custody: 'daemon',
      });
      const parsed = JSON.parse(
        await readFile(daemonPaths.queuePath, 'utf8'),
      ) as { mutations?: Array<{ kind?: string; payload?: Record<string, unknown> }> };
      expect(parsed.mutations).toEqual([
        expect.objectContaining({
          kind: 'session_turn_mutation',
          payload: {
            v: 1,
            sessionId: 'session-1',
            mutationId: 'daemon-observed-exit:exact-1',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 1234,
          },
        }),
      ]);
      await expect(readFile(runtimePaths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('installs usage and exact bindings before replaying discovered daemon journals', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-daemon-recovery-'));
    configurationMock.activeServerDir = tempServerDir;
    const journalDir = join(tempServerDir, 'session-mutations');
    await mkdir(journalDir, { recursive: true });
    const payload = {
      v: 1,
      sessionId: 'session-recovery-1',
      mutationId: 'daemon-recovery-exact-1',
      action: 'end_session',
      turnId: 'turn-recovery-1',
      observedAt: 100,
    } as const;
    const recoveryPaths = resolveSessionClientDurableMutationJournalPaths({
      activeServerDir: tempServerDir,
      sessionId: 'session-recovery-1',
      custody: 'daemon',
    });
    await writeFile(recoveryPaths.queuePath, JSON.stringify({
      v: 1,
      mutations: [{
        kind: 'session_turn_mutation',
        mutationId: payload.mutationId,
        payload,
        createdAt: 100,
        attempts: 0,
        nextAttemptAt: 0,
      }],
    }));
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        receipt: {
          ...payload,
          decision: 'applied',
          appliedAt: 101,
        },
      },
    });
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
    const bindUsageLimitRecoveryJournals = vi.fn(async (sessionIds: readonly string[]) => ({
      boundSessionIds: sessionIds,
      retainedSessionIds: [],
    }));

    try {
      await expect(client.recoverDaemonTerminalSessionMutationJournals({
        bindUsageLimitRecoveryJournals,
      })).resolves.toEqual({
        recoveredSessionIds: ['session-recovery-1'],
        retainedSessionIds: [],
      });
      expect(bindUsageLimitRecoveryJournals).toHaveBeenCalledWith(['session-recovery-1']);
      expect(bindUsageLimitRecoveryJournals).toHaveBeenCalledBefore(mockAxiosPost);
      await expect(readFile(recoveryPaths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('retains a discovered daemon journal when quiescence begins while usage binding is in flight', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-daemon-quiesced-binding-'));
    configurationMock.activeServerDir = tempServerDir;
    await mkdir(join(tempServerDir, 'session-mutations'), { recursive: true });
    const payload = {
      v: 1,
      sessionId: 'session-quiesced-binding',
      mutationId: 'daemon-quiesced-binding-exact-1',
      action: 'end_session',
      turnId: 'turn-quiesced-binding-1',
      observedAt: 100,
    } as const;
    const recoveryPaths = resolveSessionClientDurableMutationJournalPaths({
      activeServerDir: tempServerDir,
      sessionId: payload.sessionId,
      custody: 'daemon',
    });
    await writeFile(recoveryPaths.queuePath, JSON.stringify({
      v: 1,
      mutations: [{
        kind: 'session_turn_mutation',
        mutationId: payload.mutationId,
        payload,
        createdAt: 100,
        attempts: 0,
        nextAttemptAt: 0,
      }],
    }));
    const mod = await import('./apiMachine');
    const client = new mod.ApiMachineClient('fake-token', {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    let quiescing = false;
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve; });
    const bindUsageLimitRecoveryJournals = vi.fn(async (sessionIds: readonly string[]) => {
      await bindingGate;
      return {
        boundSessionIds: sessionIds,
        retainedSessionIds: [],
      };
    });

    try {
      const recovery = client.recoverDaemonTerminalSessionMutationJournals({
        bindUsageLimitRecoveryJournals,
        isShuttingDown: () => quiescing,
      });
      await vi.waitFor(() => expect(bindUsageLimitRecoveryJournals).toHaveBeenCalledOnce());
      quiescing = true;
      releaseBinding();
      await expect(recovery).resolves.toEqual({
        recoveredSessionIds: [],
        retainedSessionIds: [],
      });

      expect(mockAxiosPost).not.toHaveBeenCalled();
      await expect(readFile(recoveryPaths.queuePath, 'utf8')).resolves.toContain(payload.mutationId);
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('finishes one admitted journal flush but starts no later journal after quiescence', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-daemon-quiesced-next-journal-'));
    configurationMock.activeServerDir = tempServerDir;
    await mkdir(join(tempServerDir, 'session-mutations'), { recursive: true });
    const payloads = [
      {
        v: 1,
        sessionId: 'session-quiesced-a',
        mutationId: 'daemon-quiesced-a-exact-1',
        action: 'end_session',
        turnId: 'turn-quiesced-a-1',
        observedAt: 100,
      },
      {
        v: 1,
        sessionId: 'session-quiesced-b',
        mutationId: 'daemon-quiesced-b-exact-1',
        action: 'end_session',
        turnId: 'turn-quiesced-b-1',
        observedAt: 101,
      },
    ] as const;
    const recoveryPaths = payloads.map((payload) => resolveSessionClientDurableMutationJournalPaths({
      activeServerDir: tempServerDir,
      sessionId: payload.sessionId,
      custody: 'daemon',
    }));
    for (const [index, payload] of payloads.entries()) {
      await writeFile(recoveryPaths[index]!.queuePath, JSON.stringify({
        v: 1,
        mutations: [{
          kind: 'session_turn_mutation',
          mutationId: payload.mutationId,
          payload,
          createdAt: payload.observedAt,
          attempts: 0,
          nextAttemptAt: 0,
        }],
      }));
    }
    let quiescing = false;
    let releaseFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((resolve) => { releaseFirstFlush = resolve; });
    mockAxiosPost.mockImplementation(async () => {
      const callIndex = mockAxiosPost.mock.calls.length - 1;
      const payload = payloads[callIndex]!;
      if (callIndex === 0) {
        quiescing = true;
        await firstFlushGate;
      }
      return {
        status: 200,
        data: {
          success: true,
          receipt: {
            ...payload,
            decision: 'applied',
            appliedAt: payload.observedAt + 1,
          },
        },
      };
    });
    const mod = await import('./apiMachine');
    const client = new mod.ApiMachineClient('fake-token', {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    try {
      const recovery = client.recoverDaemonTerminalSessionMutationJournals({
        bindUsageLimitRecoveryJournals: async (sessionIds) => ({
          boundSessionIds: sessionIds,
          retainedSessionIds: [],
        }),
        isShuttingDown: () => quiescing,
      });
      await vi.waitFor(() => expect(mockAxiosPost).toHaveBeenCalled());
      releaseFirstFlush();
      await expect(recovery).resolves.toEqual({
        recoveredSessionIds: ['session-quiesced-a'],
        retainedSessionIds: [],
      });

      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      await expect(readFile(recoveryPaths[0]!.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(recoveryPaths[1]!.queuePath, 'utf8')).resolves.toContain(payloads[1].mutationId);
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
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

  it('encrypts live-stream pixels before emitting them to the relay', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);
    const { MACHINE_LIVE_STREAM_SOCKET_EVENT, openMachineLiveStreamEnvelopeV1,
      openSessionDataKeyBundleV0, sealSessionDataKeyBundleV0, encodeBase64, decodeBase64 } = await import('@happier-dev/protocol');
    const machine: Machine = {
      id: 'test-machine',
      encryptionMode: 'e2ee',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'dataKey',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    const client = new ApiMachineClient('fake-token', machine);
    client.connect();
    const envelope = {
      v: 1, sourceMachineId: 'test-machine', targetMachineId: 'viewer-machine',
      message: { kind: 'frame', frame: {
        v: 1, streamId: 'stream_1', sequence: 1, timestampMs: 1000,
        payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
        payloadBase64: 'c2NyZWVuIHBpeGVscw==', payloadSizeBytes: 13,
      } },
    } as const;
    await client.sendMachineLiveStreamRelayEnvelope(envelope);
    const emitted = machineSocket.emit.mock.calls.find(([event]) => event === MACHINE_LIVE_STREAM_SOCKET_EVENT)?.[1];
    expect(emitted).toMatchObject({ message: { kind: 'frame', frame: { payload: { t: 'encrypted', c: expect.any(String) } } } });
    expect(JSON.stringify(emitted)).not.toContain(envelope.message.frame.payloadBase64);
    expect(emitted).not.toHaveProperty('message.frame.payloadBase64');
    const key = new Uint8Array(32).fill(7);
    expect(await openMachineLiveStreamEnvelopeV1(emitted, { mode: 'e2ee', cipher: {
      encryptRaw: async (value) => encodeBase64(await sealSessionDataKeyBundleV0(value, key)),
      decryptRaw: async (value) => {
        const opened = await openSessionDataKeyBundleV0(decodeBase64(value), key);
        return opened.status === 'authenticated' ? opened.value : null;
      },
    } })).toEqual({ ok: true, value: envelope });
    await client.shutdown();
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

  it('emits content-free external-session invalidations over the machine-scoped socket', async () => {
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
      v: 1,
      type: 'external-session-transcript-invalidated',
      binding: {
        v: 1,
        machineId: 'test-machine',
        sessionId: 'session-1',
        link: { generation: 'link-1', remoteSessionId: 'remote-1' },
        source: {
          qualifiedIdentity: {
            v: 1,
            agent: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', contractVersion: 1 },
          },
          generation: 'source-1',
        },
        sourceCustody: { kind: 'development', registeredRootId: 'contribution-1' },
        cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
      },
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('external-session-transcript-invalidated', expect.objectContaining({
      binding: expect.objectContaining({ sessionId: 'session-1' }),
    }));
    expect(machineSocket.emit.mock.calls.at(-1)?.[1]).not.toHaveProperty('items');

    client.emitExternalSessionSourceUnavailableOccurrence({
      v: 1,
      type: 'external-session-source-unavailable',
      sessionId: 'session-1',
      machineId: 'test-machine',
      observedAtMs: 123,
    });
    expect(machineSocket.emit).toHaveBeenLastCalledWith('external-session-source-unavailable', {
      v: 1,
      type: 'external-session-source-unavailable',
      sessionId: 'session-1',
      machineId: 'test-machine',
      observedAtMs: 123,
    });
  });

  it('serves voice inference status through the registered machine RPC', async () => {
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

    // The native inference/model worker is the OS boundary; RPC registration and policy remain real.
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
        pluginIdentity: null,
        kind: 'stt_sherpa' as const,
        model: 'sherpa',
        version: '1',
        executionSupport: ['daemon' as const],
        installState: 'installed' as const,
        progress: null,
        lastError: null,
        updatedAtMs: 0,
      })),
      acceptModelPackLicense: vi.fn(async () => ({
        packId: 'stt-pack',
        pluginIdentity: null,
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
      createStreamingTranscriptionSession: vi.fn(async () => {
        throw Object.assign(new Error('streaming runtime unavailable'), { code: 'runtime_unavailable' });
      }),
      cancelStt: vi.fn(async () => {}),
    };

    const runtimeHome = await mkdtemp(join(tmpdir(), 'happier-machine-rpc-voice-'));
    configurationMock.activeServerDir = runtimeHome;
    vi.stubEnv('HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const features = FeaturesResponseSchema.parse({ features: { voice: { enabled: true } } });
    const client = new mod.ApiMachineClient('fake-token', machine);
    try {
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
        voiceInference,
      }, { getServerFeaturesSnapshot: () => ({ status: 'ready', features }) });

      await expect(client.invokeLocalMachineAction(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, {})).resolves.toEqual({
        ok: true,
        serviceState: 'ready',
        normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
        models: [],
      });
    } finally {
      await client.shutdown();
      await rm(runtimeHome, { recursive: true, force: true });
    }
  });

  it('projects canonical update-session archive state with real machine RPC lifecycle registration', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);
    const mod = await import('./apiMachine');
    const machine: Machine = {
      id: 'machine-archive-state',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    const runtimeHome = await mkdtemp(join(tmpdir(), 'happier-machine-rpc-archive-'));
    configurationMock.activeServerDir = runtimeHome;
    const client = new mod.ApiMachineClient('fake-token', machine);
    try {
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      });

      const listener = vi.fn();
      const unsubscribe = client.onSessionArchivedStateChange(listener);
      client.connect();

      machineSocket.getHandler('update')?.({
        id: 'update-session-without-archive-state',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          id: 'session-metadata-only',
          metadata: 'encrypted-metadata',
        },
      } as never);
      machineSocket.getHandler('update')?.({
        id: 'update-archive',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          id: 'session-archived',
          archivedAt: 123,
        },
      } as never);
      machineSocket.getHandler('update')?.({
        id: 'update-unarchive',
        seq: 3,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          id: 'session-archived',
          archivedAt: null,
        },
      } as never);

      expect(listener).toHaveBeenNthCalledWith(1, {
        sessionId: 'session-archived',
        archived: true,
      });
      expect(listener).toHaveBeenNthCalledWith(2, {
        sessionId: 'session-archived',
        archived: false,
      });

      unsubscribe();
      machineSocket.getHandler('update')?.({
        id: 'update-after-unsubscribe',
        seq: 4,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          id: 'session-after-unsubscribe',
          archivedAt: 456,
        },
      } as never);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      await client.shutdown();
      await rm(runtimeHome, { recursive: true, force: true });
    }
  });

});
