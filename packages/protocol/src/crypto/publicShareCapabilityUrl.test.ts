import { describe, expect, it } from 'vitest';

import { redactPublicShareCapabilityUrl } from './publicShareCapabilityUrl.js';

describe('redactPublicShareCapabilityUrl', () => {
  it('removes private HTML document capabilities including query-prefixed fragments', () => {
    for (const url of ['https://isolated.example/a/artifact#d=PRIVATE_HTML_SENTINEL', 'https://isolated.example/a/artifact?ref=agent#d=PRIVATE_HTML_SENTINEL']) {
      expect(redactPublicShareCapabilityUrl(url)).toBe('https://isolated.example/a/:artifact');
    }
  });
  it('removes stored-content fragment secrets and templates HTTP lookup capabilities', () => {
    expect(redactPublicShareCapabilityUrl('https://public.example/s/lookup#k=LOCAL_SECRET'))
      .toBe('https://public.example/s/:lookup');
    expect(redactPublicShareCapabilityUrl('https://public.example/s/lookup?ref=message#k=LOCAL_SECRET'))
      .toBe('https://public.example/s/:lookup');
    expect(redactPublicShareCapabilityUrl('https://public.example/s/lookup?ref=%0A#k=LOCAL_SECRET#malformed'))
      .toBe('https://public.example/s/:lookup');
    expect(redactPublicShareCapabilityUrl('/v1/public-shares/lookup/content?consent=true'))
      .toBe('/v1/public-shares/:lookup/content?consent=true');
  });
  it('templates Team invitation tokens while preserving the nonsecret Home target', () => {
    for (const token of ['SENTINEL_TEAM_INVITATION', 'malformed%2Ftoken']) {
      expect(redactPublicShareCapabilityUrl(`https://app.example.test/join/${token}?target=home-descriptor`)).toBe(
        'https://app.example.test/join/:token?target=home-descriptor',
      );
    }
  });

  it('templates native email verification and password-reset bearers', () => {
    const secret = 'SENTINEL_NATIVE_AUTH_BEARER';
    expect(redactPublicShareCapabilityUrl(
      `https://app.example.test/auth/email/verify/${secret}`,
    )).toBe('https://app.example.test/auth/email/verify/:token');
    expect(redactPublicShareCapabilityUrl(
      `/auth/password/reset/${secret}?server=https%3A%2F%2Fhome.example.test`,
    )).toBe('/auth/password/reset/:token?server=https%3A%2F%2Fhome.example.test');
    expect(redactPublicShareCapabilityUrl('/auth/password/reset')).toBe('/auth/password/reset');
  });

  it('templates only the public-share bearer capability segment', () => {
    const secret = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
    expect(redactPublicShareCapabilityUrl(`/v1/public-share/${secret}`)).toBe('/v1/public-share/:token');
    expect(redactPublicShareCapabilityUrl(`/v1/public-share/${secret}/messages?consent=true`)).toBe(
      '/v1/public-share/:token/messages?consent=true',
    );
    expect(redactPublicShareCapabilityUrl(`https://api.example.test/v1/public-share/${secret}/messages`)).toBe(
      'https://api.example.test/v1/public-share/:token/messages',
    );
    expect(redactPublicShareCapabilityUrl(`/share/${secret}?consent=true`)).toBe(
      '/share/:token?consent=true',
    );
    expect(redactPublicShareCapabilityUrl(`https://app.example.test/share/${secret}`)).toBe(
      'https://app.example.test/share/:token',
    );
    expect(redactPublicShareCapabilityUrl('/v1/sessions/session-1/public-share')).toBe(
      '/v1/sessions/session-1/public-share',
    );
  });

  it('templates a browser Artifact bearer capability and removes its correlation query', () => {
    const capability = 'SENTINEL_BROWSER_ARTIFACT_CAPABILITY';
    const correlation = 'SENTINEL_BROWSER_ARTIFACT_CORRELATION';
    expect(redactPublicShareCapabilityUrl(
      `/v1/plugins/availability/ui-artifacts/browser/${capability}/assets/app.js?correlation=${correlation}`,
    )).toBe('/v1/plugins/availability/ui-artifacts/browser/:token/assets/app.js');
    expect(redactPublicShareCapabilityUrl(
      `https://artifacts.example.test/v1/plugins/availability/ui-artifacts/browser/${capability}/?correlation=${correlation}`,
    )).toBe('https://artifacts.example.test/v1/plugins/availability/ui-artifacts/browser/:token/');
  });
});
