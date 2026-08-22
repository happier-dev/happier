import { describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { waitForComposeRpcGatewayReadiness } from './waitForComposeRpcGatewayReadiness';

function createMockTestAuth() {
  const accountSigningSeed = new Uint8Array(32);
  return {
    token: 'token-1',
    publicKeyBase64: 'public-key',
    accountSigningSeed,
    accountMachineKey: deriveAccountMachineKeyFromRecoverySecret(accountSigningSeed),
  };
}

describe('waitForComposeRpcGatewayReadiness', () => {
  it('waits for the gateway rpc path and cleans up sockets on success', async () => {
    const ui = {
      connect: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
      rpcCall: vi.fn(),
    };
    const listener = {
      machineId: 'machine-1',
      socket: {
        connect: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async () => {}),
      },
    };
    const waitFor = vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
      expect(await predicate()).toBe(true);
    });
    const waitForRegisteredRpcMethod = vi.fn(async () => {});

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000 },
        {
          waitForOkHealth: vi.fn(async () => {}),
          createTestAuth: vi.fn(async () => createMockTestAuth()),
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector: vi.fn(() => ui as never),
          createMachineBoundSessionScopedSocketCollector: vi.fn(async () => listener as never),
          waitFor,
          waitForRegisteredRpcMethod,
        },
      ),
    ).resolves.toBeUndefined();

    expect(listener.socket.rpcRegister).toHaveBeenCalledWith('session-1:stress.rpc.gateway-readiness');
    expect(waitForRegisteredRpcMethod).toHaveBeenCalledWith({
      ui,
      method: 'session-1:stress.rpc.gateway-readiness',
      expectedMachineId: 'machine-1',
      timeoutMs: 5_000,
    });
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(listener.socket.close).toHaveBeenCalledTimes(1);
  });

  it('still closes sockets when the readiness probe fails', async () => {
    const ui = {
      connect: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
      rpcCall: vi.fn(),
    };
    const listener = {
      machineId: 'machine-1',
      socket: {
        connect: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async () => {}),
      },
    };

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000 },
        {
          waitForOkHealth: vi.fn(async () => {}),
          createTestAuth: vi.fn(async () => createMockTestAuth()),
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector: vi.fn(() => ui as never),
          createMachineBoundSessionScopedSocketCollector: vi.fn(async () => listener as never),
          waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
            await predicate();
          }),
          waitForRegisteredRpcMethod: vi.fn(async () => {
            throw new Error('gateway not ready');
          }),
        },
      ),
    ).rejects.toThrow('gateway not ready');

    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(listener.socket.close).toHaveBeenCalledTimes(1);
  });

  it('retries the readiness probe when an allowed second attempt succeeds', async () => {
    const firstUi = {
      connect: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
      rpcCall: vi.fn(),
    };
    const secondUi = {
      connect: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
      rpcCall: vi.fn(),
    };
    const firstListener = {
      machineId: 'machine-1',
      socket: {
        connect: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async () => {}),
      },
    };
    const secondListener = {
      machineId: 'machine-2',
      socket: {
        connect: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async () => {}),
      },
    };
    const waitForRegisteredRpcMethod = vi.fn()
      .mockRejectedValueOnce(new Error('not ready yet'))
      .mockResolvedValueOnce(undefined);
    const createUserScopedSocketCollector = vi.fn()
      .mockReturnValueOnce(firstUi as never)
      .mockReturnValueOnce(secondUi as never);
    const createMachineBoundSessionScopedSocketCollector = vi.fn()
      .mockResolvedValueOnce(firstListener as never)
      .mockResolvedValueOnce(secondListener as never);

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000, attempts: 2, retryDelayMs: 0 },
        {
          waitForOkHealth: vi.fn(async () => {}),
          createTestAuth: vi.fn(async () => createMockTestAuth()),
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector,
          createMachineBoundSessionScopedSocketCollector,
          waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
            await predicate();
          }),
          waitForRegisteredRpcMethod,
        },
      ),
    ).resolves.toBeUndefined();

    expect(waitForRegisteredRpcMethod).toHaveBeenCalledTimes(2);
    expect(firstUi.close).toHaveBeenCalledTimes(1);
    expect(firstListener.socket.close).toHaveBeenCalledTimes(1);
    expect(secondUi.close).toHaveBeenCalledTimes(1);
    expect(secondListener.socket.close).toHaveBeenCalledTimes(1);
  });

  it('retries when the initial auth probe fails during gateway restart', async () => {
    const ui = {
      connect: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
      rpcCall: vi.fn(),
    };
    const listener = {
      machineId: 'machine-1',
      socket: {
        connect: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async () => {}),
      },
    };
    const createTestAuth = vi.fn()
      .mockRejectedValueOnce(new Error('gateway restarting'))
      .mockResolvedValueOnce(createMockTestAuth());

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000, attempts: 2, retryDelayMs: 0 },
        {
          waitForOkHealth: vi.fn(async () => {}),
          createTestAuth,
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector: vi.fn(() => ui as never),
          createMachineBoundSessionScopedSocketCollector: vi.fn(async () => listener as never),
          waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
            await predicate();
          }),
          waitForRegisteredRpcMethod: vi.fn(async () => {}),
        },
      ),
    ).resolves.toBeUndefined();

    expect(createTestAuth).toHaveBeenCalledTimes(2);
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(listener.socket.close).toHaveBeenCalledTimes(1);
  });

  it('waits for read-only gateway health before making one authenticated request', async () => {
    const ui = {
      connect: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
      rpcCall: vi.fn(),
    };
    const listener = {
      machineId: 'machine-1',
      socket: {
        connect: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async () => {}),
      },
    };
    let gatewayReady = false;
    const waitForOkHealth = vi.fn(async () => {
      gatewayReady = true;
    });
    const createTestAuth = vi.fn(async () => {
      if (!gatewayReady) {
        throw new TypeError('fetch failed');
      }
      return createMockTestAuth();
    });

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000, attempts: 1 },
        {
          waitForOkHealth,
          createTestAuth,
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector: vi.fn(() => ui as never),
          createMachineBoundSessionScopedSocketCollector: vi.fn(async () => listener as never),
          waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
            await predicate();
          }),
          waitForRegisteredRpcMethod: vi.fn(async () => {}),
        },
      ),
    ).resolves.toBeUndefined();

    expect(waitForOkHealth).toHaveBeenCalledWith(
      'http://127.0.0.1:43080',
      { timeoutMs: 5_000 },
    );
    expect(waitForOkHealth.mock.invocationCallOrder[0]).toBeLessThan(
      createTestAuth.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(createTestAuth).toHaveBeenCalledTimes(1);
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(listener.socket.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a permanent authenticated-request failure without polling it', async () => {
    const createTestAuth = vi.fn(async () => {
      throw new Error('Failed to create test auth token (status=403)');
    });

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000, attempts: 1 },
        {
          waitForOkHealth: vi.fn(async () => {}),
          createTestAuth,
          createSession: vi.fn(),
          createUserScopedSocketCollector: vi.fn(),
          createMachineBoundSessionScopedSocketCollector: vi.fn(),
          waitFor: vi.fn(),
          waitForRegisteredRpcMethod: vi.fn(),
        },
      ),
    ).rejects.toThrow('Failed to create test auth token (status=403)');

    expect(createTestAuth).toHaveBeenCalledTimes(1);
  });
});
