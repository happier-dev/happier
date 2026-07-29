import { describe, expect, it } from 'vitest';

import { resolveMobileAppScheme } from './mobileAppScheme';

describe('resolveMobileAppScheme', () => {
  it('uses an explicit mobile app scheme override first', () => {
    expect(resolveMobileAppScheme(
      { HAPPIER_E2E_MOBILE_APP_SCHEME: 'custom-scheme' },
      { appId: 'dev.happier.app.publicdev.devclient' },
    )).toBe('custom-scheme');
  });

  it('infers the public dev-client app route scheme from the app id', () => {
    expect(resolveMobileAppScheme(
      {},
      { appId: 'dev.happier.app.publicdev.devclient' },
    )).toBe('happier-dev');
  });

  it('infers the internal dev-client app route scheme from the app id', () => {
    expect(resolveMobileAppScheme(
      {},
      { appId: 'dev.happier.app.internaldev.devclient' },
    )).toBe('happier-internaldev');
  });

  it('infers the internal dev scheme from the app id', () => {
    expect(resolveMobileAppScheme(
      {},
      { appId: 'dev.happier.app.internaldev' },
    )).toBe('happier-internaldev');
  });

  it('infers the current internal-app dev route scheme from the installed app id', () => {
    expect(resolveMobileAppScheme(
      {},
      { appId: 'dev.happier.app.dev.internal' },
    )).toBe('happier-dev');
  });

  it('falls back to the production scheme for unknown app ids', () => {
    expect(resolveMobileAppScheme(
      {},
      { appId: 'dev.example.unknown' },
    )).toBe('happier');
  });
});
