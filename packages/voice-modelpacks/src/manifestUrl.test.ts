import { describe, expect, it } from 'vitest';

import { defaultModelPackManifestUrl, resolveModelPackManifestUrl } from './manifestUrl.js';

describe('resolveModelPackManifestUrl', () => {
  it('falls back to the default published URL', () => {
    expect(resolveModelPackManifestUrl({ packId: 'kokoro-tts-en-v1' })).toBe(
      defaultModelPackManifestUrl('kokoro-tts-en-v1'),
    );
    expect(defaultModelPackManifestUrl('kokoro-tts-en-v1')).toBe(
      'https://github.com/happier-dev/happier-assets/releases/download/model-packs/kokoro-tts-en-v1__manifest.json',
    );
  });

  it('prefers an explicit override URL', () => {
    expect(resolveModelPackManifestUrl({ packId: 'p', overrideUrl: 'https://cdn.example/p.json' })).toBe(
      'https://cdn.example/p.json',
    );
  });

  it('consults a host-supplied manifest map before the default', () => {
    const manifestMapRaw = JSON.stringify({ p: 'https://map.example/p.json' });
    expect(resolveModelPackManifestUrl({ packId: 'p', manifestMapRaw })).toBe('https://map.example/p.json');
  });

  it('ignores a malformed manifest map and a blank override', () => {
    expect(resolveModelPackManifestUrl({ packId: 'p', overrideUrl: '   ', manifestMapRaw: 'not json' })).toBe(
      defaultModelPackManifestUrl('p'),
    );
  });

  it('encodes the pack id in the default URL path', () => {
    expect(defaultModelPackManifestUrl('a b')).toContain('a%20b__manifest.json');
  });
});
