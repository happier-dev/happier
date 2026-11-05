import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MemoryStatusV1Schema } from '@happier-dev/protocol';

import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';

describe('rpcHandlers.memory (status)', () => {
  it('does not mark an empty schema database as searchable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-status-empty-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const { openSummaryShardIndexDb } = await import('@/daemon/memory/summaryShardIndexDb');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      tier1.close();

      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          handlers.set(method, handler);
        },
      } as any;

      registerMachineMemoryRpcHandlers({
        rpcHandlerManager,
        memoryWorker: {
          stop: () => {},
          waitForReady: async () => {},
          reloadSettings: async () => {},
          ensureUpToDate: async () => {},
          getEmbeddingsDiagnostics: () => ({
            mode: 'disabled',
            presetId: null,
            providerKind: null,
            modelId: null,
            runtimeState: 'unavailable',
            usingFallback: false,
          }),
          getWorkerStatus: () => ({
            state: 'idle',
            lastTickAtMs: null,
            lastInventoryAtMs: null,
            currentSessionId: null,
            currentPhase: null,
          }),
          getSettings: () => ({
            v: 1,
            enabled: true,
            indexMode: 'hints' as const,
            embeddings: { mode: 'disabled', presetId: 'balanced', custom: null, blend: { ftsWeight: 0.7, embeddingWeight: 0.3 } },
          }),
          getTier1DbPath: () => tier1Path,
          getDeepDbPath: () => null,
        } as any,
      });

      const handler = handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS);
      const out = MemoryStatusV1Schema.parse(await handler!(null));
      expect(out.activeIndexReady).toBe(true);
      expect((out as unknown as { activeIndexSearchable?: boolean }).activeIndexSearchable).toBe(false);
      expect((out as unknown as { hintsIndexHasContent?: boolean }).hintsIndexHasContent).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns db paths and sizes when available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-status-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      await writeFile(tier1Path, Buffer.from('hello'), 'utf8');
      await writeFile(deepPath, Buffer.from('worldworld'), 'utf8');
      await writeFile(`${tier1Path}-wal`, Buffer.alloc(7));
      await writeFile(`${tier1Path}-shm`, Buffer.alloc(11));
      await writeFile(`${deepPath}-wal`, Buffer.alloc(13));
      await writeFile(`${deepPath}-shm`, Buffer.alloc(17));

      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          handlers.set(method, handler);
        },
      } as any;

      const memoryWorker = {
        stop: () => {},
        waitForReady: async () => {},
        reloadSettings: async () => {},
        ensureUpToDate: async () => {},
        getEmbeddingsDiagnostics: () => ({
          mode: 'preset',
          presetId: 'balanced',
          providerKind: 'local_transformers',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          runtimeState: 'ready',
          usingFallback: false,
        }),
        getWorkerStatus: () => ({
          state: 'idle',
          lastTickAtMs: null,
          lastInventoryAtMs: null,
          currentSessionId: null,
          currentPhase: null,
        }),
        getSettings: () => ({
          v: 1,
          enabled: true,
          indexMode: 'deep' as const,
          embeddings: { mode: 'preset', presetId: 'balanced', custom: null, blend: { ftsWeight: 0.7, embeddingWeight: 0.3 } },
        }),
        getTier1DbPath: () => tier1Path,
        getDeepDbPath: () => deepPath,
      };

      registerMachineMemoryRpcHandlers({
        rpcHandlerManager,
        memoryWorker: memoryWorker as any,
      });

      const handler = handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS);
      expect(handler).toBeTruthy();
      const out = MemoryStatusV1Schema.parse(await handler!(null));

      expect(out.enabled).toBe(true);
      expect(out.indexMode).toBe('deep');
      expect(out.hintsIndexReady).toBe(true);
      expect(out.deepIndexReady).toBe(true);
      expect(out.activeIndexReady).toBe(true);
      expect(out.embeddingsEnabled).toBe(true);
      expect(out.embeddingsMode).toBe('preset');
      expect(out.embeddingsPresetId).toBe('balanced');
      expect(out.embeddingsProviderKind).toBe('local_transformers');
      expect(out.embeddingsModelId).toBe('Xenova/all-MiniLM-L6-v2');
      expect(out.embeddingsRuntimeState).toBe('ready');
      expect(out.embeddingsUsingFallback).toBe(false);
      expect(out.tier1DbPath).toBe(tier1Path);
      expect(out.deepDbPath).toBe(deepPath);
      expect(out.tier1DbBytes).toBeGreaterThan(5);
      expect(out.deepDbBytes).toBeGreaterThan(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('measures canonical sqlite files after worker handles are closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-status-closed-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      await writeFile(tier1Path, Buffer.alloc(5));
      await writeFile(`${tier1Path}-wal`, Buffer.alloc(7));
      await writeFile(`${tier1Path}-shm`, Buffer.alloc(11));
      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      registerMachineMemoryRpcHandlers({
        rpcHandlerManager: { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => handlers.set(method, handler) } as any,
        memoryWorker: {
          waitForReady: async () => {},
          getSettings: () => ({ v: 1, enabled: false, indexMode: 'hints', embeddings: { mode: 'disabled', presetId: 'balanced', custom: null, blend: { ftsWeight: 0.7, embeddingWeight: 0.3 } } }),
          getEmbeddingsDiagnostics: () => ({ mode: 'disabled', presetId: null, providerKind: null, modelId: null, runtimeState: 'unavailable', usingFallback: false }),
          getWorkerStatus: () => ({ state: 'disabled', lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: null, currentPhase: null }),
          getTier1DbPath: () => null,
          getDeepDbPath: () => null,
          getTier1DbPhysicalPath: () => tier1Path,
          getDeepDbPhysicalPath: () => join(dir, 'deep.sqlite'),
        } as any,
      });
      const out = MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!(null));
      expect(out.tier1DbPath).toBeNull();
      expect(out.tier1DbBytes).toBe(23);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('advertises the archived eligibility this daemon actually applies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-status-archived-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      await writeFile(tier1Path, Buffer.from('hello'), 'utf8');

      const readStatusFor = async (includeArchivedSessions: boolean) => {
        const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        registerMachineMemoryRpcHandlers({
          rpcHandlerManager: {
            registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
              handlers.set(method, handler);
            },
          } as any,
          memoryWorker: {
            stop: () => {},
            waitForReady: async () => {},
            reloadSettings: async () => {},
            ensureUpToDate: async () => {},
            removeSessions: async () => {},
            applySessionArchivedState: async () => {},
            getEmbeddingsDiagnostics: () => ({
              mode: 'disabled',
              presetId: null,
              providerKind: null,
              modelId: null,
              runtimeState: 'unavailable',
              usingFallback: false,
            }),
            getWorkerStatus: () => ({
              state: 'idle',
              lastTickAtMs: null,
              lastInventoryAtMs: null,
              currentSessionId: null,
              currentPhase: null,
            }),
            getSettings: () => ({
              v: 1,
              enabled: true,
              indexMode: 'hints' as const,
              includeArchivedSessions,
              embeddings: { mode: 'disabled', presetId: 'balanced', custom: null, blend: { ftsWeight: 0.7, embeddingWeight: 0.3 } },
            }),
            getTier1DbPath: () => tier1Path,
            getDeepDbPath: () => null,
          } as any,
        });
        return MemoryStatusV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MEMORY_STATUS)!(null));
      };

      expect((await readStatusFor(false)).includeArchivedSessionsEffective).toBe(false);
      expect((await readStatusFor(true)).includeArchivedSessionsEffective).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
