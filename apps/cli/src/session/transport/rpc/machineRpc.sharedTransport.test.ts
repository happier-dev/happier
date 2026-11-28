import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const ioCalls = vi.hoisted(() => [] as unknown[]);
const createdSockets = vi.hoisted(() => [] as Array<ReturnType<typeof createMockSocket>>);
let nextConnectError: Error | null = null;
let closeCount = 0;
let emitCalls: Array<{ event: string; payload: unknown }> = [];

function createMockSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    io: createSocketIoManagerStub(),
    connected: false,
    connect: vi.fn(() => {
      if (nextConnectError) {
        const err = nextConnectError;
        nextConnectError = null;
        socket.connected = false;
        for (const listener of listeners.get('connect_error') ?? []) listener(err);
        return;
      }
      socket.connected = true;
      for (const listener of listeners.get('connect') ?? []) listener();
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
      set.add(handler);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, handler?: (...args: unknown[]) => void) => {
      const set = listeners.get(event);
      if (handler) set?.delete(handler); else set?.clear();
    }),
    removeAllListeners: vi.fn(() => { listeners.clear(); }),
    disconnect: vi.fn(() => { socket.connected = false; }),
    close: vi.fn(() => { socket.connected = false; closeCount++; }),
    emit: vi.fn(),
    emitWithAck: vi.fn(async (event: string, payload: unknown) => {
      emitCalls.push({ event, payload });
      return { ok: true, result: { echoed: payload } };
    }),
  };
  return socket;
}

vi.mock('socket.io-client', () => ({
  io: vi.fn((...args: unknown[]) => {
    ioCalls.push(args);
    const sock = createMockSocket();
    createdSockets.push(sock);
    return sock;
  }),
}));

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({
  default: {
    defaults: {},
    get: (...args: unknown[]) => axiosGet(...args),
    post: vi.fn(),
    request: vi.fn(),
  },
}));

import { callMachineRpc, readMachineRpcRequestDisposition, withSharedMachineRpcTransport } from './machineRpc';

afterEach(() => {
  ioCalls.length = 0;
  createdSockets.length = 0;
  nextConnectError = null;
  closeCount = 0;
  emitCalls = [];
  axiosGet.mockReset();
});

function installPlainMachineMock() {
  axiosGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.endsWith('/v1/machines/machine-1')) {
      return {
        status: 200,
        data: {
          machine: {
            id: 'machine-1',
            kind: 'persistent',
            revokedAt: null,
            replacedByMachineId: null,
            storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          },
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

describe('withSharedMachineRpcTransport', () => {
  it('reuses a single socket connection and machine codec across sequential RPCs to the same machine and closes on exit', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 1 })).toString('base64url')}.sig`;
    installPlainMachineMock();

    await withSharedMachineRpcTransport(async () => {
      const first = await callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'actionOperation.get.v2',
        request: { operationId: 'op-1' },
        serverUrl: 'https://home.test',
      });
      const second = await callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'daemon.terminal.stream.readBytes',
        request: { terminalId: 'term-1', byteOffset: 0 },
        serverUrl: 'https://home.test',
      });
      expect(first).toMatchObject({ echoed: expect.objectContaining({ method: 'machine-1:actionOperation.get.v2' }) });
      expect(second).toMatchObject({ echoed: expect.objectContaining({ method: 'machine-1:daemon.terminal.stream.readBytes' }) });
    });

    // Only one Socket.IO connection and one machine metadata resolution across both RPCs.
    expect(ioCalls).toHaveLength(1);
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines/machine-1'))).toHaveLength(1);
    expect(emitCalls.map(call => call.event)).toEqual([SOCKET_RPC_EVENTS.CALL, SOCKET_RPC_EVENTS.CALL]);
    expect(closeCount).toBeGreaterThanOrEqual(1);

    // After exiting withSharedMachineRpcTransport, a subsequent call opens a fresh socket.
    await callMachineRpc({
      credentials: { token, encryption: null },
      machineId: 'machine-1',
      method: 'daemon.terminal.stream.readBytes',
      request: { terminalId: 'term-1', byteOffset: 10 },
      serverUrl: 'https://home.test',
    });
    expect(ioCalls).toHaveLength(2);
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines/machine-1'))).toHaveLength(2);
  });

  it('isolates pooled sockets across different runWithServerHttpBaseUrl contexts when serverUrl is omitted', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 1 })).toString('base64url')}.sig`;
    installPlainMachineMock();

    await withSharedMachineRpcTransport(async () => {
      await runWithServerHttpBaseUrl('https://home-a.test', () => callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'actionOperation.get.v2',
        request: { operationId: 'op-a' },
      }));
      await runWithServerHttpBaseUrl('https://home-b.test', () => callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'actionOperation.get.v2',
        request: { operationId: 'op-b' },
      }));
    });

    // Each server context must open its own socket and resolve its own machine metadata.
    expect(ioCalls).toHaveLength(2);
    expect(ioCalls[0]).toEqual(expect.arrayContaining(['https://home-a.test']));
    expect(ioCalls[1]).toEqual(expect.arrayContaining(['https://home-b.test']));
    expect(axiosGet.mock.calls.map(([url]) => String(url))).toContain('https://home-a.test/v1/machines/machine-1');
    expect(axiosGet.mock.calls.map(([url]) => String(url))).toContain('https://home-b.test/v1/machines/machine-1');
  });

  it('evicts failed connect entries, translates Home connect RpcError with notSent disposition, and recovers on subsequent calls', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 1 })).toString('base64url')}.sig`;
    installPlainMachineMock();
    nextConnectError = Object.assign(new Error('connect rejected'), {
      data: { error: 'permission_denied', statusCode: 403 },
    });

    await withSharedMachineRpcTransport(async () => {
      let caught: unknown;
      try {
        await callMachineRpc({
          credentials: { token, encryption: null },
          machineId: 'machine-1',
          method: 'actionOperation.get.v2',
          request: { operationId: 'op-1' },
          serverUrl: 'https://home.test',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RpcError);
      expect((caught as RpcError).rpcErrorCode).toBe('permission_denied');
      expect(readMachineRpcRequestDisposition(caught)).toBe('notSent');

      // Failed entry must have been evicted so the next call opens a fresh socket and succeeds.
      const recovered = await callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'actionOperation.get.v2',
        request: { operationId: 'op-2' },
        serverUrl: 'https://home.test',
      });
      expect(recovered).toMatchObject({ echoed: expect.objectContaining({ method: 'machine-1:actionOperation.get.v2' }) });
    });

    expect(ioCalls).toHaveLength(2);
  });

  it('evicts and replaces a pooled socket that became disconnected before reuse', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 1 })).toString('base64url')}.sig`;
    installPlainMachineMock();

    await withSharedMachineRpcTransport(async () => {
      await callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'actionOperation.get.v2',
        request: { operationId: 'op-1' },
        serverUrl: 'https://home.test',
      });
      expect(createdSockets).toHaveLength(1);
      // Simulate the pooled socket dropping between sequential RPCs.
      createdSockets[0]!.connected = false;

      await callMachineRpc({
        credentials: { token, encryption: null },
        machineId: 'machine-1',
        method: 'daemon.terminal.stream.readBytes',
        request: { terminalId: 'term-1', byteOffset: 0 },
        serverUrl: 'https://home.test',
      });
    });

    expect(ioCalls).toHaveLength(2);
    expect(createdSockets[0]!.close).toHaveBeenCalled();
  });
});
