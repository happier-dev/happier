import { describe, expect, it } from 'vitest';

import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol';
import type { Machine } from '@/api/types';

import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

describe('ApiMachineClient action operation handlers', () => {
  it('registers every additive v1 operation method at the canonical machine RPC boundary', () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    const client = new ApiMachineClient('token', machine);
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    for (const method of Object.values(ACTION_OPERATION_RPC_METHODS_V1)) {
      expect(rpcHandlerManager.hasHandler(method), method).toBe(true);
    }
  });
});
