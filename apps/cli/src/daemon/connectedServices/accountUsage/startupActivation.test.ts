import { describe, expect, it, vi } from 'vitest';

import { activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration } from './startupActivation';

describe('provider-account usage startup activation', () => {
  it('constructs and starts quota policy only after readiness and hydration', async () => {
    const order: string[] = [];
    const coordinator = { scheduleCurrentSourceRefresh: vi.fn(() => order.push('schedule')) };
    const result = await activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }, { serviceId: 'openai-codex' }],
      awaitReadiness: async () => { order.push('ready'); },
      hydrate: async ({ serviceIds }) => {
        order.push(`hydrate:${serviceIds.join(',')}`);
        return { refreshSources: [] };
      },
      createCoordinator: () => { order.push('create'); return coordinator; },
      startLoop: () => { order.push('loop'); return { stop: vi.fn() }; },
      onActivationError: vi.fn(),
    });
    expect(result.status).toBe('active');
    expect(order).toEqual(['ready', 'hydrate:openai-codex', 'create', 'schedule', 'loop']);
  });

  it('fails closed without constructing quota policy when hydration fails', async () => {
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));
    const startLoop = vi.fn();
    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate: async () => { throw new Error('hydration failed'); },
      createCoordinator,
      startLoop,
      onActivationError: vi.fn(),
    })).resolves.toMatchObject({ status: 'quota_policy_disabled' });
    expect(createCoordinator).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
  });
});
