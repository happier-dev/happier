import { describe, expect, it, vi } from 'vitest';

import type { MachineRpcHandlers } from './rpcHandlers';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

describe('registerMachineRpcHandlers SSH tunnel boundary', () => {
  it('does not register local SSH tunnel lifecycle on machine RPC even when a local supervisor exists', async () => {
    const { registerMachineRpcHandlers } = await import('./rpcHandlers');
    const registered = new Set<string>();
    const rpcHandlerManager = {
      registerHandler: (method: string) => {
        registered.add(method);
      },
    } as unknown as RpcHandlerManager;
    const handlers: MachineRpcHandlers & Readonly<{ sshTunnelSupervisor: unknown }> = {
      spawnSession: vi.fn(),
      stopSession: vi.fn(),
      requestShutdown: vi.fn(),
      sshTunnelSupervisor: {
        ensureTunnel: vi.fn(),
        listTunnels: vi.fn(),
        probeTunnel: vi.fn(),
        releaseTunnel: vi.fn(),
        stopTunnel: vi.fn(),
      },
    };

    registerMachineRpcHandlers({ rpcHandlerManager, handlers });

    expect([...registered].filter((method) => method.includes('sshTunnels'))).toEqual([]);
  });
});
