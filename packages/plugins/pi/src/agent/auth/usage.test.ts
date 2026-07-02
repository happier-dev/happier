import { describe, expect, it } from 'vitest';

type PiUsageModule = typeof import('./usage.js');

async function loadUsageModule(): Promise<PiUsageModule | null> {
  return await import('./usage.js').catch(() => null);
}

describe('resolvePiAccountUsageAvailability', () => {
  it('reports unavailable usage without creating a fake provider-global gauge', async () => {
    const moduleRecord = await loadUsageModule();
    expect(moduleRecord).toEqual(expect.objectContaining({
      resolvePiAccountUsageAvailability: expect.any(Function),
    }));
    if (!moduleRecord) throw new Error('usage module missing');

    expect(moduleRecord.resolvePiAccountUsageAvailability()).toEqual({
      providerId: 'pi',
      status: 'unsupported',
      reason: 'no_verified_usage_source',
      displayGauge: false,
      canonicalRecord: null,
    });
  });
});
