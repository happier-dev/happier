import { describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

const fetchServerFeaturesSnapshotMock = vi.fn<
  (params: Readonly<{ serverUrl: string; timeoutMs?: number }>) => Promise<unknown>
>();

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (params: Readonly<{ serverUrl: string; timeoutMs?: number }>) =>
    fetchServerFeaturesSnapshotMock(params),
}));

describe('fetchServerAdvertisedUrls', () => {
  it('returns null when server does not support /v1/features', async () => {
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'unsupported', reason: 'endpoint_missing' });
    const { fetchServerAdvertisedUrls } = await import('./serverCapabilities');
    const result = await fetchServerAdvertisedUrls({ apiServerUrl: 'https://example.test' });
    expect(result).toBeNull();
  });

  it('returns null values when server capabilities are missing', async () => {
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'ready',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
    });
    const { fetchServerAdvertisedUrls } = await import('./serverCapabilities');
    const result = await fetchServerAdvertisedUrls({ apiServerUrl: 'https://example.test' });
    expect(result).toEqual({ canonicalServerUrl: null, webappUrl: null });
  });

  it('normalizes advertised urls and strips userinfo/query/hash', async () => {
    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          server: {
            canonicalServerUrl: 'https://user:pass@example.test/api/?q=1#frag',
            webappUrl: 'https://user:pass@example.test/app/#frag',
          },
        },
      }),
    });
    const { fetchServerAdvertisedUrls } = await import('./serverCapabilities');
    const result = await fetchServerAdvertisedUrls({ apiServerUrl: 'https://example.test' });
    expect(result).toEqual({
      canonicalServerUrl: 'https://example.test/api',
      webappUrl: 'https://example.test/app',
    });
  });
});

