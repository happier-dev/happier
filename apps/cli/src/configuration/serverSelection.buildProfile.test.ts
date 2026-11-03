import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveServerSelection } from './serverSelection';

afterEach(() => vi.unstubAllEnvs());

const input = {
  envServerUrl: null, envLocalServerUrl: null, envPublicServerUrl: null,
  envWebappUrl: null, envActiveServerId: null, persisted: null, serversDir: '/unused',
};

describe('build default Home selection', () => {
  it('leaves first-run server selection empty without a profile', () => {
    vi.stubEnv('HAPPIER_BUILD_DEFAULT_PROFILE_JSON', '');
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', '');
    expect(resolveServerSelection(input)).toMatchObject({ serverUrl: '', apiServerUrl: '', webappUrl: '' });
  });

  it('uses only the Home default and preserves an explicit saved Home', () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
      accountService: { url: 'https://accounts.example.test' },
      home: { url: 'https://home.example.test', webappUrl: 'https://app.example.test' },
    }));
    expect(resolveServerSelection(input)).toMatchObject({
      serverUrl: 'https://home.example.test', webappUrl: 'https://app.example.test',
    });
    expect(resolveServerSelection({ ...input, persisted: {
      activeServerId: 'mine', servers: { mine: {
        id: 'mine', serverUrl: 'https://mine.example.test', webappUrl: 'https://mine.example.test',
      } },
    } })).toMatchObject({ serverUrl: 'https://mine.example.test' });
  });
});
