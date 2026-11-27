import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { app: {} } } },
}));

import { loadAppConfig } from './appConfig';

// The generic web image is configured at container start (docker/webapp-runtime.sh), so self-hosted
// copies send no analytics unless their operator sets a key.
const ENV_KEYS = [
  'EXPO_PUBLIC_POSTHOG_KEY',
  'EXPO_PUBLIC_POSTHOG_API_KEY',
  'EXPO_PUBLIC_POSTHOG_HOST',
] as const;
const globalWithDev = globalThis as typeof globalThis & { __DEV__?: boolean };

function stubWebRuntimeConfig(runtimeConfig: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    __HAPPIER_WEB_RUNTIME_CONFIG__: { serverUrl: '', ...runtimeConfig },
  });
  vi.stubGlobal('document', {});
}

describe('loadAppConfig (PostHog from the web runtime config)', () => {
  const previousEnv = new Map<string, string | undefined>();
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = globalWithDev.__DEV__;
    globalWithDev.__DEV__ = false;
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousDev === undefined) delete globalWithDev.__DEV__;
    else globalWithDev.__DEV__ = previousDev;
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers the container-start key and host over build-time values', () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_build_time';
    process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://build.posthog.example';
    stubWebRuntimeConfig({
      posthogKey: ' phc_runtime ',
      posthogHost: 'https://runtime.posthog.example',
    });

    const config = loadAppConfig();

    expect(config.postHogKey).toBe('phc_runtime');
    expect(config.postHogHost).toBe('https://runtime.posthog.example');
  });

  it('keeps build-time values when the runtime config leaves them empty or malformed', () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_build_time';
    process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://build.posthog.example';
    stubWebRuntimeConfig({ posthogKey: '', posthogHost: { url: 'x' } });

    const config = loadAppConfig();

    expect(config.postHogKey).toBe('phc_build_time');
    expect(config.postHogHost).toBe('https://build.posthog.example');
  });

  it('leaves analytics unconfigured when neither source sets a key', () => {
    stubWebRuntimeConfig({});

    const config = loadAppConfig();

    expect(config.postHogKey).toBeUndefined();
    expect(config.postHogHost).toBeUndefined();
  });
});
