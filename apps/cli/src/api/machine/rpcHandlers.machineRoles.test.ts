import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { MACHINE_ROLE_RPC_NAMESPACES } from '@/daemon/roles/machineRoleRpcNamespaces';
import { registerMachineRpcHandlers } from './rpcHandlers';

describe('machine core RPC registration', () => {
  it('registers no method inside a Machine role namespace, even when the role worker handles are present', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    // Test fixture boundary: worker handles are opaque here; core registration must not consume them.
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
      spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable fixture Agent' }),
      stopSession: async () => true, requestShutdown: () => {},
      memory: { attachExternalObservation: () => () => {} } as never,
      voiceInference: {} as never,
    } as Parameters<typeof registerMachineRpcHandlers>[0]['handlers'] });
    try {
      const roleMethods = Object.values(RPC_METHODS).filter(method => Object.values(MACHINE_ROLE_RPC_NAMESPACES)
        .some(namespaces => namespaces.some(prefix => method.startsWith(prefix))));
      expect(roleMethods.length).toBeGreaterThan(0);
      expect(roleMethods.filter(method => manager.hasHandler(method))).toEqual([]);
    } finally {
      await registration.dispose();
    }
  });
});
