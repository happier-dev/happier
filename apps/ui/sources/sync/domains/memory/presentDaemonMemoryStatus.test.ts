import { describe, expect, it } from 'vitest';
import type { MemoryStatusV1 } from '@happier-dev/protocol';

import { presentDaemonMemoryStatus } from './presentDaemonMemoryStatus';

function buildStatus(overrides: Record<string, unknown> = {}): MemoryStatusV1 {
  return {
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
    tier1DbBytes: 512,
    deepDbBytes: null,
    ...overrides,
  } as MemoryStatusV1;
}

describe('presentDaemonMemoryStatus', () => {
  it('presents schema-only indexes as empty instead of ready', () => {
    expect(presentDaemonMemoryStatus(buildStatus({
      activeIndexReady: true,
      activeIndexSearchable: false,
      indexContent: {
        lightShardCount: 0,
        lightTermCount: 0,
        deepChunkCount: 0,
        deepEmbeddingCount: 0,
        searchableSessionCount: 0,
        lastIndexedAtMs: null,
        latestIndexedMessageAtMs: null,
      },
    }))?.state).toBe('empty');
  });

  it('presents active worker progress before ready content', () => {
    expect(presentDaemonMemoryStatus(buildStatus({
      activeIndexSearchable: true,
      indexContent: {
        lightShardCount: 4,
        lightTermCount: 40,
        deepChunkCount: 0,
        deepEmbeddingCount: 0,
        searchableSessionCount: 2,
        lastIndexedAtMs: 1,
        latestIndexedMessageAtMs: 1,
      },
      worker: {
        state: 'indexing',
        lastTickAtMs: 2,
        lastInventoryAtMs: 1,
        currentSessionId: 'sess_1',
        currentPhase: 'backfill',
      },
    }))?.state).toBe('indexing');
  });

  it('keeps missing telemetry as unavailable instead of empty or ready', () => {
    expect(presentDaemonMemoryStatus(buildStatus({
      activeIndexReady: true,
    }))?.state).toBe('unavailable_light');
  });

  it('treats explicit unsearchable readiness as authoritative', () => {
    expect(presentDaemonMemoryStatus(buildStatus({
      activeIndexSearchable: false,
      indexContent: {
        lightShardCount: 4,
        lightTermCount: 40,
        deepChunkCount: 0,
        deepEmbeddingCount: 0,
        searchableSessionCount: 2,
        lastIndexedAtMs: 1,
        latestIndexedMessageAtMs: 1,
      },
    }))?.state).toBe('unavailable_light');
  });

  it('formats disk usage without rounding small indexes to zero MB', () => {
    const presentation = presentDaemonMemoryStatus(buildStatus({
      tier1DbBytes: 512,
      deepDbBytes: 1536,
    }));

    expect(presentation?.lightSize).toBe('512 B');
    expect(presentation?.deepSize).toBe('1.5 KB');
  });
});
