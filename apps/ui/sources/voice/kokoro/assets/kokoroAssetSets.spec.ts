import { describe, expect, it } from 'vitest';

import {
  getKokoroAssetSetOptions,
  getKokoroNativeModelPackOptions,
  resolveKokoroRuntimeConfig,
} from '@/voice/kokoro/assets/kokoroAssetSets';

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

  it('offers native pickers only asset sets with a published native model pack', () => {
    const webIds = getKokoroAssetSetOptions({}).map((s) => s.id);
    const nativeIds = getKokoroNativeModelPackOptions({}).map((s) => s.id);
    expect(webIds).toContain('kokoro-82m-v1.0-onnx-fp32-wasm');
    expect(nativeIds).toEqual(['kokoro-82m-v1.0-onnx-q8-wasm']);
  });
});
