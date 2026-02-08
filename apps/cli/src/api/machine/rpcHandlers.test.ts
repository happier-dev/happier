import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerMachineRpcHandlers } from './rpcHandlers';

describe('registerMachineRpcHandlers', () => {
  it('normalizes empty modelId to undefined when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      modelId: '',
      modelUpdatedAt: 123,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, modelUpdatedAt: 123 }));
  });

  it('normalizes whitespace-only modelId to undefined when resuming a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      directory: '/tmp',
      sessionId: 'sess_old',
      agent: 'claude',
      sessionEncryptionKeyBase64: 'k',
      sessionEncryptionVariant: 'dataKey',
      modelId: '   ',
      modelUpdatedAt: 456,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, modelUpdatedAt: 456 }));
  });
});
