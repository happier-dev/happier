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
