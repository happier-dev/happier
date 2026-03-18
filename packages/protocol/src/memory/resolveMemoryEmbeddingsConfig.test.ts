import { describe, expect, it } from 'vitest';

import { resolveMemoryEmbeddingsConfig } from './resolveMemoryEmbeddingsConfig.js';

describe('resolveMemoryEmbeddingsConfig', () => {
  it('returns a disabled config for disabled mode', () => {
    const parsed = resolveMemoryEmbeddingsConfig({
      mode: 'disabled',
      presetId: 'balanced',
      custom: null,
      blend: { ftsWeight: 0.2, embeddingWeight: 0.8 },
    });

    expect(parsed.enabled).toBe(false);
    expect(parsed.profile).toBeNull();
    expect(parsed.provider).toBeNull();
    expect(parsed.blend).toEqual({ ftsWeight: 0.2, embeddingWeight: 0.8 });
  });

  it('resolves preset mode to profile metadata', () => {
    const parsed = resolveMemoryEmbeddingsConfig({
      mode: 'preset',
      presetId: 'long_context',
      custom: null,
      blend: undefined,
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.profile?.id).toBe('long_context');
    expect(parsed.provider?.kind).toBe('local_transformers');
  });

  it('resolves custom mode to the custom provider config', () => {
    const parsed = resolveMemoryEmbeddingsConfig({
      mode: 'custom',
      presetId: 'balanced',
      custom: {
        kind: 'openai_compatible',
        baseUrl: 'https://api.example.com',
        apiKey: null,
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      blend: { ftsWeight: 0.5, embeddingWeight: 0.5 },
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.profile).toBeNull();
    expect(parsed.provider?.kind).toBe('openai_compatible');
  });
});
