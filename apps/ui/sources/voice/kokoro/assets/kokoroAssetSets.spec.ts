import { describe, expect, it } from 'vitest';

import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';

describe('kokoroAssetSets', () => {
  it('exposes a default option and at least one concrete asset set option', () => {
    const options = getKokoroAssetSetOptions({});
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]?.id).toBe('');
  });

  it('surfaces canonical model-pack ids, not legacy browser wasm ids', () => {
    const options = getKokoroAssetSetOptions({});
    const ids = options.map((option) => option.id);

    expect(ids).toContain('kokoro-tts-en-v1');
    expect(ids).not.toContain('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(ids).not.toContain('kokoro-82m-v1.0-onnx-fp32-wasm');
  });

  it('canonicalizes and deduplicates legacy ids supplied through the env override', () => {
    const options = getKokoroAssetSetOptions({
      EXPO_PUBLIC_KOKORO_ASSET_SETS: JSON.stringify([
        { id: 'kokoro-82m-v1.0-onnx-q8-wasm', title: 'Q8' },
        { id: 'kokoro-82m-v1.0-onnx-fp32-wasm', title: 'FP32' },
      ]),
    });

    expect(options.map((option) => option.id)).toEqual(['', 'kokoro-tts-en-v1']);
  });
});
