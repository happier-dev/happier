import { describe, expect, it } from 'vitest';

import { MemoryStatusV1Schema } from './memoryStatus.js';

describe('MemoryStatusV1Schema', () => {
  it('accepts a status payload for a ready preset-backed index', () => {
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
      tier1DbPath: '/tmp/tier1.sqlite',
      deepDbPath: '/tmp/deep.sqlite',
      tier1DbBytes: 1024,
      deepDbBytes: 2048,
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.embeddingsPresetId).toBe('balanced');
  });

  it('rejects invalid runtime states', () => {
    const parsed = MemoryStatusV1Schema.safeParse({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      hintsIndexReady: false,
      deepIndexReady: false,
      activeIndexReady: false,
      embeddingsEnabled: false,
      embeddingsMode: 'disabled',
      embeddingsPresetId: null,
      embeddingsProviderKind: null,
      embeddingsModelId: null,
      embeddingsRuntimeState: 'broken',
      embeddingsUsingFallback: false,
      tier1DbPath: null,
      deepDbPath: null,
      tier1DbBytes: null,
      deepDbBytes: null,
    });

    expect(parsed.success).toBe(false);
  });
});
