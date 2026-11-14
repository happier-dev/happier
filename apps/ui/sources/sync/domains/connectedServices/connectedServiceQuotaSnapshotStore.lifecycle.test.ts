import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema, sealProviderAccountUsageSnapshotCiphertext } from '@happier-dev/protocol';

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
// HTTP is the system boundary; adapters, envelope parsing, crypto and the store stay real.
let readMetadata: Record<string, unknown> | null = null;
let sealedReads = false;
vi.mock('@/sync/http/client', () => ({
    serverFetch: async (url: string) => {
        if (url.endsWith('/refresh')) {
            try {
                const accepted = await requestRefresh();
                return Response.json({ success: accepted }, { status: accepted ? 200 : 404 });
            } catch (error) {
                return Response.json({ error: error instanceof Error ? error.message : 'refresh_failed' }, { status: 403 });
            }
        }
        if (url.startsWith('/v2/') && !sealedReads) return Response.json({ error: 'not_found' }, { status: 404 });
        const metadataAtRead = readMetadata;
        let snapshot;
        try {
            snapshot = await getSnapshotPlain();
        } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : 'read_failed' }, { status: 403 });
        }
        if (!snapshot) return Response.json({ error: 'not_found' }, { status: 404 });
        const metadata = metadataAtRead ?? {
            fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok',
            ...(snapshot.fetchedAt <= 1 ? { refreshRequestedAt: 2 } : {}),
        };
        return Response.json(url.startsWith('/v3/')
            ? { content: { t: 'plain', v: snapshot }, metadata }
            : { sealed: { format: 'account_scoped_v1', ciphertext: sealProviderAccountUsageSnapshotCiphertext({
                material: { type: 'legacy', secret: new Uint8Array(32) },
                payload: ProviderAccountUsageSnapshotV1Schema.parse({
                    v: 1, recordId: buildProviderAccountUsageRecordId({ providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' }),
                    recordKey: { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' },
                    providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' },
                    observedAtMs: snapshot.fetchedAt, fetchedAtMs: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs,
                    source: 'providerHttp', confidence: 'confirmed',
                    state: metadata.status === 'error' ? 'error_last_known_good' : 'loaded_data',
                    planLabel: snapshot.planLabel, accountLabel: snapshot.accountLabel, meters: snapshot.meters,
                    ...(metadata.status === 'error' ? { diagnostics: [{ kind: 'provider_http', observedAtMs: metadata.refreshErrorAt ?? 2, ...snapshot.evidence }] } : {}),
                }),
                randomBytes: (n) => new Uint8Array(n).fill(9),
            }) }, metadata });
    },
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
    credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
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
        readMetadata = null;
        sealedReads = false;
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


    it('preserves an accepted pending refresh beyond the removed five-minute cutoff', async () => {
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
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, error: null });

        // Elapsed UI time does not attest whether the canonical request has settled.
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        release();
    });


    it.each(['plain', 'e2ee'] as const)('settles a recorded %s refresh failure without changing the provider observation or meters', async (mode) => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null,
            meters: [{ meterId: 'five_hour', label: '5-hour', used: 5, limit: 10, unit: 'requests' as const,
                utilizationPct: 50, resetsAt: null, status: 'ok' as const, details: {} }],
        };
        sealedReads = mode === 'e2ee';
        const context = { ...ctx, resolveAccountMode: async () => mode };
        getSnapshotPlain.mockResolvedValue(snapshot);
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, context);
        await vi.advanceTimersByTimeAsync(0);
        await refreshQuotaSnapshot(key, context);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(true);

        // The server settled this attempt; the old provider observation is still honest.
        readMetadata = { fetchedAt: 1, staleAfterMs: snapshot.staleAfterMs, status: 'error', refreshErrorAt: 2 };
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: false, snapshot });
        expect(getQuotaSnapshotEntry(key).error).toBeTruthy();
        release();
    });

    it('keeps showing last-known meters without an error when a background refresh failed', async () => {
        const snapshot = {
            v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null,
            meters: [{ meterId: 'five_hour', label: '5-hour', used: 5, limit: 10, unit: 'requests' as const,
                utilizationPct: 50, resetsAt: null, status: 'ok' as const, details: {} }],
            evidence: { headers: { 'retry-after': new Date(Date.now() + 60 * 60_000).toISOString() } },
        };
        getSnapshotPlain.mockResolvedValue(snapshot);
        // The daemon's own poll was throttled upstream; no refresh was requested from this client.
        readMetadata = { fetchedAt: 1, staleAfterMs: snapshot.staleAfterMs, status: 'error', refreshErrorAt: 2 };
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ snapshot: { meters: snapshot.meters }, refreshing: false, error: null });
        release();
    });

    it('keeps a newer snapshot pending while the authoritative refresh marker remains', async () => {
        const snapshot = { v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] };
        getSnapshotPlain.mockResolvedValue(snapshot);
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        await refreshQuotaSnapshot(key, ctx);
        getSnapshotPlain.mockResolvedValue({ ...snapshot, fetchedAt: 2 });
        readMetadata = { fetchedAt: 2, staleAfterMs: 60_000, status: 'error', refreshRequestedAt: 3, refreshErrorAt: 1 };
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot: { fetchedAt: 2 }, error: null });
        readMetadata = { fetchedAt: 2, staleAfterMs: 60_000, status: 'ok' };
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: false, snapshot: { fetchedAt: 2 }, error: null });
        release();
    });

    it('does not let a read begun before the request settle the new refresh intent', async () => {
        const snapshot = { v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] };
        let finishRead!: (value: typeof snapshot) => void;
        getSnapshotPlain.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
        getSnapshotPlain.mockResolvedValue(snapshot);
        readMetadata = { fetchedAt: 1, staleAfterMs: 60_000, status: 'ok' };
        requestRefresh.mockImplementationOnce(async () => {
            readMetadata = { fetchedAt: 1, staleAfterMs: 60_000, status: 'ok', refreshRequestedAt: 2 };
            return true;
        });
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const refresh = refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(requestRefresh).not.toHaveBeenCalled();
        finishRead(snapshot);
        await refresh;
        expect(requestRefresh).toHaveBeenCalledTimes(1);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        release();
    });

    it('does not let a read begun during the refresh request settle its accepted intent', async () => {
        const snapshot = { v: 1 as const, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] };
        getSnapshotPlain.mockResolvedValue(snapshot);
        readMetadata = { fetchedAt: 1, staleAfterMs: 60_000, status: 'ok' };
        let finishRequest!: (accepted: boolean) => void;
        requestRefresh.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishRequest = resolve; }));
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        const refresh = refreshQuotaSnapshot(key, ctx);
        await vi.advanceTimersByTimeAsync(60_000);

        // Another mounted consumer starts an overdue read before the POST records its marker.
        let finishRead!: (value: typeof snapshot) => void;
        getSnapshotPlain.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
        const releaseAgain = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        expect(getQuotaSnapshotEntry(key).loading).toBe(true);
        readMetadata = { fetchedAt: 1, staleAfterMs: 60_000, status: 'ok', refreshRequestedAt: 2 };
        finishRequest(true);
        await vi.advanceTimersByTimeAsync(0);
        finishRead(snapshot);
        await refresh;

        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
        readMetadata = { fetchedAt: 1, staleAfterMs: 60_000, status: 'error', refreshErrorAt: 2 };
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getQuotaSnapshotEntry(key).refreshing).toBe(false);
        expect(getQuotaSnapshotEntry(key).error).toBeTruthy();
        releaseAgain();
        release();
    });

    it('surfaces a settled failure with an empty snapshot when there was no prior observation', async () => {
        const key = buildQuotaSnapshotScopeKey(ctx.credentialScope, ctx.serviceId, ctx.profileId);
        const release = retainQuotaSnapshotPolling(key, ctx);
        await vi.advanceTimersByTimeAsync(0);
        getSnapshotPlain.mockResolvedValue({ v: 1, serviceId: ctx.serviceId, profileId: ctx.profileId,
            fetchedAt: 0, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] });
        readMetadata = { fetchedAt: 0, staleAfterMs: 60_000, status: 'error', refreshErrorAt: 2 };
        await refreshQuotaSnapshot(key, ctx);
        expect(getQuotaSnapshotEntry(key)).toMatchObject({ refreshing: false, snapshot: { fetchedAt: 0, meters: [] } });
        expect(getQuotaSnapshotEntry(key).error).toBeTruthy();
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
