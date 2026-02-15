import { describe, expect, it } from 'vitest';

import { getKokoroAssetSetOptions, resolveKokoroRuntimeConfig } from '@/voice/kokoro/assets/kokoroAssetSets';

describe('kokoroAssetSets', () => {
  it('resolves env-default config when no assetSetId is selected', () => {
    const config = resolveKokoroRuntimeConfig({
      assetSetId: null,
      env: {
        EXPO_PUBLIC_KOKORO_MODEL_ID: 'example/model',
        EXPO_PUBLIC_KOKORO_DTYPE: 'q8',
        EXPO_PUBLIC_KOKORO_DEVICE: 'wasm',
        EXPO_PUBLIC_KOKORO_WASM_PATHS: 'https://example.com/wasm/',
      },
    });
    expect(config).toEqual({
      modelId: 'example/model',
      dtype: 'q8',
      device: 'wasm',
      wasmPaths: 'https://example.com/wasm/',
    });
  });

  it('exposes a default option and at least one concrete asset set option', () => {
    const options = getKokoroAssetSetOptions({});
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]?.id).toBe('');
  });
});

