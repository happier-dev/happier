import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceQuotaSnapshotV1Schema, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';

const appStateEmitter = vi.hoisted(async () => {
    const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeAppStateEmitter('active');
});
const getSnapshotPlain = vi.hoisted(() => vi.fn<typeof getConnectedServiceQuotaSnapshotPlain>(async () => null));

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
    requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));
vi.mock('@/sync/domains/connectedServices/openConnectedServiceQuotaViewSnapshot', () => ({
    openConnectedServiceQuotaViewSnapshot: vi.fn(() => null),
}));

import {
    __resetConnectedServiceQuotaSnapshotStore,
    buildQuotaSnapshotScopeKey,
    getQuotaSnapshotEntry,
    retainQuotaSnapshotPolling,
} from './connectedServiceQuotaSnapshotStore';

const ctx = {
    credentials: { token: 't', secret: 's' },
    credentialScope: 'scope',
    serviceId: 'openai-codex',
    profileId: 'work',
    resolveAccountMode: async () => 'plain' as const,
} as const;

function makeSnapshot(serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'] = ctx.serviceId): ConnectedServiceQuotaSnapshotV1 {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1, serviceId, profileId: 'work', fetchedAt: Date.now(),
        staleAfterMs: 30_000, planLabel: null, accountLabel: null,
        meters: [{ meterId: 'shared:gemini-weekly', label: 'Gemini · Weekly',
            used: null, limit: null, remainingPct: 70, unit: 'unknown', scope: 'weekly', utilizationPct: 30,
            resetsAt: null, status: 'ok' }],
    });
}

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
    });

    afterEach(() => {
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
    });

    it('stops fetching quota snapshots while the app is backgrounded and refetches on return', async () => {
        getSnapshotPlain.mockResolvedValue(makeSnapshot());
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

    it('shows the first snapshot promptly when the provider source links after the initial miss', async () => {
        const readyAt = Date.now() + 3_000;
        getSnapshotPlain.mockImplementation(async () => Date.now() >= readyAt ? makeSnapshot('antigravity') : null);
        const agyCtx = { ...ctx, serviceId: 'antigravity' } as const;
        const key = buildQuotaSnapshotScopeKey(agyCtx.credentialScope, agyCtx.serviceId, agyCtx.profileId);
        const release = retainQuotaSnapshotPolling(key, agyCtx);

        await vi.advanceTimersByTimeAsync(0);
        expect(getQuotaSnapshotEntry(key).snapshot).toBeNull();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(getQuotaSnapshotEntry(key).snapshot?.meters[0]?.meterId).toBe('shared:gemini-weekly');
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(4);
        release();
    });

    it('limits fast initial misses to ten seconds and then resumes the normal missing cadence', async () => {
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(1);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(7);
        release();
    });

    it('keeps error backoff and does not restart fast retries after a snapshot was available', async () => {
        getSnapshotPlain.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(makeSnapshot());
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(4);
        release();
    });

    it('pauses initial missing retries in the background and catches up on return', async () => {
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        (await appStateEmitter).emit('background');
        getSnapshotPlain.mockResolvedValue(makeSnapshot());
        await vi.advanceTimersByTimeAsync(5_000);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(1);
        (await appStateEmitter).emit('active');
        await vi.advanceTimersByTimeAsync(0);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);
        expect(getQuotaSnapshotEntry(key).snapshot).not.toBeNull();
        release();
    });

    it('does not retry or publish a pending first snapshot after the account or server scope changes', async () => {
        let finishOldLoad!: (value: ConnectedServiceQuotaSnapshotV1) => void;
        getSnapshotPlain.mockImplementationOnce(() => new Promise((resolve) => { finishOldLoad = resolve; }));
        const oldKey = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const releaseOld = retainQuotaSnapshotPolling(oldKey, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const newCtx = { ...ctx, credentials: { token: 'new-account', secret: 'new-secret' }, credentialScope: 'different-server-and-account' };
        const newKey = buildQuotaSnapshotScopeKey(newCtx.credentialScope, newCtx.serviceId, newCtx.profileId);
        const releaseNew = retainQuotaSnapshotPolling(newKey, newCtx);
        await vi.advanceTimersByTimeAsync(0);
        finishOldLoad(makeSnapshot());
        await vi.advanceTimersByTimeAsync(4_000);
        expect(getQuotaSnapshotEntry(oldKey).snapshot).toBeNull();
        expect(getSnapshotPlain).toHaveBeenCalledTimes(4);
        expect(getSnapshotPlain.mock.calls.slice(1).every(([credentials]) => credentials === newCtx.credentials)).toBe(true);
        releaseOld();
        releaseNew();
    });
});
