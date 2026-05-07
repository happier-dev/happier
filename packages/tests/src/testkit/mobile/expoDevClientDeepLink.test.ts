import { describe, expect, it } from 'vitest';

import { resolveExpoDevClientDeepLink } from './expoDevClientDeepLink';

describe('resolveExpoDevClientDeepLink', () => {
  it('uses the configured app scheme and strips a trailing slash from the metro url', () => {
    expect(
      resolveExpoDevClientDeepLink({
        env: { EXPO_APP_SCHEME: 'happier' },
        metroUrl: 'http://localhost:62346/',
      }),
    ).toBe(
      `happier://expo-development-client/?url=${encodeURIComponent('http://localhost:62346')}&disableOnboarding=1`,
    );
  });

  it('can use a caller-provided scheme to avoid iOS dev-client scheme collisions', () => {
    expect(
      resolveExpoDevClientDeepLink({
        env: { EXPO_APP_SCHEME: 'happier-dev' },
        metroUrl: 'http://127.0.0.1:62830/',
        scheme: 'dev.happier.app.publicdev.devclient',
      }),
    ).toBe(
      `dev.happier.app.publicdev.devclient://expo-development-client/?url=${encodeURIComponent('http://127.0.0.1:62830')}&disableOnboarding=1`,
    );
  });

  it('falls back to the app default scheme when no explicit scheme is configured', () => {
    expect(
      resolveExpoDevClientDeepLink({
        env: {},
        metroUrl: 'http://localhost:62346',
      }),
    ).toBe(
      `happier://expo-development-client/?url=${encodeURIComponent('http://localhost:62346')}&disableOnboarding=1`,
    );
  });
});
