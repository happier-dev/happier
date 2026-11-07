import { describe, expect, it } from 'vitest';

import { resolveServerProfileApiUrl } from './serverSelection';

describe('server selection runtime origin', () => {
  const target = { canonicalAuthUrl: 'https://home.example.test', applicationUrl: 'https://ingress.example.test' };

  it.each([
    { serverUrl: 'https://HOME.example.test:443/', localServerUrl: ' http://127.0.0.1:12511/ ', expected: 'http://127.0.0.1:12511' },
    { serverUrl: 'https://old-home.example.test', localServerUrl: 'http://127.0.0.1:12511', expected: target.applicationUrl },
    { serverUrl: target.canonicalAuthUrl, localServerUrl: ' ', expected: target.applicationUrl },
  ])('uses only a local route belonging to the canonical Home: $serverUrl', ({ expected, ...profile }) => {
    expect(resolveServerProfileApiUrl(profile, target)).toBe(expected);
  });
});
