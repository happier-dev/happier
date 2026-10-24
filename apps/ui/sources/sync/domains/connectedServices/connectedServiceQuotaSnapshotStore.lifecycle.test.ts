import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appStateEmitter = vi.hoisted(async () => {
    const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeAppStateEmitter('active');
});
const getSnapshotPlain = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<import('@happier-dev/protocol').ConnectedServiceQuotaSnapshotV1 | null>>(async () => null));
const requestRefresh = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return 'web'; } },
        AppState: (await appStateEmitter).appState,
    });
});
vi.mock('@/utils/platform/tauri', () => ({ isTauriDesktop: () => false }));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: getSnapshotPlain,
    requestConnectedServiceQuotaSnapshotRefreshV3: requestRefresh,
}));

import {
    __resetConnectedServiceQuotaSnapshotStore,
    buildQuotaSnapshotScopeKey,
    getQuotaSnapshotEntry,
    refreshQuotaSnapshot,
    retainQuotaSnapshotPolling,
    subscribeQuotaSnapshotEntry,
} from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';

const ctx = {
    credentials: { token: 't', secret: 's' },
    credentialScope: 'scope',
    serviceId: 'openai-codex',
    profileId: 'work',
    resolveAccountMode: async () => 'plain' as const,
} as const;

describe('connectedServiceQuotaSnapshotStore polling lifecycle', () => {
    const globalWithDocument = globalThis as unknown as { document?: { visibilityState?: string } };
    const originalDocument = globalWithDocument.document;

    beforeEach(async () => {
        vi.useFakeTimers();
        globalWithDocument.document = { visibilityState: 'visible' };
        (await appStateEmitter).emit('active');
        __resetConnectedServiceQuotaSnapshotStore();
        getSnapshotPlain.mockReset();
        getSnapshotPlain.mockResolvedValue(null);
        requestRefresh.mockReset();
        requestRefresh.mockResolvedValue(true);
    });

    afterEach(() => {
        __resetConnectedServiceQuotaSnapshotStore();
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
    });


    it('preserves the public snapshot and suppresses notifications when polling release changes no visible state', async () => {
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const snapshot = getQuotaSnapshotEntry(key);
        const onChange = vi.fn();
        const unsubscribe = subscribeQuotaSnapshotEntry(key, onChange);

        release();

        expect(getQuotaSnapshotEntry(key)).toBe(snapshot);
        expect(onChange).not.toHaveBeenCalled();
        unsubscribe();
    });

    it.each(['snapshot', 'error'] as const)('keeps accepted refresh pending beyond the old cutoff until a newer %s arrives', async (outcome) => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        };
        getSnapshotPlain.mockResolvedValue(snapshot);
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        void refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(11_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        await vi.advanceTimersByTimeAsync(49_000);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        if (outcome === 'snapshot') getSnapshotPlain.mockResolvedValue({ ...snapshot, fetchedAt: 2 });
        else getSnapshotPlain.mockRejectedValue(new Error('Quota read failed'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(false);
        expect(getQuotaSnapshotEntry(key).snapshot?.fetchedAt).toBe(outcome === 'snapshot' ? 2 : 1);
        expect(getQuotaSnapshotEntry(key).error === null).toBe(outcome === 'snapshot');
        release();
    });


    it('retains the last snapshot when a pending refresh read temporarily has no data', async () => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        };
        getSnapshotPlain.mockResolvedValue(snapshot);
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        getSnapshotPlain.mockResolvedValue(null);
        void refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(getQuotaSnapshotEntry(key).snapshot).toEqual(snapshot);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        release();
    });


    it.each(['snapshot', 'error'] as const)('retries a cancelled unresolved refresh and receives a newer %s', async (outcome) => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        };
        getSnapshotPlain.mockResolvedValue(snapshot);
        let finishRequest!: (accepted: boolean) => void;
        requestRefresh.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishRequest = resolve; }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const first = refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        release();
        const releaseAgain = retainQuotaSnapshotPolling(key, ctx);
        const retry = refreshQuotaSnapshot(key, ctx);
        const joinedRetry = refreshQuotaSnapshot(key, ctx);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        expect(requestRefresh).toHaveBeenCalledTimes(1);
        finishRequest(true);
        await Promise.all([first, retry, joinedRetry]);
        expect(requestRefresh).toHaveBeenCalledTimes(2);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        if (outcome === 'snapshot') getSnapshotPlain.mockResolvedValue({ ...snapshot, fetchedAt: 2 });
        else getSnapshotPlain.mockRejectedValue(new Error('Quota read failed'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({
            refreshing: false,
            snapshot: { fetchedAt: outcome === 'snapshot' ? 2 : 1 },
            error: outcome === 'snapshot' ? null : 'Quota read failed',
        });
        releaseAgain();
    });

    it.each(['join', 'cancel'] as const)('does not restart an unresolved refresh on %s', async (intent) => {
        let finishRequest!: (accepted: boolean) => void;
        requestRefresh.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishRequest = resolve; }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const first = refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const joined = intent === 'join' ? refreshQuotaSnapshot(key, ctx) : undefined;
        if (intent === 'cancel') release();
        finishRequest(true);
        await Promise.all([first, joined]);
        expect(requestRefresh).toHaveBeenCalledTimes(1);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(intent === 'join' ? 2 : 1);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(intent === 'join');
        release();
    });

    it('cancels pending refresh polling when the last consumer leaves', async () => {
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        void refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(11_000);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        release();
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(false);
        const reads = getSnapshotPlain.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(getSnapshotPlain.mock.calls.length).toBe(reads);
    });

    it('surfaces a rejected refresh without continuing the pending state', async () => {
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        requestRefresh.mockRejectedValueOnce(new Error('Refresh refused'));
        void refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(11_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: false, error: 'Refresh refused' });
        release();
    });


    it('stops fetching quota snapshots while the app is backgrounded and refetches on return', async () => {
        const key = buildQuotaSnapshotScopeKey('scope', 'openai-codex', 'work');

        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);

        (await appStateEmitter).emit('background');
        await vi.advanceTimersByTimeAsync(30_000 * 4);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);

        (await appStateEmitter).emit('active');
        await vi.advanceTimersByTimeAsync(0);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);

        release();
    });
});
