import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnrollMachineFlowExecutorFromHappierJsonExecutor } from '@happier-dev/cli-common/systemTasks';
import axios from 'axios';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import {
  FeaturesResponseSchema,
  MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
} from '@happier-dev/protocol';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { ApiMachineClient } from './apiMachine';
import { ApiClient } from './api';
import { createMachineContentCodec } from './machine/machineStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDaemonAgentIsolationEffects } from '@/daemon/agentIsolation/createDaemonAgentIsolationEffects';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { startPeerMediationLoopback } from '@/daemon/peer/mediation/rpc/startLoopback';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

const callOrder = vi.hoisted(() => [] as string[]);
const ioMock = vi.hoisted(() => vi.fn());
const probeReadinessMock = vi.hoisted(() => vi.fn(async () => ({ status: 'ready' as const })));
const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function registerRequiredMachineControlHandlers(rpcHandlerManager: RpcHandlerManager): void {
  for (const method of [
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    RPC_METHODS.STOP_SESSION,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
  ]) {
    rpcHandlerManager.registerHandler(method, async () => ({ ok: true }));
  }
}

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://example.test',
    apiServerUrl: 'https://example.test',
    activeServerId: 'connect-order-home',
    currentCliVersion: '0.0.0-test',
    socketForceWebsocketOnly: false,
    socketIoTransports: ['polling', 'websocket'],
    activeServerDir: '/private/tmp/happier-api-machine-connect-order',
    happyHomeDir: '/private/tmp/happier-api-machine-connect-order-home',
    executionRunsMaxConcurrentPerSession: null,
    oneShotTasksMaxConcurrentPerSession: null,
    organizationPolicy: { status: 'absent' },
  },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => probeReadinessMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebugMock,
    info: () => undefined,
    warn: loggerWarnMock,
    debugLargeJson: () => undefined,
  },
}));

describe('ApiMachineClient connect ordering', () => {
  it.each((['plain', 'e2ee'] as const).flatMap(mode => [true, false].map(enabled => ({ mode, enabled }))))(
    'claims an incumbent runtime in $mode with isolation $enabled before readiness publication and preserves that proof on reconnect', async ({ mode, enabled }) => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/happier',
      happyHomeDir: '/home/happier/.happier', agentIsolation: { enabled } };
    const secret = new Uint8Array(32).fill(21);
    const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
      : { encryptionKey: secret, encryptionVariant: 'legacy' });
    const retained = { id: 'runtime-replacement', metadata: codec.encodeStored(metadata), metadataVersion: 4,
      daemonState: codec.encodeStored({ status: 'running', pid: process.pid, startedAt: 1, runtimeId: 'predecessor',
        agentIsolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }),
      daemonStateVersion: 3, dataEncryptionKey: mode === 'plain' ? MACHINE_PLAIN_DATA_KEY_MARKER : null };
    // HTTP and Socket.IO are the boundaries. Registration, readiness, codecs,
    // publication reducers and current-runtime admission execute real code.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith(`/v1/machines/${retained.id}`)) return { status: 200, data: { machine: retained } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
      throw new Error(`Unexpected HTTP path: ${new URL(url).pathname}`);
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
    const api = await ApiClient.create({ token: 'test-token', encryption: mode === 'plain' ? null : { type: 'legacy', secret } });
    const machine = await api.getOrCreateMachine({ machineId: retained.id, metadata,
      daemonState: { status: 'offline', runtimeId: 'successor' } });
    expect(machine.daemonState).toMatchObject({ runtimeId: 'predecessor', agentIsolation: { kind: 'effective' } });
    expect(post.mock.calls[0]?.[1]).toMatchObject({ daemonState: retained.daemonState });
    const states: unknown[] = [];
    const socket = () => createApiSessionSocketStub({ disconnectReason: 'transport close', emitWithAck: (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { v: 1, result: 'success', revision: 1 };
      if (event === 'machine-update-state') {
        const write = payload as { daemonState: string; expectedVersion: number }; // Socket boundary.
        states.push(codec.decodeStored(write.daemonState));
        retained.daemonState = write.daemonState;
        retained.daemonStateVersion = write.expectedVersion + 1;
        return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
      }
      return { result: 'success', version: 1 };
    } });
    const first = socket(), second = socket();
    bindApiSessionSocketSequenceMock(ioMock, [first, second]);
    const client = new ApiMachineClient('test-token', machine, { runtimeId: 'successor' });
    const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(manager);
    const acknowledge = async (current: typeof first) => {
      await vi.waitFor(() => expect(current.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, expect.anything()));
      for (const [event, registration] of current.emit.mock.calls) {
        if (event === SOCKET_RPC_EVENTS.REGISTER && registration && typeof registration === 'object'
          && 'method' in registration && typeof registration.method === 'string') {
          current.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: registration.method });
        }
      }
    };
    try {
      client.connect();
      await acknowledge(first);
      await vi.waitFor(() => expect(states).toHaveLength(1));
      expect(machine.daemonState).toMatchObject({ runtimeId: 'successor', agentIsolation: { kind: enabled ? 'unavailable' : 'disabled' } });
      expect(machine.daemonState?.startedAt).not.toBe(1);
      expect(client.getAgentIsolationSnapshot()).toMatchObject({ enabled, status: { kind: enabled ? 'unavailable' : 'disabled' } });
      // This is the actual production readiness writer. Native qualification's
      // binary/ACL proof is covered through its registered owner in agentIsolationReadiness.test.ts.
      const effects = createDaemonAgentIsolationEffects({ getMachineClient: () => client,
        adminAccess: { target: () => null, observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
        readRoots: () => [], trackedSessions: new Map(), protectedRoots: [], privateRoots: [] });
      if (enabled) await effects.publishStatus({ kind: 'effective', platform: 'linux', agentUser: 'happier-agent' });
      expect(client.getAgentIsolationSnapshot()).toMatchObject({ status: { kind: enabled ? 'effective' : 'disabled' } });
      const qualified = machine.daemonState;
      const settled = states.length;
      first.disconnect();
      await acknowledge(second);
      await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true));
      expect(client.getAgentIsolationSnapshot()).toMatchObject({ status: { kind: enabled ? 'effective' : 'disabled' } });
      expect(machine.daemonState).toEqual(qualified);
      expect(states).toHaveLength(settled);
    } finally { await client.shutdown(); get.mockRestore(); post.mockRestore(); }
  });

  it('recovers the current aggregate activity through startup publication without restarting inventory observations', async () => {
    const activity = createManagedActivityInventory({ now: () => 1234, producers: [{
      read: () => ({ items: [], coverage: 'complete' }), subscribe: () => () => undefined,
    }] });
    await activity.readDecision();
    const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event === 'machine-update-state') {
        const write = payload as { daemonState: string; expectedVersion: number };
        return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
      }
      return { result: 'success', revision: 1 };
    } });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient(String(1), { id: 'machine-1', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonStateVersion: 0,
      daemonState: { status: 'running', managedActivity: { kind: 'busy', reasons: ['finite'] } },
    }, undefined, { managedActivity: { activity, admissionDrain: createDaemonAdmissionDrain() } });
    const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(manager);
    try {
      client.connect();
      await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, expect.anything()));
      for (const [event, registration] of socket.emit.mock.calls) {
        if (event === SOCKET_RPC_EVENTS.REGISTER && registration && typeof registration === 'object'
          && 'method' in registration && typeof registration.method === 'string') {
          socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: registration.method });
        }
      }
      const { decodePlainMachineStoredContent } = await import('@happier-dev/protocol/machines/machineStoredContent');
      await vi.waitFor(() => {
        const writes = socket.emitWithAck.mock.calls.filter(([event]) => event === 'machine-update-state');
        expect(writes.length).toBeGreaterThan(0);
        const write = writes.at(-1)![1] as { daemonState: string };
        expect(decodePlainMachineStoredContent(write.daemonState)).toMatchObject({ managedActivity: { kind: 'idle', since: 1234 } });
      });
    } finally { await client.shutdown(); activity.dispose(); }
  });

  afterEach(() => {
    callOrder.length = 0;
    probeReadinessMock.mockClear();
    loggerWarnMock.mockClear();
    loggerDebugMock.mockClear();
    ioMock.mockReset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('registers core RPCs while Account identity is pending and keeps peer effects behind that identity', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const profile = createDeferred<{ status: number; data: { id: string } }>();
    // HTTP is the boundary: retain the real identity acquisition and RPC admission.
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/profile')) return await profile.promise;
      throw new Error(`Unexpected startup HTTP route: ${new URL(String(url)).pathname}`);
    });
    const socket = createApiSessionSocketStub({
      id: 'identity-pending-socket',
      emitWithAck: (event, payload) => event === 'machine-update-state'
        ? { result: 'success', version: 1, daemonState: (payload as { daemonState: string }).daemonState }
        : { result: 'success', version: 1 },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'startup-account' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, {
      id: 'machine-1', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    });
    const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(manager);
    let peerSettled = false;
    try {
      client.connect();
      await vi.waitFor(() => expect(http).toHaveBeenCalledWith(
        'https://example.test/v1/account/profile', expect.anything(),
      ));
      const peer = client.getPeerMediationMachineRpcHandlerManager().invokeLocal(
        RPC_METHODS.STOP_SESSION, {}, { verifiedPeerAccountId: 'startup-account' },
      );
      void peer.then(() => { peerSettled = true; });
      const registrations = () => socket.emit.mock.calls.flatMap(([event, registration]) =>
        event === SOCKET_RPC_EVENTS.REGISTER && registration && typeof registration === 'object'
          && 'method' in registration && typeof registration.method === 'string'
          ? [registration.method] : []);
      await vi.waitFor(() => expect(registrations()).toContain(`machine-1:${RPC_METHODS.STOP_SESSION}`));
      expect(peerSettled).toBe(false);
      for (const method of registrations()) socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method });
      await vi.waitFor(() => expect(socket.emitWithAck.mock.calls).toContainEqual([
        'machine-update-state', expect.objectContaining({ daemonState: expect.any(String) }),
      ]));
      expect(peerSettled).toBe(false);
      // An authenticated Profile that names another Account cannot admit the peer.
      profile.resolve({ status: 200, data: { id: 'different-account' } });
      await expect(peer).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(http.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile'))).toHaveLength(1);
    } finally {
      profile.resolve({ status: 200, data: { id: 'different-account' } });
      await client.shutdown();
      http.mockRestore();
    }
  });

  it('publishes endpoint owner changes while Machine heartbeats only renew reachability', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    // Home feature discovery is an HTTP boundary; keep connection admission real.
    const fetchFeatures = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ features: {}, capabilities: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const socket = createApiSessionSocketStub({
      id: 'heartbeat-socket',
      emitWithAck: (event, payload) => event === 'machine-update-state'
        ? { result: 'success', version: ++version, daemonState: (payload as { daemonState: string }).daemonState }
        : { result: 'success', version },
    });
    let version = 0;
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const key = new Uint8Array(32).fill(1);
    const client = new ApiMachineClient('token', {
      id: 'machine-1', encryptionKey: key, encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    });
    const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(manager);
    let now = 2_000;
    const listener = await startPeerMediationLoopback({
      accountId: 'account-1', machineId: 'machine-1',
      serverFeatures: FeaturesResponseSchema.parse({
        features: { machines: { enabled: true, rpc: { enabled: true, directPeer: { enabled: true } } } },
        capabilities: { machines: { peerMediation: { grantSigningKeys: [{
          keyId: 'heartbeat-key', publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'), expiresAt: null,
        }] } } },
      }),
      rpcHandlerManager: client.getPeerMediationMachineRpcHandlerManager(),
      nowMs: () => now,
    });
    if (!listener) throw new Error('expected listener');
    const { decodeBase64, decryptResult } = await import('@/api/encryption');
    const readPublishedState = () => {
      const writes = socket.emitWithAck.mock.calls.filter(([event]) => event === 'machine-update-state');
      const content = (writes.at(-1)![1] as { daemonState: string }).daemonState;
      return decryptResult(key, 'legacy', decodeBase64(content));
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const publishEndpoint = async () => {
      const endpoint = listener.readEndpoint();
      await client.updateDaemonState((state) => ({
        ...state, status: 'running',
        peerMediation: { ...state?.peerMediation, loopback: endpoint ? { endpoint, flows: listener.activeFlows.machine_rpc ? { machine_rpc: { active: true } } : {} } : undefined },
      }));
    };
    const unsubscribe = listener.subscribeEndpointChanges(() => { void publishEndpoint(); });
    let connected = false;
    try {
      client.connect({ onConnect: async () => { await publishEndpoint(); connected = true; } });
      await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, expect.anything()));
      for (const [event, registration] of socket.emit.mock.calls) {
        if (event === SOCKET_RPC_EVENTS.REGISTER && registration && typeof registration === 'object'
            && 'method' in registration && typeof registration.method === 'string') {
          socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: registration.method });
        }
      }
      await vi.waitFor(() => expect(connected).toBe(true));
      // Connect's callback and registration readiness publish independently.
      // Heartbeat assertions start after the real readiness state is acknowledged.
      await vi.waitFor(() => expect(readPublishedState()).toMatchObject({
        status: 'authenticated', value: { pid: process.pid, contributionRegistryProjectionRevision: 0 },
      }));
      const writesBeforeHeartbeat = socket.emitWithAck.mock.calls.filter(([event]) => event === 'machine-update-state').length;
      // Measure one complete steady interval; connection readiness may have
      // advanced the fake clock before this observation window starts.
      socket.emit.mockClear();
      now += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.emit.mock.calls.filter(([event]) => event === 'machine-alive')).toHaveLength(1);
      expect(socket.emitWithAck.mock.calls.filter(([event]) => event === 'machine-update-state')).toHaveLength(writesBeforeHeartbeat);
      now = listener.endpoint.expiresAt - 150_000;
      await vi.advanceTimersByTimeAsync(130_000);
      await vi.waitFor(() => expect(readPublishedState()).toMatchObject({
        status: 'authenticated', value: { peerMediation: { loopback: { endpoint: {
          ...listener.endpoint, expiresAt: now + 300_000,
        } } } },
      }));
      await listener.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.waitFor(() => expect(readPublishedState()).not.toHaveProperty('value.peerMediation.loopback'));
      const writesBeforeShutdown = socket.emitWithAck.mock.calls.filter(([event]) => event === 'machine-update-state').length;
      await client.shutdown();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(socket.emitWithAck.mock.calls.filter(([event]) => event === 'machine-update-state')).toHaveLength(writesBeforeShutdown);
    } finally {
      fetchFeatures.mockRestore();
      unsubscribe();
      await client.shutdown();
      await listener.stop();
    }
  });

  it.each([0, 7])('installs the RPC listener before connecting and replays client handlers before state on every generation (projection revision %i)', async (projectionRevision) => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      disconnectReason: 'transport close',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-1`,
        );
      },
      emit: (event, args) => {
        if (
          event === SOCKET_RPC_EVENTS.REGISTER
          && (args[0] as { method?: unknown } | undefined)?.method === 'machine-1:neutral.reconnect'
        ) {
          callOrder.push('register:machine-socket-1');
        }
      },
      emitWithAck: (event, payload) => {
        if (event === 'machine-update-state') {
          callOrder.push('state:machine-socket-1');
          return {
            result: 'success',
            version: 1,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      disconnectReason: 'transport close',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-2`,
        );
      },
      emit: (event, args) => {
        if (
          event === SOCKET_RPC_EVENTS.REGISTER
          && (args[0] as { method?: unknown } | undefined)?.method === 'machine-1:neutral.reconnect'
        ) {
          callOrder.push('register:machine-socket-2');
        }
      },
      emitWithAck: (event, payload) => {
        if (event === 'machine-update-state') {
          callOrder.push('state:machine-socket-2');
          return {
            result: 'success',
            version: 2,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 2 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);

    const localReadiness: boolean[] = [];
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: projectionRevision === 0
        ? null
        : {
          status: 'running', contributionRegistryProjectionRevision: projectionRevision,
          peerMediation: { loopback: { flows: { machine_rpc: { active: true } } } },
        },
      daemonStateVersion: 0,
    }, undefined, { controlPort: 41233,
      onMachineControlReadinessChange: ready => { localReadiness.push(ready); },
    });

    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    rpcHandlerManager.registerHandler('neutral.reconnect', async () => ({ ok: true }));
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers');
    const acknowledgeRegistrations = (socket: ReturnType<typeof createApiSessionSocketStub>) => {
      // Registration receipts are a server/socket boundary; readiness logic stays real.
      const methods = socket.emit.mock.calls.flatMap(([event, registration]) => {
        if (event !== SOCKET_RPC_EVENTS.REGISTER || !registration || typeof registration !== 'object'
            || !('method' in registration) || typeof registration.method !== 'string') return [];
        return [registration.method];
      });
      for (const method of new Set(methods)) socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method });
    };

    try {
      client.connect();
      await vi.waitFor(() => expect(ioMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(firstSocket.connect,
        JSON.stringify({ warnings: loggerWarnMock.mock.calls, debug: loggerDebugMock.mock.calls })).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      expect(callOrder).not.toContain('state:machine-socket-1');
      acknowledgeRegistrations(firstSocket);
      await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-1'));
      await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true));
      expect(localReadiness).toEqual([true]);
      // The native CLI boundary is read after registration, before any heartbeat.
      // The real waiter consumes that current fact even when it attaches late.
      let statusReads = 0;
      const waiter = createEnrollMachineFlowExecutorFromHappierJsonExecutor({ executor: {
        runHappierText: async () => { throw new Error('Readiness never reinstalls the service'); },
        runHappierJson: async () => {
          statusReads++;
          return { daemon: { pid: process.pid, running: true, healthy: localReadiness.at(-1) },
            service: { installed: true }, auth: { needsAuth: false, machineId: 'machine-1' } };
        },
      } });
      await expect(waiter.waitForReadyDaemon!({ timeoutMs: 1_000, requireMachineControlReady: true }))
        .resolves.toMatchObject({ daemonHealthy: true, machineId: 'machine-1' });
      expect(statusReads).toBe(1);

      const runningPublication = firstSocket.emitWithAck.mock.calls.find(([event]) => event === 'machine-update-state');
      expect(runningPublication).toBeDefined();
      // Exercise the actual encrypted publication, not only its scheduling.
      const { decodeBase64, decryptResult } = await import('@/api/encryption');
      const runningState = decryptResult(new Uint8Array(32).fill(1), 'legacy', decodeBase64((runningPublication![1] as { daemonState: string }).daemonState));
      expect(runningState).toMatchObject({ status: 'authenticated', value: { contributionRegistryProjectionRevision: projectionRevision } });
      if (projectionRevision !== 0) {
        if (runningState.status !== 'authenticated') throw new Error('Expected authenticated machine state');
        const readyState = MachinePublishedDaemonStateV1Schema.parse(runningState.value);
        expect(readyState).toMatchObject({
          status: 'running', pid: process.pid, startedAt: expect.any(Number), httpPort: 41233,
          peerMediation: { loopback: { flows: { machine_rpc: { active: true } } } },
        });
      }
      const realNow = Date.now.bind(Date);
      const laterClock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
      firstSocket.disconnect();
      expect(localReadiness).toEqual([true, false]);
      await vi.waitFor(() => expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER,
        { method: 'machine-1:neutral.reconnect' }));
      expect(callOrder).not.toContain('state:machine-socket-2');
      acknowledgeRegistrations(secondSocket);
      // A reconnect of the same daemon process is not a daemon restart: its running state is already
      // current, so nothing is republished. A fresh startedAt would make every reader treat it as a
      // replaced daemon and re-read its contribution projection.
      await vi.waitFor(() => expect(Reflect.get(client, 'machineControlRunningGeneration')).toBe(Reflect.get(client, 'activeTransportGeneration')));
      expect(localReadiness).toEqual([true, false, true]);
      acknowledgeRegistrations(secondSocket);
      expect(localReadiness).toHaveLength(3);
      expect(callOrder).not.toContain('state:machine-socket-2');
      laterClock.mockRestore();

      for (const id of ['machine-socket-1', 'machine-socket-2']) {
        expect(callOrder.indexOf(`attach:${id}`)).toBeLessThan(callOrder.indexOf(`register:${id}`));
      }
      expect(callOrder.indexOf('register:machine-socket-1')).toBeLessThan(callOrder.indexOf('state:machine-socket-1'));
      expect(firstSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
        method: 'machine-1:neutral.reconnect',
      });
      expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
        method: 'machine-1:neutral.reconnect',
      });
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('advertises session spawn once the exact daemon RPCs are ready, without withdrawing it first', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return {
            v: 1,
            result: 'success',
            revision: capabilityPayloads.length,
          };
        }
        if (event === 'machine-update-state') {
          return {
            result: 'success',
            version: 1,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    const readiness = createDeferred<{ status: 'ready' }>();
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockReturnValue(readiness.promise);

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledWith(
        expect.arrayContaining([
          RPC_METHODS.SESSION_SPAWN_NEW,
          SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
          RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
        ]),
        expect.any(Object),
      ));
      // Nothing is published while readiness is pending: a daemon that holds the
      // capability neither advertises it before the settlement path is ready nor
      // withdraws it, since a projection replaces rather than merges.
      expect(capabilityPayloads).toEqual([]);

      readiness.resolve({ status: 'ready' });

      await vi.waitFor(() => expect(capabilityPayloads).toEqual([
        {
          machineId: 'machine-1',
          capabilities: {
            sessionInputAdmission: { protocolVersions: [1] },
            sessionSpawn: { protocolVersions: [1, 2] },
            pluginWebhookClaim: { protocolVersions: [1] },
            sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
          },
        },
      ]));
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not advertise session spawn from an embedding without the required creation-outcome attestation', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return { v: 1, result: 'success', revision: capabilityPayloads.length };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({ status: 'ready' });

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(capabilityPayloads).toEqual([
        { machineId: 'machine-1', capabilities: {} },
      ]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not publish running when a required machine-control registration is missing', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const socket = createApiSessionSocketStub({ id: 'machine-socket-1' });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({
      status: 'timeout',
      missingMethods: [RPC_METHODS.STOP_SESSION],
    });
    const updateDaemonState = vi.spyOn(client, 'updateDaemonState');

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      expect(updateDaemonState).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(loggerWarnMock).toHaveBeenCalledWith(
          '[API MACHINE] Core machine-control RPC registration did not become ready',
          { status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] },
        ),
      );
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('replays unacknowledged machine-control registrations after the initial deadline, then publishes current capabilities and running', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const statePayloads: unknown[] = [];
    const requiredMachineControlMethods = [
      RPC_METHODS.SPAWN_HAPPY_SESSION,
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.SESSION_SPAWN_NEW,
      RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      RPC_METHODS.STOP_SESSION,
      SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
      RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
    ];
    const registrationAttempts = new Map<string, number>();
    const acknowledgeReplay: { current: (() => void) | null } = { current: null };
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emit: (event, args, activeSocket) => {
        if (event !== SOCKET_RPC_EVENTS.REGISTER) return;
        const method = (args[0] as { method?: unknown } | undefined)?.method;
        if (typeof method !== 'string') return;
        const unprefixedMethod = method.replace(/^machine-1:/, '');
        const requiredMethod = requiredMachineControlMethods.find(
          (candidate) => candidate === unprefixedMethod,
        );
        if (requiredMethod === undefined) return;

        registrationAttempts.set(
          requiredMethod,
          (registrationAttempts.get(requiredMethod) ?? 0) + 1,
        );
        if (
          acknowledgeReplay.current
          || !requiredMachineControlMethods.every((requiredMethod) => (
            registrationAttempts.get(requiredMethod) === 2
          ))
        ) {
          return;
        }
        // The server's post-connect admission can attach its REGISTER listener
        // after the client's first burst. It acknowledges only the replay.
        acknowledgeReplay.current = () => {
          for (const requiredMethod of requiredMachineControlMethods) {
            activeSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, {
              method: `machine-1:${requiredMethod}`,
            });
          }
        };
      },
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return { v: 1, result: 'success', revision: capabilityPayloads.length };
        }
        if (event === 'machine-update-state') {
          statePayloads.push(payload);
          return {
            result: 'success',
            version: statePayloads.length,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    const waitForRegisteredHandlers = rpcHandlerManager.waitForRegisteredHandlers.bind(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockResolvedValueOnce({
        status: 'timeout',
        missingMethods: requiredMachineControlMethods,
      })
      .mockImplementation(waitForRegisteredHandlers);

    try {
      client.connect();
      await vi.waitFor(() => expect(
        requiredMachineControlMethods.map((method) => registrationAttempts.get(method)),
      ).toEqual(requiredMachineControlMethods.map(() => 2)));
      expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2);
      expect(capabilityPayloads).toEqual([]);
      expect(statePayloads).toEqual([]);
      expect(acknowledgeReplay.current).not.toBeNull();
      const replayAcknowledgement = acknowledgeReplay.current;
      if (replayAcknowledgement === null) {
        throw new Error('Expected the registration replay acknowledgement to be installed');
      }
      replayAcknowledgement();

      await vi.waitFor(() => expect(statePayloads).toHaveLength(1));
      expect(capabilityPayloads).toEqual([
        {
          machineId: 'machine-1',
          capabilities: {
            sessionInputAdmission: { protocolVersions: [1] },
            sessionSpawn: { protocolVersions: [1, 2] },
            pluginWebhookClaim: { protocolVersions: [1] },
            sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
          },
        },
      ]);
      expect(
        loggerWarnMock.mock.calls.filter(
          ([message]) => message === '[API MACHINE] Core machine-control RPC registration did not become ready',
        ),
      ).toEqual([]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('ignores late registration acknowledgements from a superseded transport', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const stateSockets: string[] = [];
    const createSocket = (id: string) => createApiSessionSocketStub({
      id,
      disconnectReason: 'transport close',
      emitWithAck: (event, payload) => {
        if (event === 'machine-update-state') {
          stateSockets.push(id);
          return {
            result: 'success',
            version: stateSockets.length,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          return { v: 1, result: 'success', revision: 1 };
        }
        return { result: 'success', version: 1 };
      },
    });
    const firstSocket = createSocket('machine-socket-1');
    const secondSocket = createSocket('machine-socket-2');
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const waitForRegisteredHandlers = rpcHandlerManager.waitForRegisteredHandlers.bind(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockImplementation(waitForRegisteredHandlers);

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));
      firstSocket.disconnect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(3));

      for (const method of [
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        RPC_METHODS.STOP_SESSION,
        SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
      ]) {
        firstSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
      }
      await Promise.resolve();
      expect(stateSockets).toEqual([]);

      for (const method of [
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        RPC_METHODS.STOP_SESSION,
        SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
      ]) {
        secondSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
      }
      await vi.waitFor(() => expect(stateSockets).toEqual(['machine-socket-2']));
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not warn about unready registration when a ready result lands on a superseded transport', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      disconnectReason: 'transport close',
    });
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      disconnectReason: 'transport close',
      emitWithAck: (event) => {
        if (event === 'machine-update-state') {
          callOrder.push('state:machine-socket-2');
        }
        return { result: 'success', version: 2 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);

    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const staleReadiness = createDeferred<{ status: 'ready' }>();
    const liveReadiness = createDeferred<{ status: 'ready' }>();
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockReturnValueOnce(staleReadiness.promise)
      .mockReturnValueOnce(liveReadiness.promise);

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      firstSocket.disconnect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));

      // The first transport's readiness wait resolves *ready* only after its socket was
      // superseded: the registration did become ready, so the operator must not be told
      // it "did not become ready".
      staleReadiness.resolve({ status: 'ready' });
      liveReadiness.resolve({ status: 'ready' });
      await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-2'));

      expect(
        loggerWarnMock.mock.calls.filter(
          ([message]) => message === '[API MACHINE] Core machine-control RPC registration did not become ready',
        ),
      ).toEqual([]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('keeps account-storage RPC upgrade results operation-scoped', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const socket = createApiSessionSocketStub({ id: 'machine-socket-1' });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const phases: string[] = [];
    client.onConnectionStateChange((state) => phases.push(state.phase));

    try {
      client.connect();
      await vi.waitFor(() => expect(socket.getHandlers(SOCKET_RPC_EVENTS.ERROR)).toHaveLength(1));
      const supervisor = Reflect.get(client, 'connectionSupervisor') as {
        reportProbeResult?: (probe: unknown) => void;
      };
      const reportProbeResult = vi.spyOn(supervisor, 'reportProbeResult');
      socket.trigger(SOCKET_RPC_EVENTS.ERROR, {
        type: 'register',
        error: 'client-upgrade-required',
        requirement: {
          v: 1,
          kind: 'account-stored-content',
          minimumProtocolVersion: 2,
        },
      });

      expect(reportProbeResult).not.toHaveBeenCalled();
      expect(phases).not.toContain('auth_failed');
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not withdraw its capability projection when machine-control registration times out', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return { v: 1, result: 'success', revision: capabilityPayloads.length };
        }
        if (event === 'machine-update-state') {
          return {
            result: 'success',
            version: 1,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({
      status: 'timeout',
      missingMethods: [RPC_METHODS.STOP_SESSION],
    });

    try {
      client.connect();
      await vi.waitFor(() =>
        expect(loggerWarnMock).toHaveBeenCalledWith(
          '[API MACHINE] Core machine-control RPC registration did not become ready',
          expect.objectContaining({ status: 'timeout' }),
        ),
      );
      // A projection replaces rather than merges, so an empty publication is a
      // withdrawal of sessionSpawn that only a later republication can undo.
      // A daemon that holds the capability must never assert otherwise.
      expect(capabilityPayloads).toEqual([]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  function createReadinessClient() {
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({ status: 'ready' });
    return client;
  }

  it('retries a timed-out capability publication on the live socket without tearing the transport down', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityAttempts: unknown[] = [];
    const statePayloads: unknown[] = [];
    // A slow Home (lock convoy) answers the first publication after the ack deadline.
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      disconnectReason: 'transport close',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityAttempts.push(payload);
          if (capabilityAttempts.length === 1) {
            throw new Error('Socket ACK timed out for machine-update-operation-protocol-capabilities');
          }
          return { v: 1, result: 'success', revision: capabilityAttempts.length };
        }
        if (event === 'machine-update-state') {
          statePayloads.push(payload);
          return {
            result: 'success',
            version: 1,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    const unusedSocket = createApiSessionSocketStub({ id: 'machine-socket-unused' });
    bindApiSessionSocketSequenceMock(ioMock, [socket, unusedSocket]);
    const client = createReadinessClient();

    try {
      client.connect();
      await vi.waitFor(() => expect(capabilityAttempts).toHaveLength(1));
      // Readiness is not advertised until a publication lands.
      expect(statePayloads).toEqual([]);

      await vi.waitFor(() => expect(statePayloads).toHaveLength(1), { timeout: 10_000 });
      expect(capabilityAttempts).toHaveLength(2);
      expect(capabilityAttempts[1]).toEqual(capabilityAttempts[0]);
      expect(ioMock).toHaveBeenCalledTimes(1);
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.connected).toBe(true);
    } finally {
      await client.shutdown();
    }
  }, 20_000);

  it('reconnects as before when the socket really disconnects while a publication is being retried', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const firstCapabilityAttempts: unknown[] = [];
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      disconnectReason: 'transport close',
      emitWithAck: (event) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          firstCapabilityAttempts.push(event);
          throw new Error('Socket ACK timed out for machine-update-operation-protocol-capabilities');
        }
        return { result: 'success', version: 1 };
      },
    });
    const secondCapabilityPayloads: unknown[] = [];
    const secondStatePayloads: unknown[] = [];
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      disconnectReason: 'transport close',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          secondCapabilityPayloads.push(payload);
          return { v: 1, result: 'success', revision: 2 };
        }
        if (event === 'machine-update-state') {
          secondStatePayloads.push(payload);
          return {
            result: 'success',
            version: 2,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 2 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);
    const client = createReadinessClient();

    try {
      client.connect();
      await vi.waitFor(() => expect(firstCapabilityAttempts).toHaveLength(1));
      expect(ioMock).toHaveBeenCalledTimes(1);

      // The transport liveness owner (the socket's own disconnect) is what ends a connection.
      firstSocket.connected = false;
      firstSocket.trigger('disconnect', 'transport close');

      await vi.waitFor(() => expect(ioMock).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      await vi.waitFor(() => expect(secondCapabilityPayloads).toHaveLength(1), { timeout: 10_000 });
      await vi.waitFor(() => expect(secondStatePayloads).toHaveLength(1), { timeout: 10_000 });
      // The retry that belonged to the dead socket never publishes again.
      expect(firstCapabilityAttempts).toHaveLength(1);
    } finally {
      await client.shutdown();
    }
  }, 20_000);
});
