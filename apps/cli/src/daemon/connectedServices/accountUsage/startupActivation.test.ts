import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceCurrentSourceHydrationConflictError } from './currentSourceHydration';
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

  it('retries a bounded transient inventory conflict before activating quota policy', async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new ConnectedServiceCurrentSourceHydrationConflictError('source changed'))
      .mockRejectedValueOnce(new ConnectedServiceCurrentSourceHydrationConflictError('inventory changed'))
      .mockResolvedValue({ refreshSources: [] });
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate,
      createCoordinator,
      startLoop: () => ({ stop: vi.fn() }),
      onActivationError: vi.fn(),
    })).resolves.toMatchObject({ status: 'active' });

    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(createCoordinator).toHaveBeenCalledTimes(1);
  });

  it('fails closed after the bounded transient-conflict attempts are exhausted', async () => {
    const error = new ConnectedServiceCurrentSourceHydrationConflictError('source keeps changing');
    const hydrate = vi.fn().mockRejectedValue(error);
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));
    const onActivationError = vi.fn();

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate,
      createCoordinator,
      startLoop: () => ({ stop: vi.fn() }),
      onActivationError,
    })).resolves.toEqual({ status: 'quota_policy_disabled', error });

    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(createCoordinator).not.toHaveBeenCalled();
    expect(onActivationError).toHaveBeenCalledWith(error);
  });

  it('does not retry non-conflict hydration failures', async () => {
    const error = new Error('hydration failed');
    const hydrate = vi.fn().mockRejectedValue(error);
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate,
      createCoordinator,
      startLoop: vi.fn(),
      onActivationError: vi.fn(),
    })).resolves.toEqual({ status: 'quota_policy_disabled', error });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(createCoordinator).not.toHaveBeenCalled();
  });
});
