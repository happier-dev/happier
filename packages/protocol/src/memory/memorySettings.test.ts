import { describe, expect, it } from 'vitest';

import { DEFAULT_MEMORY_SETTINGS, MemorySettingsV1Schema, normalizeMemorySettings } from './memorySettings.js';

describe('memorySettings', () => {
  it('normalizes invalid payloads to defaults', () => {
    expect(normalizeMemorySettings({ v: 999, enabled: 'nope' } as any)).toEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it('parses a minimal v1 settings object', () => {
    const parsed = MemorySettingsV1Schema.parse({ v: 1, enabled: true });
    expect(parsed.v).toBe(1);
    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('hints');
  });

  it('migrates legacy balanced embeddings settings into preset mode', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      enabled: true,
      embeddings: {
        enabled: true,
        provider: 'local_transformers',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        wFts: 0.7,
        wEmb: 0.3,
      },
    });

    expect(parsed.embeddings.mode).toBe('preset');
    expect(parsed.embeddings.presetId).toBe('balanced');
    expect(parsed.embeddings.blend).toEqual({ ftsWeight: 0.7, embeddingWeight: 0.3 });
  });

  it('migrates legacy custom local embeddings settings into custom provider mode', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      enabled: true,
      embeddings: {
        enabled: true,
        provider: 'local_transformers',
        modelId: 'Xenova/custom-model',
        wFts: 0.2,
        wEmb: 0.8,
      },
    });

    expect(parsed.embeddings.mode).toBe('custom');
    expect(parsed.embeddings.custom).toEqual({
      kind: 'local_transformers',
      modelId: 'Xenova/custom-model',
      queryPrefix: null,
      documentPrefix: null,
    });
    expect(parsed.embeddings.blend).toEqual({ ftsWeight: 0.2, embeddingWeight: 0.8 });
  });
});
