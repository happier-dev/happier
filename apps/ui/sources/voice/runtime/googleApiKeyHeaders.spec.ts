import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unmock('expo-application');
  vi.unmock('react-native');
});

describe('buildGoogleApiKeyRestrictionHeaders', () => {
  it('returns empty headers when applicationId is missing', async () => {
    vi.doMock('expo-application', () => ({ applicationId: null }));
    vi.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));

    const { buildGoogleApiKeyRestrictionHeaders } = await import('./googleApiKeyHeaders');
    expect(buildGoogleApiKeyRestrictionHeaders()).toEqual({});
  });

  it('includes X-Ios-Bundle-Identifier on iOS', async () => {
    vi.doMock('expo-application', () => ({ applicationId: 'com.example.app' }));
    vi.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));

    const { buildGoogleApiKeyRestrictionHeaders } = await import('./googleApiKeyHeaders');
    expect(buildGoogleApiKeyRestrictionHeaders()).toEqual({ 'X-Ios-Bundle-Identifier': 'com.example.app' });
  });

  it('includes Android restriction headers when configured', async () => {
    vi.doMock('expo-application', () => ({ applicationId: 'com.example.app' }));
    vi.doMock('react-native', () => ({ Platform: { OS: 'android' } }));

    const { buildGoogleApiKeyRestrictionHeaders } = await import('./googleApiKeyHeaders');
    expect(buildGoogleApiKeyRestrictionHeaders({ androidCertSha1: 'aa:bb cc' })).toEqual({
      'X-Android-Package': 'com.example.app',
      'X-Android-Cert': 'AA:BBCC',
    });
  });
});
