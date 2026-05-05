import { describe, expect, it } from 'vitest';

import { PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol';

import { registerMachineRpcHandlers } from './rpcHandlers';

describe('registerMachineRpcHandlers pets', () => {
  it('registers daemon pet RPC handlers', () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    registerMachineRpcHandlers({
      rpcHandlerManager: {
        registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
          handlers.set(method, handler);
        },
      } as any,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(handlers.has('pets.discoverPackages')).toBe(true);
    expect(handlers.has(PET_DAEMON_RPC_METHODS.DISCOVER_PACKAGES)).toBe(true);
    expect(handlers.has(PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE)).toBe(true);
    expect(handlers.has('pets.importLocalPackage')).toBe(true);
    expect(handlers.has(PET_DAEMON_RPC_METHODS.IMPORT_LOCAL_PACKAGE)).toBe(true);
    expect(handlers.has(PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE)).toBe(true);
    expect(handlers.has('pets.forgetLocalPackage')).toBe(true);
    expect(handlers.has(PET_DAEMON_RPC_METHODS.FORGET_LOCAL_PACKAGE)).toBe(true);
    expect(handlers.has('pets.readPreviewAsset')).toBe(true);
    expect(handlers.has(PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET)).toBe(true);
  });
});
