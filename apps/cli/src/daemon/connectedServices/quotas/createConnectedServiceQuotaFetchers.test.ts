import { describe, expect, it } from 'vitest';

import { createConnectedServiceQuotaFetchers } from './createConnectedServiceQuotaFetchers';
import type { ConnectedServiceQuotaFetcherDescriptorParams } from './types';

describe('createConnectedServiceQuotaFetchers', () => {
  it('schedules provider-neutral descriptors with shared stale and user-agent options', () => {
    const descriptorCalls: ConnectedServiceQuotaFetcherDescriptorParams[] = [];

    const fetchers = createConnectedServiceQuotaFetchers({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS: '120000',
      HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT: 'happier-test',
      HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL: 'https://provider-owned.example.test/ignored-by-core',
    }, [{
      id: 'test-descriptor',
      createFetcher: (params) => {
        descriptorCalls.push(params);
        return {
          serviceId: 'github',
          loadQuota: async () => null,
        };
      },
    }]);

    expect(fetchers).toHaveLength(1);
    expect(descriptorCalls).toEqual([
      expect.objectContaining({
        staleAfterMs: 120_000,
        userAgent: 'happier-test',
        env: expect.objectContaining({
          HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL: 'https://provider-owned.example.test/ignored-by-core',
        }),
      }),
    ]);
  });
});
