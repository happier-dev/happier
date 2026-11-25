import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    summaries: [] as unknown[],
    withoutUsage: [] as unknown[],
    policies: [] as unknown[],
    persisted: null as unknown,
    saved: [] as unknown[],
}));

// The quota summaries owner (its own suite covers the server/daemon reads); the hub only asks it
// with a fetch policy and projects its answer.
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: (options?: { fetchPolicy?: string }) => {
        state.policies.push(options?.fetchPolicy);
        return {
            summaries: state.summaries,
            accountsWithoutUsage: state.withoutUsage,
            isRefreshing: false,
            hasConnectedProfiles: state.summaries.length + state.withoutUsage.length > 0,
        };
    },
}));

// Device persistence (the encrypted warm cache).
vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadUsageSummaryWarmCache: () => state.persisted,
    saveUsageSummaryWarmCache: (_server: string, _account: string, value: unknown) => { state.saved.push(value); },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useActiveServerAccountScope: () => ({ serverId: 's1', accountId: 'a1' }) });
});

afterEach(() => {
    state.summaries = [];
    state.withoutUsage = [];
    state.policies = [];
    state.persisted = null;
    state.saved = [];
    vi.resetModules();
});

function liveSummary(fetchedAt: number): ConnectedServiceQuotaSummary {
    return {
        key: 'claude/work',
        serviceLabel: 'Claude subscription',
        serviceGroupKey: 'anthropic/claude',
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
        legacyServiceId: 'claude-subscription',
        accountLabel: 'Work',
        accountEmail: 'kevin@gmail.com',
        accountId: 'work',
        profileLabel: 'Work',
        profileId: 'work',
        recoveryCredits: null,
        planLabel: 'Max',
        fetchedAt,
        primaryMeter: null,
        meters: [{ meterId: '5h', label: '5-hour', remainingPct: 42, utilizationPct: 58, status: 'ok', resetsAt: 1_000 }],
    };
}

describe('useUsageSummary', () => {
    it('keeps each account reading time and uses the oldest reading for the combined summary', async () => {
        const { buildUsageSummaryCache, buildUsageSummary } = await import('./useUsageSummary');
        const live = buildUsageSummaryCache([
            liveSummary(1_000),
            { ...liveSummary(5_000), key: 'claude/personal' },
        ]);
        expect(live).toMatchObject({
            entries: [{ key: 'claude/work', fetchedAt: 1_000 }, { key: 'claude/personal', fetchedAt: 5_000 }],
        });
        const restored = buildUsageSummary({ live: null, saved: live, accountsWithoutUsage: [] });
        expect(restored.accounts.map((account) => account.fetchedAt)).toEqual([1_000, 5_000]);
        expect(restored.asOf).toBe(1_000);
    });

    it('does not assign an account the combined timestamp when its reading time is unknown', async () => {
        const { buildUsageSummary } = await import('./useUsageSummary');
        const usage = buildUsageSummary({
            live: null,
            saved: {
                v: 1,
                entries: [{ key: 'claude/work', fetchedAt: null, serviceLabel: 'Claude', profileLabel: 'Work', planLabel: null, meters: [] }],
            },
            accountsWithoutUsage: [],
        });
        expect(usage.accounts[0]?.fetchedAt).toBeNull();
        expect(usage.asOf).toBeNull();
    });

    it('shows the last usage this device saw, with its time, before anything is read in this launch', async () => {
        state.persisted = {
            v: 1,
            entries: [{ key: 'claude/work', fetchedAt: 500, serviceLabel: 'Claude subscription', profileLabel: 'Work', planLabel: 'Max',
                meters: [{ meterId: '5h', label: '5h', remainingPct: 42, resetsAt: 1_000, status: 'ok' }] }],
        };
        const { useUsageSummary } = await import('./useUsageSummary');
        const hook = await renderHook(() => useUsageSummary({ load: 'cache' }));

        expect(hook.getCurrent()).toMatchObject({ source: 'lastKnown', asOf: 500 });
        expect(hook.getCurrent().entries.map((entry) => entry.key)).toEqual(['claude/work']);
        // A summary that must not start reads asks the owner for cached answers only.
        expect(new Set(state.policies)).toEqual(new Set(['cache_only']));
    });

    it('prefers what this launch read and keeps it on the device with its time', async () => {
        state.summaries = [liveSummary(2_000)];
        const { useUsageSummary } = await import('./useUsageSummary');
        const hook = await renderHook(() => useUsageSummary({ load: 'visible' }));
        await flushHookEffects({ cycles: 2 });

        expect(hook.getCurrent()).toMatchObject({ source: 'live', asOf: 2_000 });
        expect(new Set(state.policies)).toEqual(new Set(['poll']));
        expect(state.saved.at(-1)).toMatchObject({
            v: 1,
            entries: [{ key: 'claude/work', fetchedAt: 2_000, meters: [{ meterId: '5h', remainingPct: 42, resetsAt: 1_000 }] }],
        });
    });

    it('hands every connected account to its readers, grouped by provider, with each account\'s own state', async () => {
        state.summaries = [liveSummary(2_000)];
        state.withoutUsage = [{
            key: 'claude/home', serviceLabel: 'Claude subscription', legacyServiceId: 'claude-subscription',
            serviceGroupKey: 'anthropic/claude', accountLabel: null, accountEmail: 'kevin@gmail.com', accountId: 'home',
            state: 'unavailable',
        }];
        const { useUsageSummary } = await import('./useUsageSummary');
        const hook = await renderHook(() => useUsageSummary({ load: 'visible' }));
        await flushHookEffects({ cycles: 2 });

        expect(hook.getCurrent().accounts).toEqual([
            expect.objectContaining({
                key: 'claude/work', serviceGroupKey: 'anthropic/claude', legacyServiceId: 'claude-subscription',
                accountLabel: 'Work', accountEmail: 'kevin@gmail.com', accountId: 'work', planLabel: 'Max', state: 'ready',
            }),
            expect.objectContaining({
                key: 'claude/home', accountLabel: null, accountEmail: 'kevin@gmail.com', accountId: 'home',
                state: 'unavailable', meters: [],
            }),
        ]);
        // The device keeps the provider and account names with the values, for its next launch.
        expect(state.saved.at(-1)).toMatchObject({
            entries: [{
                key: 'claude/work', serviceGroupKey: 'anthropic/claude', legacyServiceId: 'claude-subscription', accountLabel: 'Work',
                accountEmail: 'kevin@gmail.com', accountId: 'work',
            }],
        });
    });

    it('keeps an account without a supplied name unnamed', async () => {
        state.persisted = {
            v: 1,
            entries: [{ key: 'claude/work', fetchedAt: null, serviceLabel: 'Claude subscription', profileLabel: null, planLabel: null, meters: [] }],
        };
        const { useUsageSummary } = await import('./useUsageSummary');
        const hook = await renderHook(() => useUsageSummary({ load: 'cache' }));
        expect(hook.getCurrent().accounts).toEqual([expect.objectContaining({
            // No name was saved: the account line stays empty rather than repeating the provider.
            key: 'claude/work', serviceGroupKey: 'Claude subscription', legacyServiceId: null,
            accountLabel: null, accountEmail: null, accountId: null, state: 'ready',
        })]);
    });

    it('has nothing to show without a read or a saved value', async () => {
        const { useUsageSummary } = await import('./useUsageSummary');
        const hook = await renderHook(() => useUsageSummary({ load: 'cache' }));
        expect(hook.getCurrent()).toMatchObject({ source: 'none', asOf: null, entries: [] });
    });
});
