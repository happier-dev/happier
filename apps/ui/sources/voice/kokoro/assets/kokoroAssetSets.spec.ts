import { describe, expect, it } from 'vitest';

import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';

describe('kokoroAssetSets', () => {
  it('keeps the environment-default option when no built-in Kokoro publication is available', () => {
    const options = getKokoroAssetSetOptions({});
    expect(options).toEqual([expect.objectContaining({ id: '' })]);
  });

  it('does not advertise the q8 model-pack while its canonical publication is unavailable', () => {
    const options = getKokoroAssetSetOptions({});
    const ids = options.map((option) => option.id);

    expect(ids).not.toContain('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(ids).not.toContain('kokoro-82m-v1.0-onnx-fp32-wasm');
  });

  it('filters known unavailable catalog ids from env overrides while preserving explicit experiment ids', () => {
    const options = getKokoroAssetSetOptions({
      EXPO_PUBLIC_KOKORO_ASSET_SETS: JSON.stringify([
        { id: 'kokoro-82m-v1.0-onnx-q8-wasm', title: 'Q8' },
        { id: 'kokoro-82m-v1.0-onnx-fp32-wasm', title: 'FP32' },
      ]),
    });

    expect(options.map((option) => option.id)).toEqual([
      '',
      'kokoro-82m-v1.0-onnx-fp32-wasm',
    ]);
  });
});
