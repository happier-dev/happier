import { describe, expect, it } from 'vitest';

import { resolveMemoryEmbeddingsConfig } from './resolveMemoryEmbeddingsConfig.js';

describe('resolveMemoryEmbeddingsConfig', () => {
  it('resolves the long_context preset to the jina local model', () => {
    const resolved = resolveMemoryEmbeddingsConfig({
      mode: 'preset',
      presetId: 'long_context',
      custom: null,
      blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
    });

    expect(resolved.provider.kind).toBe('local_transformers');
    if (resolved.provider.kind !== 'local_transformers') return;
    expect(resolved.provider.modelId).toBe('Xenova/jina-embeddings-v2-small-en');
    expect(resolved.profile.id).toBe('long_context');
  });

  it('returns disabled when embeddings mode is disabled', () => {
    const resolved = resolveMemoryEmbeddingsConfig({
      mode: 'disabled',
      presetId: 'balanced',
      custom: null,
      blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.provider).toBeNull();
  });
});
