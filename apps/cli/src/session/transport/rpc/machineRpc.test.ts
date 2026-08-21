import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';

const socket = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  close: vi.fn(),
  emit: vi.fn(),
};
const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocket: vi.fn(() => socket),
}));
vi.mock('@/session/transport/socket/waitForSocketConnect', () => ({
  waitForSocketConnect: vi.fn(async () => undefined),
}));
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

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

import { callMachineRpc } from './machineRpc';

describe('callMachineRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encrypts and sends exactly one account-scoped call to the requested machine', async () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
    };
    socket.emit.mockImplementation((_event, payload, callback) => {
      expect(payload.method).toBe('machine-session:spawn-happy-session');
      expect(decrypt(machineKey, 'dataKey', decodeBase64(payload.params, 'base64'))).toEqual({ sessionId: 'session-1' });
      expect(payload.authorization).toEqual({ kind: 'session.write', sessionId: 'session-1' });
      callback({
        ok: true,
        result: encodeBase64(encrypt(machineKey, 'dataKey', { type: 'success', sessionId: 'session-1' })),
      });
    });

    await expect(callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: { sessionId: 'session-1' },
      authorization: { kind: 'session.write', sessionId: 'session-1' },
      timeoutMs: 100,
    })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    // A reached machine never pays for the replacement chain.
    expect(axiosGet).not.toHaveBeenCalled();
  });

  /**
   * A user who replaces a machine keeps the Sessions the previous one hosted.
   * Nothing re-homes those rows, so a CLI/MCP send or resume still addresses the
   * PREDECESSOR; reaching the successor is what makes the replacement usable.
   */
  describe('replaced machine', () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
    };

    function mockChainRead(machines: ReadonlyArray<Record<string, unknown>>): void {
      axiosGet.mockImplementation(async (url: unknown) => {
        expect(String(url)).toMatch(/\/v1\/machines$/);
        return { data: machines };
      });
    }

    function unreachable() {
      return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    it('reaches the successor when the addressed machine was replaced', async () => {
      mockChainRead([
        { id: 'machine-old', replacedByMachineId: 'machine-mid' },
        { id: 'machine-mid', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, payload, callback) => {
        if (payload.method !== 'machine-new:status') {
          callback(unreachable());
          return;
        }
        callback({ ok: true, result: encodeBase64(encrypt(machineKey, 'dataKey', { status: 'running' })) });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });

      // Exactly one retry, addressed to the end of the replacement chain.
      expect(socket.emit).toHaveBeenCalledTimes(2);
      expect(socket.emit.mock.calls[0]?.[1]?.method).toBe('machine-old:status');
      expect(socket.emit.mock.calls[1]?.[1]?.method).toBe('machine-new:status');
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original error unchanged when the machine has no successor', async () => {
      mockChainRead([{ id: 'machine-old', replacedByMachineId: null }]);
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

    it('surfaces the original error when the replacement chain cannot be read', async () => {
      axiosGet.mockRejectedValue(new Error('chain lookup failed'));
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
      mockChainRead([
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

      // A successor EXISTS and is still not used: re-running an answered call
      // against a different machine would be a correctness bug.
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it('never re-addresses a call whose outcome is unknown', async () => {
      mockChainRead([
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
      expect(axiosGet).not.toHaveBeenCalled();
    });
  });
});
