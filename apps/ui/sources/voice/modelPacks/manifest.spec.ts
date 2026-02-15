import { describe, expect, it } from 'vitest';

import { parseModelPackManifest } from '@/voice/modelPacks/manifest';

describe('modelPacks manifest', () => {
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
    const manifest: any = parseModelPackManifest({
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
});

