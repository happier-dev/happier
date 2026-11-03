import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildDefaultProfileError, DEFAULT_HAPPIER_CLOUD_SERVER_URL, resolveBuildDefaultProfile, resolveDefaultWebappUrl } from './happierCloud.js';

afterEach(() => vi.unstubAllEnvs());

describe('build default profile', () => {
  it('has no hosted defaults in unconfigured source builds', () => {
    expect(DEFAULT_HAPPIER_CLOUD_SERVER_URL).toBe('');
    expect(resolveBuildDefaultProfile('')).toEqual({});
    expect(resolveDefaultWebappUrl('https://api.happier.dev')).toBe('https://api.happier.dev');
  });

  it('parses independent Account service, Home and Personal Home defaults', () => {
    expect(resolveBuildDefaultProfile(JSON.stringify({
      accountService: { url: 'https://accounts.example.test/', locked: true },
      home: { url: 'https://home.example.test/', webappUrl: 'https://app.example.test/' },
      personalHome: { value: 'offer', locked: false },
    }))).toEqual({
      accountService: { url: 'https://accounts.example.test', locked: true },
      home: { url: 'https://home.example.test', webappUrl: 'https://app.example.test' },
      personalHome: { value: 'offer', locked: false },
    });
  });

  it.each(['{"personalHome":{"value":"invalid"}}', '{"home":{"url":"file:///secret"}}', '{"other":"secret"}', 'invalid-json'])(
    'rejects a present malformed profile without disclosing input values', (raw) => {
      expect(() => resolveBuildDefaultProfile(raw)).toThrow(/Invalid build default profile/);
      expect(() => resolveBuildDefaultProfile(raw)).not.toThrow(/secret|invalid-json/);
    },
  );

  it('uses the configured Home web app only for that Home', () => {
    vi.stubEnv('HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
      home: { url: 'https://home.example.test', webappUrl: 'https://app.example.test' },
    }));
    expect(resolveDefaultWebappUrl('https://home.example.test/')).toBe('https://app.example.test');
    expect(resolveDefaultWebappUrl('https://other.example.test/api')).toBe('https://other.example.test');
  });

  it('reports malformed URLs through the typed profile error without raw values', () => {
    expect(() => resolveBuildDefaultProfile('{"home":{"url":"secret-invalid-url"}}')).toThrow(BuildDefaultProfileError);
    expect(() => resolveBuildDefaultProfile('{"home":{"url":"secret-invalid-url"}}')).toThrow(/home.url/);
    expect(() => resolveBuildDefaultProfile('{"home":{"url":"secret-invalid-url"}}')).not.toThrow(/secret-invalid-url/);
  });

  it('does not label a custom baked Home as Happier Cloud', async () => {
    vi.stubEnv('HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({ home: { url: 'http://localhost:43123' } }));
    vi.resetModules();
    const { DEFAULT_HAPPIER_CLOUD_SERVER_URL: cloudDefault } = await import('./happierCloud.js');
    expect(cloudDefault).toBe('');
  });
});
