import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { resolveConnectedServicesQuotasDaemonEnabled } from './resolveConnectedServicesQuotasDaemonEnabled';

describe('resolveConnectedServicesQuotasDaemonEnabled', () => {
  it('returns false when the server reports quotas disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          FeaturesResponseSchema.parse({
            features: {
              connectedServices: { enabled: true, quotas: { enabled: false } },
            },
            capabilities: {},
          }),
      })) as unknown as typeof fetch,
    );

    const enabled = await resolveConnectedServicesQuotasDaemonEnabled({
      env: { HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1' },
      serverUrl: 'https://api.example.test',
      timeoutMs: 100,
    });

    expect(enabled).toBe(false);
  });

  it('returns true when server reports quotas enabled and build policy does not deny the feature', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          FeaturesResponseSchema.parse({
            features: {
              connectedServices: { enabled: true, quotas: { enabled: true } },
            },
            capabilities: {},
          }),
      })) as unknown as typeof fetch,
    );

    const enabled = await resolveConnectedServicesQuotasDaemonEnabled({
      env: {
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      },
      serverUrl: 'https://api.example.test',
      timeoutMs: 100,
    });

    expect(enabled).toBe(true);
  });

  it('does not enable quotas when build policy denies the feature', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        FeaturesResponseSchema.parse({
          features: {
            connectedServices: { enabled: true, quotas: { enabled: true } },
          },
          capabilities: {},
        }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    const enabled = await resolveConnectedServicesQuotasDaemonEnabled({
      env: {
        HAPPIER_BUILD_FEATURES_DENY: 'connectedServices.quotas',
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      },
      serverUrl: 'https://api.example.test',
      timeoutMs: 100,
    });

    expect(enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

