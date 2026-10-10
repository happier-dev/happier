import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';

describe('installed handoff capability publication', () => {
  it.each([
    { peer: false, bootstrap: false, enabled: false },
    { peer: true, bootstrap: false, enabled: false },
    { peer: true, bootstrap: true, enabled: true },
  ])('advertises existing state only with admitted peer transport and bootstrap: $enabled', async ({ peer, bootstrap, enabled }) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-capability-'));
    try {
      const manager = new RpcHandlerManager({ scopePrefix: 'target', localMachineId: 'target', encryptionMode: 'plain',
        // Home transport admission is the external boundary; all registered handoff logic remains real.
        authorizeRequest: async () => ({ ok: true }), logger: () => undefined });
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager: manager, runtimeConfig: { activeServerDir },
        ...(peer ? { admitExistingSessionState: async () => null } : {}),
        ...(bootstrap ? { requesterBootstrapBoundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.invalid',
            happyHomeDir: activeServerDir, getObservedServerIdentityId: () => 'home' } } : {}) });
      expect(await manager.handleRequest({ method: `target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`, params: {} }))
        .toMatchObject({ protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, sameMachineHandoff: true, existingState: enabled });
      expect(await manager.handleRequest({ method: `target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET}`, params: {} }))
        .toEqual({ protocolVersion: 2, atomicTargetResume: false, targetCleanup: false });
      expect(await manager.handleRequest({ method: `target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`,
        params: { sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/target',
          sourceSessionStorageMode: 'persisted' } }))
        .toMatchObject({ protocolVersion: 3, existingState: enabled });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
