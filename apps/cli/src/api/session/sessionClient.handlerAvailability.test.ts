import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ApiSessionClient } from './sessionClient';
import { createSessionScopedSocketConnection } from './sockets';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createDeferred } from '@/testkit/async/deferred';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';

// Home HTTP and Socket.IO are the system boundaries; the Session client,
// handler manager, local listener and registration lifecycle remain real.
vi.mock('axios');
const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));
const clients: ApiSessionClient[] = [];
const gates: ReturnType<typeof createDeferred<void>>[] = [];
const method = SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION;

function createClient(local: boolean) {
  const socket = createApiSessionSocketStub();
  mockIo.mockReturnValue(socket);
  const gate = createDeferred<void>();
  gates.push(gate);
  const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner', extras: {
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
  } })).toString('base64url')}.s`;
  const session = createPlainSessionFixture({ id: `input-ready-${local}` });
  const client = new ApiSessionClient(token, session, {
    ...(local ? { localMachineId: 'machine-1' } : {}),
    metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
    initialRegisteredSessionStateFieldMutations: [],
    transport: { serverId: 'input-ready-home', serverUrl: 'https://input-ready.example.test',
      createSessionSocketTransport: ({ sessionId, machineId }) => {
        const connection = createSessionScopedSocketConnection({ token, serverUrl: 'https://input-ready.example.test', sessionId, machineId });
        return { socket: connection.socket, transport: { ...connection.transport,
          connect: async () => { await gate.promise; await connection.transport.connect(); },
        } };
      },
    },
  });
  clients.push(client);
  return { client, socket };
}

beforeEach(() => {
  vi.mocked(axios.get).mockImplementation(async () => ({ status: 404, data: {} }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(async () => {
  gates.splice(0).forEach(gate => gate.resolve());
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.unstubAllGlobals();
});

it.skipIf(process.platform === 'win32')('reports late local provider input without Home ACK and catches up a later subscriber', async () => {
  const { client } = createClient(true);
  const available = vi.fn();
  const unsubscribe = client.subscribeToRpcHandlerAvailability(method, available);
  expect(available).not.toHaveBeenCalled();
  client.rpcHandlerManager.registerHandler(method, async () => ({ status: 'enforced' }));
  await vi.waitFor(() => expect(available).toHaveBeenCalled());
  expect(client.rpcHandlerManager.isHandlerRegistrationAcknowledged(method)).toBe(false);
  const catchup = vi.fn();
  const stopCatchup = client.subscribeToRpcHandlerAvailability(method, catchup);
  expect(catchup).toHaveBeenCalledOnce();
  unsubscribe(); stopCatchup();
  available.mockClear(); catchup.mockClear();
  client.rpcHandlerManager.registerHandler(method, async () => ({ status: 'cleared' }));
  expect(available).not.toHaveBeenCalled();
  expect(catchup).not.toHaveBeenCalled();
});

it('waits for the exact Home handler ACK, catches it up, and republishes after reconnect', async () => {
  const { client, socket } = createClient(false);
  client.rpcHandlerManager.onSocketConnect(socket as unknown as Socket);
  client.rpcHandlerManager.registerHandler(method, async () => ({ status: 'enforced' }));
  const available = vi.fn();
  const unsubscribe = client.subscribeToRpcHandlerAvailability(method, available);
  socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `${client.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}` });
  expect(available).not.toHaveBeenCalled();
  socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `${client.sessionId}:${method}` });
  expect(available).toHaveBeenCalledOnce();
  const catchup = vi.fn();
  const stopCatchup = client.subscribeToRpcHandlerAvailability(method, catchup);
  expect(catchup).toHaveBeenCalledOnce();
  client.rpcHandlerManager.onSocketDisconnect();
  client.rpcHandlerManager.onSocketConnect(socket as unknown as Socket);
  socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `${client.sessionId}:${method}` });
  expect(available).toHaveBeenCalledTimes(2);
  unsubscribe(); stopCatchup();
});

it.each(['retained', 'unsubscribe', 'cancel'] as const)('preserves the %s readiness observer lifetime through deferred attach rollback', async retirement => {
  const { client, socket } = createClient(false);
  const deferred = new DeferredApiSessionClient({ placeholderSessionId: client.sessionId,
    limits: { maxEntries: 10, maxBytes: 10_000 } });
  const available = vi.fn();
  const unsubscribe = deferred.subscribeToRpcHandlerAvailability(method, available);
  await expect(deferred.attach(client, { beforeBufferedDrain: async () => { throw new Error('attach refused'); } })).rejects.toThrow('attach refused');
  if (retirement === 'unsubscribe') unsubscribe();
  else if (retirement === 'cancel') deferred.cancel();
  await deferred.attach(client);
  client.rpcHandlerManager.onSocketConnect(socket as unknown as Socket);
  client.rpcHandlerManager.registerHandler(method, async () => ({ status: 'enforced' }));
  socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `${client.sessionId}:${method}` });
  expect(available).toHaveBeenCalledTimes(retirement === 'retained' ? 1 : 0);
  unsubscribe();
});
