import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { observeServerFeaturesSnapshotMock } = vi.hoisted(() => ({
  observeServerFeaturesSnapshotMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://public.example.test',
    publicServerUrl: 'https://public.example.test',
    apiServerUrl: 'http://127.0.0.1:3005',
  },
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  observeServerFeaturesSnapshot: observeServerFeaturesSnapshotMock,
}));

import { readSessionHandoffServerFeatures } from './sessionHandoffServerFeatures';

const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });

describe('readSessionHandoffServerFeatures', () => {
  beforeEach(() => {
    observeServerFeaturesSnapshotMock.mockReset();
  });

  it('reads the transfer policy from the effective API URL, not the public server URL', async () => {
    observeServerFeaturesSnapshotMock.mockResolvedValue({ status: 'ready', features });

    await expect(readSessionHandoffServerFeatures({ token: 'token-1' })).resolves.toEqual(features);
    expect(observeServerFeaturesSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'http://127.0.0.1:3005',
      token: 'token-1',
    }));
  });

  it('forwards the caller cancellation signal to the feature request', async () => {
    observeServerFeaturesSnapshotMock.mockResolvedValue({ status: 'ready', features });
    const controller = new AbortController();

    await readSessionHandoffServerFeatures({ token: 'token-1', signal: controller.signal });
    expect(observeServerFeaturesSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('returns null when the server features are not ready', async () => {
    observeServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });

    await expect(readSessionHandoffServerFeatures({ token: 'token-1' })).resolves.toBeNull();
  });
});
