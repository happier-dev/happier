import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { resolveChannelBridgesDaemonEnabled } from './resolveChannelBridgesDaemonEnabled';

describe('resolveChannelBridgesDaemonEnabled', () => {
  it('returns false when the server reports channel bridges disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          FeaturesResponseSchema.parse({
            features: {
              channelBridges: { enabled: false, telegram: { enabled: true } },
            },
            capabilities: {},
          }),
      })) as unknown as typeof fetch,
    );

    const enabled = await resolveChannelBridgesDaemonEnabled({
      env: { HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '1', HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: '1' },
      serverUrl: 'https://api.example.test',
      settings: { experiments: true, featureToggles: { channelBridges: true } },
      timeoutMs: 100,
    });

    expect(enabled).toBe(false);
  });

  it('returns false when user has not enabled the experimental toggle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          FeaturesResponseSchema.parse({
            features: {
              channelBridges: { enabled: true, telegram: { enabled: true } },
            },
            capabilities: {},
          }),
      })) as unknown as typeof fetch,
    );

    const enabled = await resolveChannelBridgesDaemonEnabled({
      env: { HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '1', HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: '1' },
      serverUrl: 'https://api.example.test',
      settings: {},
      timeoutMs: 100,
    });

    expect(enabled).toBe(false);
  });

  it('returns true when server reports telegram bridge enabled and user has opted in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          FeaturesResponseSchema.parse({
            features: {
              channelBridges: { enabled: true, telegram: { enabled: true } },
            },
            capabilities: {},
          }),
      })) as unknown as typeof fetch,
    );

    const enabled = await resolveChannelBridgesDaemonEnabled({
      env: { HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '1', HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: '1' },
      serverUrl: 'https://api.example.test',
      settings: { experiments: true, featureToggles: { channelBridges: true } },
      timeoutMs: 100,
    });

    expect(enabled).toBe(true);
  });

  it('does not enable channel bridges when build policy denies the feature', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        FeaturesResponseSchema.parse({
          features: {
            channelBridges: { enabled: true, telegram: { enabled: true } },
          },
          capabilities: {},
        }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    const enabled = await resolveChannelBridgesDaemonEnabled({
      env: {
        HAPPIER_BUILD_FEATURES_DENY: 'channelBridges.telegram',
        HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '1',
        HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: '1',
      },
      serverUrl: 'https://api.example.test',
      settings: { experiments: true, featureToggles: { channelBridges: true } },
      timeoutMs: 100,
    });

    expect(enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not probe the server when local policy disables channel bridges', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        FeaturesResponseSchema.parse({
          features: {
            channelBridges: { enabled: true, telegram: { enabled: true } },
          },
          capabilities: {},
        }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    const enabled = await resolveChannelBridgesDaemonEnabled({
      env: {
        HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '1',
        HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: '0',
      },
      serverUrl: 'https://api.example.test',
      settings: { experiments: true, featureToggles: { channelBridges: true } },
      timeoutMs: 100,
    });

    expect(enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
