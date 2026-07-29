import { describe, expect, it, vi } from 'vitest';

import { startHostedConversationWithPaywall } from './startHostedConversationWithPaywall';

describe('startHostedConversationWithPaywall', () => {
  it('retries subscription admission once after a successful purchase', async () => {
    const start = vi.fn()
      .mockResolvedValueOnce({ allowed: false as const, reason: 'subscription_required' })
      .mockResolvedValueOnce({ allowed: true as const, leaseId: 'lease-1' });
    const presentPaywall = vi.fn(async () => ({ purchased: true }));

    await expect(startHostedConversationWithPaywall({
      start,
      presentPaywall,
      signal: new AbortController().signal,
    })).resolves.toEqual({ allowed: true, leaseId: 'lease-1' });
    expect(start).toHaveBeenCalledTimes(2);
    expect(presentPaywall).toHaveBeenCalledTimes(1);
  });

  it('returns the original denial without retry when purchase is declined', async () => {
    const denial = { allowed: false as const, reason: 'quota_exceeded' };
    const start = vi.fn(async () => denial);

    await expect(startHostedConversationWithPaywall({
      start,
      presentPaywall: async () => ({ purchased: false }),
      signal: new AbortController().signal,
    })).resolves.toBe(denial);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
