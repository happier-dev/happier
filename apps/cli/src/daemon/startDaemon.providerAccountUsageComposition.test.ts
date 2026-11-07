import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceUsageSourceV1 } from '@happier-dev/protocol';

import { createDaemonServerWorkBudget } from './serverWork/createDaemonServerWorkBudget';
import { createDaemonServerWorkScheduler } from './serverWork/createDaemonServerWorkScheduler';
import { resolveConnectedServiceQuotasDaemonOptions } from './connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';

import { activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration } from './connectedServices/accountUsage/startupActivation';

function activationServerWork() {
  const options = resolveConnectedServiceQuotasDaemonOptions({});
  return {
    serverWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
    retry: {
      signal: new AbortController().signal,
      baseDelayMs: options.failureBackoffMinMs,
      maxDelayMs: options.failureBackoffMaxMs,
      jitterMs: options.failureBackoffMinMs * options.failureBackoffJitterPct,
    },
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const staleGroupSource = {
  serviceId: 'openai-codex',
  profileId: 'profile-a',
  bindingKind: 'group_member',
  groupId: 'group-a',
  groupGeneration: 7,
} satisfies ConnectedServiceUsageSourceV1;

describe('startDaemon provider-account usage startup composition', () => {
  it('awaits canonical inventory hydration before constructing or starting quota automation', async () => {
    const hydration = deferred<Readonly<{
      refreshSources: ConnectedServiceUsageSourceV1[];
    }>>();
    const order: string[] = [];
    const coordinator = {
      scheduleCurrentSourceRefresh: vi.fn((sources: readonly ConnectedServiceUsageSourceV1[]) => {
        order.push('schedule-refresh');
        expect(sources).toEqual([staleGroupSource]);
        return { accepted: 1, ignored: 0 };
      }),
    };
    const createCoordinator = vi.fn(() => {
      order.push('create-coordinator');
      return coordinator;
    });
    const startLoop = vi.fn(() => {
      order.push('start-loop');
      return { stop: vi.fn(async () => {}), pause: vi.fn(), resume: vi.fn(), wake: vi.fn() };
    });

    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      ...activationServerWork(),
      enabled: true,
      quotaFetchers: [
        { serviceId: 'openai-codex' },
        { serviceId: 'openai-codex' },
        { serviceId: 'claude-subscription' },
      ],
      awaitReadiness: async () => {
        order.push('readiness');
      },
      hydrate: async ({ serviceIds }) => {
        order.push(`hydrate:${serviceIds.join(',')}`);
        return await hydration.promise;
      },
      createCoordinator,
      startLoop,
      onActivationError: vi.fn(),
    });

    await Promise.resolve();
    expect(order).toEqual([
      'readiness',
      'hydrate:openai-codex,claude-subscription',
    ]);
    expect(createCoordinator).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();

    hydration.resolve({ refreshSources: [staleGroupSource] });
    const result = await activation;

    expect(result.status).toBe('active');
    expect(order).toEqual([
      'readiness',
      'hydrate:openai-codex,claude-subscription',
      'create-coordinator',
      'schedule-refresh',
      'start-loop',
    ]);
  });

  it('keeps quota automation disabled when authoritative hydration rejects', async () => {
    const hydrationError = new Error('Connected service provider-account usage source changed during hydration');
    const createCoordinator = vi.fn(() => ({
      scheduleCurrentSourceRefresh: vi.fn(),
    }));
    const startLoop = vi.fn();
    const onActivationError = vi.fn();

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      ...activationServerWork(),
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate: async () => {
        throw hydrationError;
      },
      createCoordinator,
      startLoop,
      onActivationError,
    })).resolves.toEqual({
      status: 'quota_policy_disabled',
      error: hydrationError,
    });

    expect(createCoordinator).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
    expect(onActivationError).toHaveBeenCalledWith(hydrationError);
  });

  it('does not construct hydration or quota effects when quota automation is disabled', async () => {
    const awaitReadiness = vi.fn(async () => {});
    const hydrate = vi.fn(async () => ({ refreshSources: [] }));
    const createCoordinator = vi.fn();
    const startLoop = vi.fn();

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      ...activationServerWork(),
      enabled: false,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness,
      hydrate,
      createCoordinator,
      startLoop,
      onActivationError: vi.fn(),
    })).resolves.toEqual({ status: 'disabled' });

    expect(awaitReadiness).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(createCoordinator).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
  });
});
