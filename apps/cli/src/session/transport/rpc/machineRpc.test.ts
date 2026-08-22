import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';

const socket = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  close: vi.fn(),
  emit: vi.fn(),
};
const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('@/api/session/sockets', () => ({ createUserScopedSocket: vi.fn(() => socket) }));
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

import { callMachineRpc, readMachineRpcRequestDisposition } from './machineRpc';

describe('callMachineRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          id: 'machine-session',
          dataEncryptionKey: 'encrypted-machine-key',
        },
      },
    });
  });

  it('encrypts and sends one account-scoped call to only the requested machine', async () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
    };
    socket.emit.mockImplementation((_event, payload, callback) => {
      expect(payload.method).toBe('machine-session:spawn-happy-session');
      expect(payload.authorization).toEqual({
        kind: 'session.write',
        sessionId: 'session-1',
      });
      expect(decrypt(machineKey, 'dataKey', decodeBase64(payload.params, 'base64'))).toEqual({ sessionId: 'session-1' });
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
      authorization: {
        kind: 'session.write',
        sessionId: 'session-1',
      },
      timeoutMs: 100,
    })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
    expect(socket.emit).toHaveBeenCalledTimes(1);
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
