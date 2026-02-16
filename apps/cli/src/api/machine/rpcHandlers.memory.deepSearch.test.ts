import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { openDeepIndexDb } from '@/daemon/memory/deepIndex/deepIndexDb';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';

describe('rpcHandlers.memory (deep search routing)', () => {
  it('routes deep mode queries to the deep index when available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-deep-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'We discussed Openclaw and deep memory search.',
      });
      db.close();

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
        getSettings: () => ({
          v: 1,
          enabled: true,
          indexMode: 'deep' as const,
          defaultScope: { type: 'global' as const },
          backfillPolicy: 'new_only' as const,
          deleteOnDisable: false,
          hints: {
            summarizerBackendId: 'claude',
            summarizerModelId: 'default',
            summarizerPermissionMode: 'no_tools',
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            paddingMessagesOnVerify: 8,
            updateMode: 'onIdle',
            idleDelayMs: 15_000,
            maxRunsPerHour: 12,
            failureBackoffBaseMs: 60_000,
            failureBackoffMaxMs: 3_600_000,
            maxShardsPerSession: 250,
            maxKeywords: 12,
            maxEntities: 12,
            maxDecisions: 12,
          },
          deep: {
            recentDays: 30,
            maxChunkChars: 12_000,
            maxChunkMessages: 50,
            minChunkMessages: 5,
            includeAssistantAcpMessage: true,
            includeToolOutput: false,
            candidateLimit: 200,
            previewChars: 240,
            failureBackoffBaseMs: 60_000,
            failureBackoffMaxMs: 3_600_000,
          },
          embeddings: {
            enabled: false,
            provider: 'local_transformers',
            modelId: 'Xenova/all-MiniLM-L6-v2',
            wFts: 0.7,
            wEmb: 0.3,
          },
          budgets: { maxDiskMbLight: 250, maxDiskMbDeep: 1500 },
          worker: {
            tickIntervalMs: 10_000,
            inventoryRefreshIntervalMs: 60_000,
            maxSessionsPerTick: 2,
            sessionListPageLimit: 50,
          },
        } as const),
        getTier1DbPath: () => null,
        getDeepDbPath: () => dbPath,
      };

      registerMachineMemoryRpcHandlers({
        rpcHandlerManager,
        memoryWorker,
      });

      const handler = handlers.get(RPC_METHODS.DAEMON_MEMORY_SEARCH);
      expect(handler).toBeTruthy();

      const res = await handler!({ v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep' });
      const out = res as any;
      expect(out.ok).toBe(true);
      expect(out.hits?.[0]?.sessionId).toBe('s1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
