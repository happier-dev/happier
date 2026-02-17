import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';

describe('rpcHandlers.memory (status)', () => {
  it('returns db paths and sizes when available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-status-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      await writeFile(tier1Path, Buffer.from('hello'), 'utf8');
      await writeFile(deepPath, Buffer.from('worldworld'), 'utf8');

      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          handlers.set(method, handler);
        },
      } as any;

      const memoryWorker = {
        stop: () => {},
        reloadSettings: async () => {},
        ensureUpToDate: async () => {},
        getSettings: () => ({ v: 1, enabled: true, indexMode: 'deep' as const }),
        getTier1DbPath: () => tier1Path,
        getDeepDbPath: () => deepPath,
      };

      registerMachineMemoryRpcHandlers({
        rpcHandlerManager,
        memoryWorker: memoryWorker as any,
      });

      const handler = handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS);
      expect(handler).toBeTruthy();
      const out = (await handler!(null)) as any;

      expect(out.enabled).toBe(true);
      expect(out.indexMode).toBe('deep');
      expect(out.tier1DbPath).toBe(tier1Path);
      expect(out.deepDbPath).toBe(deepPath);
      expect(out.tier1DbBytes).toBeGreaterThan(0);
      expect(out.deepDbBytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

