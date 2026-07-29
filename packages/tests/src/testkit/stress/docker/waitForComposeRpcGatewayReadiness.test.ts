import { describe, expect, it, vi } from 'vitest';

import { waitForComposeRpcGatewayReadiness } from './waitForComposeRpcGatewayReadiness';

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
          createTestAuth: vi.fn(async () => ({
            token: 'token-1',
            publicKeyBase64: 'public-key',
            accountSigningSeed: new Uint8Array(32),
          })),
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
          createTestAuth: vi.fn(async () => ({
            token: 'token-1',
            publicKeyBase64: 'public-key',
            accountSigningSeed: new Uint8Array(32),
          })),
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector: vi.fn(() => ui as never),
          createMachineBoundSessionScopedSocketCollector: vi.fn(async () => listener as never),
          waitFor: vi.fn(async () => {}),
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
          createTestAuth: vi.fn(async () => ({
            token: 'token-1',
            publicKeyBase64: 'public-key',
            accountSigningSeed: new Uint8Array(32),
          })),
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector,
          createMachineBoundSessionScopedSocketCollector,
          waitFor: vi.fn(async () => {}),
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
      .mockResolvedValueOnce({
        token: 'token-1',
        publicKeyBase64: 'public-key',
        accountSigningSeed: new Uint8Array(32),
      });

    await expect(
      waitForComposeRpcGatewayReadiness(
        { baseUrl: 'http://127.0.0.1:43080', timeoutMs: 5_000, attempts: 2, retryDelayMs: 0 },
        {
          createTestAuth,
          createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'session-1' })),
          createUserScopedSocketCollector: vi.fn(() => ui as never),
          createMachineBoundSessionScopedSocketCollector: vi.fn(async () => listener as never),
          waitFor: vi.fn(async () => {}),
          waitForRegisteredRpcMethod: vi.fn(async () => {}),
        },
      ),
    ).resolves.toBeUndefined();

    expect(createTestAuth).toHaveBeenCalledTimes(2);
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(listener.socket.close).toHaveBeenCalledTimes(1);
  });
});
