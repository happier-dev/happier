import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, plainQuotaResponse,
    resetConnectedServiceQuotaSnapshotsTestState } from './useConnectedServiceQuotaSnapshots.testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    __resetConnectedServiceQuotaSnapshotStore, buildQuotaSnapshotScopeKey, getQuotaSnapshotEntry,
    refreshQuotaSnapshot, retainQuotaSnapshotPolling, retainQuotaSnapshotOnce, subscribeQuotaSnapshotEntry,
    type QuotaSnapshotRefreshContext,
} from './connectedServiceQuotaSnapshotStore';

let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
let getSnapshotPlain: typeof boundary.plainRead;
let requestRefresh: typeof boundary.refreshRead;
let ctx: QuotaSnapshotRefreshContext;

describe('connectedServiceQuotaSnapshotStore polling lifecycle', () => {
    const globalWithDocument = globalThis as unknown as { document?: Document | EventTarget & { visibilityState: string } };
    const originalDocument = globalWithDocument.document;
    let documentBoundary: EventTarget & { visibilityState: string };

    beforeEach(async () => {
        await resetConnectedServiceQuotaSnapshotsTestState();
        boundary = await createLegacyQuotaTestHarness();
        const { useConnectedServiceLegacyOperationAdmission } = await import('./useConnectedServiceLegacyOperationAdmission');
        const admission = await renderHook(() => useConnectedServiceLegacyOperationAdmission(), { wrapper: Wrapper });
        const active = getActiveServerSnapshot();
        ctx = { credentials: boundary.account.credentials, credentialScope: boundary.context().credentialScope,
            serverBasis: { serverId: active.serverId, generation: active.generation },
            serviceId: 'openai-codex', profileId: 'work',
            resolveAccountMode: async () => (await fetchAccountEncryptionMode(boundary.account.credentials)).mode,
            assertOperationAllowed: operation => admission.getCurrent()('openai-codex', operation) };
        documentBoundary = Object.assign(new EventTarget(), { visibilityState: 'visible' });
        globalWithDocument.document = documentBoundary;
        getSnapshotPlain = boundary.plainRead;
        requestRefresh = boundary.refreshRead;
        getSnapshotPlain.mockImplementation(async () => plainQuotaResponse(null));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        __resetConnectedServiceQuotaSnapshotStore();
        standardCleanup();
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
        await boundary.dispose();
        vi.restoreAllMocks();
    });

    it('reads an unchanged-material refresh completion on its push and stops on departure', async () => {
        const snapshot = { v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [] };
        let refreshRequestedAt: number | undefined;
        getSnapshotPlain.mockImplementation(async () => Response.json({ content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: 0, status: 'ok', refreshRequestedAt } }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotOnce(key, ctx);
        const unsubscribe = subscribeQuotaSnapshotEntry(key, () => {});
        await vi.advanceTimersByTimeAsync(0);
        await flushHookEffects();
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
        await vi.advanceTimersByTimeAsync(60_000);
        await flushHookEffects();
        expect(getSnapshotPlain).toHaveBeenCalledTimes(1);
        // A real daemon keeps heartbeating during the idle minute; cached quota reads do not.
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applyMachines(Object.values(storage.getState().machines).map(machine => ({
            ...machine, activeAt: Date.now(),
        })), true, { sourceServerId: ctx.serverBasis!.serverId });
        refreshRequestedAt = snapshot.fetchedAt;
        await refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(60_000);
        await flushHookEffects();
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);
        refreshRequestedAt = undefined;
        publishHomeAccountChange(ctx.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.advanceTimersByTimeAsync(0);
        await flushHookEffects();
        expect(getSnapshotPlain).toHaveBeenCalledTimes(3);
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, refreshing: false, snapshot }));
        unsubscribe();
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(false);
        const reads = getSnapshotPlain.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getSnapshotPlain.mock.calls.length).toBe(reads);
        release();
    });

    it.each(['zero', 'missing'] as const)('does not invent healthy reads for a %s predecessor interval', async kind => {
        // 0.2 V2 maps absent producer staleAfterMs to zero; an absent record is a 404.
        const snapshot = kind === 'zero' ? { v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [] } : null;
        getSnapshotPlain.mockImplementation(async () => snapshot ? Response.json({
            content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: 0, status: 'ok' },
        }) : plainQuotaResponse(null));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        try {
            await vi.advanceTimersByTimeAsync(0);
            await flushHookEffects();
            await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
            expect(getSnapshotPlain).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(60_000);
            await flushHookEffects();
            expect(getSnapshotPlain).toHaveBeenCalledTimes(1);
            publishHomeAccountChange(ctx.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await vi.advanceTimersByTimeAsync(0);
            await flushHookEffects();
            expect(getSnapshotPlain).toHaveBeenCalledTimes(2);
        } finally { release(); }
    });

    it.each(['snapshot', 'error'] as const)('keeps accepted refresh pending beyond the old cutoff until a newer %s arrives', async (outcome) => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        };
        getSnapshotPlain.mockImplementation(async () => Response.json({ content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok', refreshRequestedAt: snapshot.fetchedAt } }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
        void refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(11_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        await vi.advanceTimersByTimeAsync(49_000);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        if (outcome === 'snapshot') getSnapshotPlain.mockImplementation(async () => plainQuotaResponse({ ...snapshot, fetchedAt: 2 }));
        else getSnapshotPlain.mockImplementation(async () => Response.json({ error: 'Quota read failed' }, { status: 400 }));
        publishHomeAccountChange(ctx.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, refreshing: false }));
        expect(getQuotaSnapshotEntry(key).snapshot?.fetchedAt).toBe(outcome === 'snapshot' ? 2 : 1);
        expect(getQuotaSnapshotEntry(key).error === null).toBe(outcome === 'snapshot');
        release();
    });


    it('retains the last snapshot when a pending refresh read temporarily has no data', async () => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        };
        getSnapshotPlain.mockImplementation(async () => plainQuotaResponse(snapshot));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
        getSnapshotPlain.mockImplementation(async () => plainQuotaResponse(null));
        void refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(getQuotaSnapshotEntry(key).snapshot).toEqual(snapshot);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);
        release();
    });


    it.each(['poll', 'cached'] as const)('retries a cancelled unresolved refresh for a %s consumer', async (policy) => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [],
        };
        getSnapshotPlain.mockImplementation(async () => Response.json({ content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok', refreshRequestedAt: snapshot.fetchedAt } }));
        let finishRequest!: (response: Response) => void;
        requestRefresh.mockReturnValueOnce(new Promise<Response>((resolve) => { finishRequest = resolve; }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const retain = () => {
            const release = policy === 'poll' ? retainQuotaSnapshotPolling(key, ctx) : retainQuotaSnapshotOnce(key, ctx);
            const unsubscribe = subscribeQuotaSnapshotEntry(key, () => {});
            return () => { unsubscribe(); release(); };
        };
        const release = retain();
        await vi.advanceTimersByTimeAsync(0);
        const first = refreshQuotaSnapshot(key, ctx);
        await vi.waitFor(() => expect(requestRefresh).toHaveBeenCalledTimes(1));
        release();
        const releaseAgain = retain();
        const retry = refreshQuotaSnapshot(key, ctx);
        const joinedRetry = refreshQuotaSnapshot(key, ctx);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        expect(requestRefresh).toHaveBeenCalledTimes(1);
        finishRequest(Response.json({ success: true }));
        await Promise.all([first, retry, joinedRetry]);
        expect(requestRefresh).toHaveBeenCalledTimes(2);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        getSnapshotPlain.mockImplementation(async () => plainQuotaResponse({ ...snapshot, fetchedAt: 2 }));
        publishHomeAccountChange(ctx.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, refreshing: false, snapshot: { fetchedAt: 2 }, error: null }));
        releaseAgain();
    });

    it.each(['join', 'cancel'] as const)('does not restart an unresolved refresh on %s', async (intent) => {
        let finishRequest!: (response: Response) => void;
        requestRefresh.mockReturnValueOnce(new Promise<Response>((resolve) => { finishRequest = resolve; }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const first = refreshQuotaSnapshot(key, ctx);
        await vi.waitFor(() => expect(requestRefresh).toHaveBeenCalledTimes(1));
        const joined = intent === 'join' ? refreshQuotaSnapshot(key, ctx) : undefined;
        if (intent === 'cancel') release();
        finishRequest(Response.json({ success: true }));
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
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
        requestRefresh.mockImplementationOnce(async () => Response.json({ error: 'Refresh refused' }, { status: 400 }));
        await refreshQuotaSnapshot(key, ctx);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: false, error: 'Refresh refused' });
        release();
    });


    it('stops fetching quota snapshots while the app is backgrounded and refetches on return', async () => {
        const snapshot = { v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30_000, planLabel: null, accountLabel: null, meters: [] };
        getSnapshotPlain.mockImplementation(async () => plainQuotaResponse(snapshot));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);

        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
        expect(getSnapshotPlain).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(getSnapshotPlain).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(getQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));

        documentBoundary.visibilityState = 'hidden';
        documentBoundary.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(30_000 * 4);
        expect(getSnapshotPlain).toHaveBeenCalledTimes(2);

        documentBoundary.visibilityState = 'visible';
        documentBoundary.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(getSnapshotPlain).toHaveBeenCalledTimes(3));

        release();
    });
});
