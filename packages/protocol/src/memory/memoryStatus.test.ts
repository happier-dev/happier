import { describe, expect, it } from 'vitest';

import { MemoryStatusV1Schema } from './memoryStatus.js';

describe('MemoryStatusV1Schema', () => {
  it('parses daemon memory status payloads', () => {
    const parsed = MemoryStatusV1Schema.parse({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      hintsIndexReady: true,
      hintsIndexHasContent: true,
      deepIndexReady: true,
      deepIndexHasContent: true,
      activeIndexReady: true,
      activeIndexSearchable: true,
      embeddingsEnabled: true,
      embeddingsMode: 'preset',
      embeddingsPresetId: 'balanced',
      embeddingsProviderKind: 'local_transformers',
      embeddingsModelId: 'Xenova/all-MiniLM-L6-v2',
      embeddingsRuntimeState: 'ready',
      embeddingsUsingFallback: false,
      tier1DbPath: '/tmp/memory.sqlite',
      deepDbPath: '/tmp/deep.sqlite',
      tier1DbBytes: 123,
      deepDbBytes: 456,
      indexContent: {
        lightShardCount: 4,
        lightTermCount: 120,
        deepChunkCount: 8,
        deepEmbeddingCount: 7,
        searchableSessionCount: 3,
        lastIndexedAtMs: 1_000,
        latestIndexedMessageAtMs: 900,
      },
      worker: {
        state: 'indexing',
        lastTickAtMs: 2_000,
        lastInventoryAtMs: 1_500,
        currentSessionId: 'session_1',
        currentPhase: 'light',
      },
      queue: {
        selectedSessionCount: 12,
        queuedSessionCount: 2,
        indexingSessionCount: 1,
        indexedSessionCount: 7,
        emptySessionCount: 1,
        failedSessionCount: 1,
        waitingSessionCount: 0,
        oldestQueuedAtMs: 800,
      },
      lastRun: {
        startedAtMs: 1_000,
        finishedAtMs: 1_200,
        sessionsConsidered: 12,
        sessionsProcessed: 9,
        rawRowsFetched: 300,
        semanticRowsFound: 100,
        lightShardsCreated: 4,
        deepChunksCreated: 8,
        failures: 1,
        skipReasons: { no_semantic_rows: 1 },
      },
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('deep');
    expect(parsed.activeIndexReady).toBe(true);
    expect(parsed.activeIndexSearchable).toBe(true);
    expect(parsed.indexContent.searchableSessionCount).toBe(3);
    expect(parsed.worker.state).toBe('indexing');
    expect(parsed.queue.queuedSessionCount).toBe(2);
    expect(parsed.lastRun?.skipReasons.no_semantic_rows).toBe(1);
    expect(parsed.embeddingsEnabled).toBe(true);
    expect(parsed.embeddingsPresetId).toBe('balanced');
    expect(parsed.embeddingsRuntimeState).toBe('ready');
    expect(parsed.tier1DbBytes).toBe(123);
    expect(parsed.deepDbBytes).toBe(456);
  });

  it('accepts null db paths and sizes when indexes are absent', () => {
    const parsed = MemoryStatusV1Schema.parse({
      v: 1,
      enabled: false,
      indexMode: 'hints',
      hintsIndexReady: false,
      deepIndexReady: false,
      activeIndexReady: false,
      embeddingsEnabled: false,
      embeddingsMode: 'disabled',
      embeddingsPresetId: null,
      embeddingsProviderKind: null,
      embeddingsModelId: null,
      embeddingsRuntimeState: 'unavailable',
      embeddingsUsingFallback: false,
      tier1DbPath: null,
      deepDbPath: null,
      tier1DbBytes: null,
      deepDbBytes: null,
    });

    expect(parsed.enabled).toBe(false);
    expect(parsed.tier1DbPath).toBeNull();
    expect(parsed.deepDbBytes).toBeNull();
  });

  it('keeps missing runtime telemetry unknown instead of defaulting to zero counts', () => {
    const parsed = MemoryStatusV1Schema.parse({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      hintsIndexReady: true,
      deepIndexReady: false,
      activeIndexReady: true,
      embeddingsEnabled: false,
      embeddingsMode: 'disabled',
      embeddingsPresetId: null,
      embeddingsProviderKind: null,
      embeddingsModelId: null,
      embeddingsRuntimeState: 'unavailable',
      embeddingsUsingFallback: false,
      tier1DbPath: '/tmp/memory.sqlite',
      deepDbPath: null,
      tier1DbBytes: 16_384,
      deepDbBytes: null,
    });

    expect(parsed.hintsIndexReady).toBe(true);
    expect(parsed.hintsIndexHasContent).toBe(false);
    expect(parsed.activeIndexReady).toBe(true);
    expect(parsed.activeIndexSearchable).toBe(false);
    expect(parsed.indexContent).toBeNull();
    expect(parsed.worker).toBeNull();
    expect(parsed.queue).toBeNull();
    expect(parsed.lastRun).toBeNull();
  });

  it('requires explicit embeddings diagnostics fields', () => {
    expect(() => MemoryStatusV1Schema.parse({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      hintsIndexReady: true,
      deepIndexReady: true,
      activeIndexReady: true,
      embeddingsEnabled: true,
      tier1DbPath: '/tmp/memory.sqlite',
      deepDbPath: '/tmp/deep.sqlite',
      tier1DbBytes: 1,
      deepDbBytes: 2,
    })).toThrow();
  });
});
