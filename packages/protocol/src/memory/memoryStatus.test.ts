import { describe, expect, it } from 'vitest';

import { MemoryStatusV1Schema } from './memoryStatus.js';

describe('MemoryStatusV1Schema', () => {
  it('parses daemon memory status payloads', () => {
    const parsed = MemoryStatusV1Schema.parse({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      hintsIndexReady: true,
      deepIndexReady: true,
      activeIndexReady: true,
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
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('deep');
    expect(parsed.activeIndexReady).toBe(true);
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
