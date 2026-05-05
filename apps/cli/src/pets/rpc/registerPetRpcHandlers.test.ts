import { describe, expect, it } from 'vitest';

import { PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol';

describe('registerPetRpcHandlers', () => {
  it('applies the async companion feature resolver through every registered daemon RPC handler', async () => {
    const { createRpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    const { registerPetRpcHandlers } = await import('./registerPetRpcHandlers');
    const rpcHandlerManager = createRpcHandlerManager({
      scopePrefix: 'machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
    });

    registerPetRpcHandlers({
      rpcHandlerManager,
      resolveCompanionFeatureEnabled: async () => false,
    });

    for (const method of Object.values(PET_DAEMON_RPC_METHODS)) {
      await expect(rpcHandlerManager.invokeLocal(method, {})).resolves.toMatchObject({
        ok: false,
        errorCode: 'feature_disabled',
      });
    }
  });
});
