import { describe, expect, it } from 'vitest';

import { resolveConnectedServicesQuotasEnabled } from './resolveConnectedServicesQuotasEnabled';

describe('resolveConnectedServicesQuotasEnabled', () => {
  it('defaults quotas to disabled when env is unset', () => {
    expect(resolveConnectedServicesQuotasEnabled({ HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1' })).toBe(false);
  });

  it('returns true when both connected services and quotas are enabled', () => {
    expect(
      resolveConnectedServicesQuotasEnabled({
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      }),
    ).toBe(true);
  });

  it('returns false when connected services are disabled', () => {
    expect(
      resolveConnectedServicesQuotasEnabled({
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '0',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      }),
    ).toBe(false);
  });
});

