import { describe, expect, it } from 'vitest';

import { resolveMobileAppScheme } from './mobileAppScheme';

describe('resolveMobileAppScheme', () => {
  it('prefers an explicit mobile e2e scheme override', () => {
    expect(
      resolveMobileAppScheme(
        { HAPPIER_E2E_MOBILE_APP_SCHEME: 'happier-custom', EXPO_APP_SCHEME: 'happier-dev' },
        { appId: 'dev.happier.app.publicdev.devclient' },
      ),
    ).toBe('happier-custom');
  });

  it('infers the public dev-client scheme from the app id when no override is configured', () => {
    expect(resolveMobileAppScheme({}, { appId: 'dev.happier.app.publicdev.devclient' })).toBe(
      'happier-dev-devclient',
    );
  });

  it('infers the internal installed-app scheme from the app id when no override is configured', () => {
    expect(resolveMobileAppScheme({}, { appId: 'dev.happier.app.internaldev' })).toBe('happier-internaldev');
  });

  it('falls back to the production scheme for unknown app ids', () => {
    expect(resolveMobileAppScheme({}, { appId: 'example.unknown.app' })).toBe('happier');
  });
});
