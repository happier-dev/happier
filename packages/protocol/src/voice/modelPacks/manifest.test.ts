import { describe, expect, it } from 'vitest';

import { ModelPackRuntimeFamilySchema, parseModelPackManifest } from './manifest.js';

describe('voice model pack manifest', () => {
  it('recognizes the Moonshine offline runtime-family identifier', () => {
    expect(ModelPackRuntimeFamilySchema.parse('sherpa_moonshine_offline')).toBe('sherpa_moonshine_offline');
  });

  it('parses a valid manifest', () => {
    const manifest = parseModelPackManifest({
      packId: 'kokoro-tts-en-v1',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: '2026-02-15',
      files: [
        {
          path: 'model.onnx',
          url: 'https://example.com/model.onnx',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
        },
      ],
    });

    expect(manifest.packId).toBe('kokoro-tts-en-v1');
    expect(manifest.files.length).toBe(1);
  });

  it('preserves an optional voices catalog', () => {
    const manifest = parseModelPackManifest({
      packId: 'kokoro-tts-en-v1',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: '2026-02-15',
      voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }],
      files: [
        {
          path: 'model.onnx',
          url: 'https://example.com/model.onnx',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
        },
      ],
    });

    expect(manifest.voices).toEqual([{ id: 'af_bella', title: 'Bella', sid: 0 }]);
  });

  it('rejects invalid sha256 values', () => {
    expect(() =>
      parseModelPackManifest({
        packId: 'kokoro-tts-en-v1',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-02-15',
        files: [
          {
            path: 'model.onnx',
            url: 'https://example.com/model.onnx',
            sha256: 'not-a-sha',
            sizeBytes: 123,
          },
        ],
      }),
    ).toThrow();
  });

  it('retains the model frontend required before native Kokoro construction', () => {
    const manifest = parseModelPackManifest({
      packId: 'kokoro-multi', kind: 'tts_sherpa', model: 'kokoro', version: 'v1.1',
      frontend: { lang: 'en', lexicon: 'lexicon-en.txt' },
      files: [{ path: 'lexicon-en.txt', url: 'https://example.com/lexicon', sha256: 'a'.repeat(64), sizeBytes: 1 }],
    });
    expect(manifest).toHaveProperty('frontend', { lang: 'en', lexicon: 'lexicon-en.txt' });
  });

  it('rejects a frontend lexicon outside the integrity-declared pack files', () => {
    expect(() => parseModelPackManifest({
      packId: 'kokoro-multi', kind: 'tts_sherpa', model: 'kokoro', version: 'v1.1',
      frontend: { lang: 'en', lexicon: 'lexicon-en.txt' },
      files: [{ path: 'model.onnx', url: 'https://example.com/model', sha256: 'a'.repeat(64), sizeBytes: 1 }],
    })).toThrow();
    expect(() => parseModelPackManifest({
      packId: 'kokoro-multi', kind: 'tts_sherpa', model: 'kokoro', version: 'v1.1',
      frontend: { lang: 'en', lexicon: '../other/lexicon.txt' },
      files: [{ path: 'model.onnx', url: 'https://example.com/model', sha256: 'a'.repeat(64), sizeBytes: 1 }],
    })).toThrow();
  });
});
