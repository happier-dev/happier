import { afterEach, describe, expect, it } from 'vitest';

import { setPreferredLanguageFromSettings } from '@/text';
import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';

describe('kokoroAssetSets', () => {
  afterEach(() => {
    setPreferredLanguageFromSettings(null);
  });

  it('lists the exact published q8 Kokoro pack after the environment-default option', () => {
    const options = getKokoroAssetSetOptions({});
    expect(options).toEqual([
      expect.objectContaining({ id: '' }),
      {
        id: 'kokoro-82m-v1.0-onnx-q8-wasm',
        title: 'Kokoro 82M',
        subtitle: 'Default local neural voice model.',
      },
    ]);
  });

  it('advertises the exact published q8 pack without exposing unavailable Kokoro neighbors', () => {
    const options = getKokoroAssetSetOptions({});
    const ids = options.map((option) => option.id);

    expect(ids).toContain('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(ids).not.toContain('kokoro-en-v0_19');
  });

  it('keeps published catalog ids and explicit experiment ids from environment overrides', () => {
    const options = getKokoroAssetSetOptions({
      EXPO_PUBLIC_KOKORO_ASSET_SETS: JSON.stringify([
        { id: 'kokoro-82m-v1.0-onnx-q8-wasm', title: 'Q8' },
        { id: 'kokoro-82m-v1.0-onnx-fp32-wasm', title: 'FP32' },
      ]),
    });

    expect(options.map((option) => option.id)).toEqual([
      '',
      'kokoro-82m-v1.0-onnx-q8-wasm',
      'kokoro-82m-v1.0-onnx-fp32-wasm',
    ]);
  });

  it('projects localized built-in descriptions while preserving environment-provided option copy', () => {
    setPreferredLanguageFromSettings('es');

    const localized = getKokoroAssetSetOptions({});
    expect(localized.find((option) => option.id === '')?.title).toBe('Predeterminado (desde el entorno)');
    expect(localized.find((option) => option.id === 'kokoro-82m-v1.0-onnx-q8-wasm')?.subtitle).toBe(
      'Modelo de voz neuronal local predeterminado.',
    );

    const configuredSubtitle = 'Configured by the deployment';
    const configured = getKokoroAssetSetOptions({
      EXPO_PUBLIC_KOKORO_ASSET_SETS: JSON.stringify([
        { id: 'kokoro-82m-v1.0-onnx-q8-wasm', title: 'Q8', subtitle: configuredSubtitle },
      ]),
    });
    expect(configured.find((option) => option.id === 'kokoro-82m-v1.0-onnx-q8-wasm')?.subtitle).toBe(configuredSubtitle);
  });
});
