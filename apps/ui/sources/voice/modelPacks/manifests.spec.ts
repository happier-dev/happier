import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';

describe('modelPacks manifests', () => {
  it('uses static process.env access so Expo can inline EXPO_PUBLIC_* vars', () => {
    const source = fs.readFileSync(new URL('./manifests.ts', import.meta.url), 'utf8');
    expect(source).toContain('process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS');
    expect(source).toContain('@happier-dev/voice-modelpacks');
    expect(source).not.toContain('DEFAULT_HAPPIER_ASSETS_OWNER_REPO');
    expect(source).not.toContain('DEFAULT_HAPPIER_ASSETS_RELEASE_TAG');
    expect(source).not.toContain('ManifestMapSchema');
    expect(source).not.toContain('process.env.EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS');
    expect(source).not.toContain('process.env.EXPO_PUBLIC_KOKORO_NATIVE_MANIFEST_URL');
  });

  it('falls back to the default Happier assets release when no manifest is configured', () => {
    expect(resolveModelPackManifestUrl({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm', env: {} })).toBe(
      'https://github.com/happier-dev/happier-assets/releases/download/model-packs/kokoro-82m-v1.0-onnx-q8-wasm__manifest.json',
    );
  });

  it('resolves from the new per-pack manifest map when present', () => {
    expect(
      resolveModelPackManifestUrl({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        env: {
          EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
            'kokoro-82m-v1.0-onnx-q8-wasm': 'https://example.com/manifest.json',
          }),
        },
      }),
    ).toBe('https://example.com/manifest.json');
  });

  it('ignores retired legacy Kokoro native env keys when present', () => {
    expect(
      resolveModelPackManifestUrl({
        packId: 'kokoro-test',
        env: {
          EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS: JSON.stringify({
            'kokoro-test': 'https://example.com/kokoro.json',
          }),
        },
      }),
    ).toBe(
      'https://github.com/happier-dev/happier-assets/releases/download/model-packs/kokoro-test__manifest.json',
    );
  });
});
