import { describe, expect, it } from 'vitest';

import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';

describe('modelPacks manifests', () => {
  it('returns null when no manifest is configured', () => {
    expect(resolveModelPackManifestUrl({ packId: 'kokoro-tts-en-v1', env: {} })).toBe(null);
  });

  it('resolves from the new per-pack manifest map when present', () => {
    expect(
      resolveModelPackManifestUrl({
        packId: 'kokoro-tts-en-v1',
        env: {
          EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
            'kokoro-tts-en-v1': 'https://example.com/manifest.json',
          }),
        },
      }),
    ).toBe('https://example.com/manifest.json');
  });

  it('falls back to legacy Kokoro native env keys when present', () => {
    expect(
      resolveModelPackManifestUrl({
        packId: 'kokoro-test',
        env: {
          EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS: JSON.stringify({
            'kokoro-test': 'https://example.com/kokoro.json',
          }),
        },
      }),
    ).toBe('https://example.com/kokoro.json');
  });
});

