import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from './qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness } from './qualifiedConnectedAccountQuotaTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import {
    resolveConnectedServiceSettingsErrorMessage,
} from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import { t } from '@/text';

const {
    getQuotaMock,
    snapshotFixture,
    runtime,
} = vi.hoisted(() => ({
    getQuotaMock: vi.fn(),
    snapshotFixture: vi.fn(),
    runtime: { active: true, listeners: new Set<() => void>() },
}));

// Runtime visibility is an environment boundary; keep the reader/store real.
vi.mock('@/utils/runtime/isRuntimeActive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/runtime/isRuntimeActive')>(),
    isRuntimeActive: () => runtime.active,
    subscribeToRuntimeActiveChange: (listener: () => void) => {
        runtime.listeners.add(listener);
        return () => runtime.listeners.delete(listener);
    },
}));

function setRuntimeActive(active: boolean): void {
    runtime.active = active;
    for (const listener of [...runtime.listeners]) listener();
}

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/account/apiQualifiedConnectedAccountsV4')>(),
    getQualifiedConnectedAccountQuotaV4: async (...args: unknown[]) => {
        const response = await getQuotaMock(...args);
        if (!response) return null;
        const snapshot = { ...snapshotFixture({ response }), activeAccountId: 'provider-work' };
        return {
            ref: snapshot.ref,
            sourceResolution: {
                source: { ref: snapshot.ref, bindingKind: 'account' },
                recordId: 'paug_v1_testrecord',
                providerAccountId: snapshot.activeAccountId,
                fetchedAt: snapshot.fetchedAt,
                staleAfterMs: snapshot.staleAfterMs,
            },
            content: { t: 'plain', v: snapshot },
            metadata: {
                fetchedAt: snapshot.fetchedAt,
                staleAfterMs: snapshot.staleAfterMs,
                status: response.metadata?.status ?? 'ok',
            },
        };
    },
}));

let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
const ref = {
    service: {
        pluginId: 'happier.agent.claude',
        localId: 'anthropic',
    },
    accountId: 'work',
};
const sourceResolution = { recordId: 'pau-record' };

function buildContext(serverId: string, generation: number) {
    const current = getActiveServerSnapshot();
    return {
        credentials: boundary.account.credentials,
        credentialScope: `${serverId}\u0000credentials`,
        ref,
        serverBasis: {
            serverId: serverId === 'server-a' ? current.serverId : serverId,
            generation: serverId === 'server-a' && generation === 1 ? current.generation : generation,
        },
    };
}

async function flushAsyncTurns(turns = 8): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
    }
}

describe('qualifiedConnectedAccountQuotaSnapshotStore', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        runtime.active = true;
        boundary = await createQualifiedQuotaTestHarness();
    });
    afterEach(async () => {
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        await boundary?.dispose();
        vi.restoreAllMocks();
    });

    it('parks retained reads while inactive and refreshes immediately on return, retaining the last snapshot', async () => {
        vi.useFakeTimers();
        const store = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const initialListeners = new Set(runtime.listeners);
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        setRuntimeActive(false);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        const retainedListeners = [...runtime.listeners].filter((listener) => !initialListeners.has(listener));
        try {
            expect(retainedListeners.length).toBeGreaterThan(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(getQuotaMock).not.toHaveBeenCalled();
            setRuntimeActive(true);
            await flushAsyncTurns();
            expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toEqual(snapshot);
            expect(getQuotaMock).toHaveBeenCalledTimes(1);

            setRuntimeActive(false);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toEqual(snapshot);
            snapshotFixture.mockReturnValue({ ...snapshot, fetchedAt: 2 });
            setRuntimeActive(true);
            await flushAsyncTurns();
            expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.fetchedAt).toBe(2);
            expect(getQuotaMock).toHaveBeenCalledTimes(2);
            setRuntimeActive(false);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(getQuotaMock).toHaveBeenCalledTimes(2);
        } finally {
            release();
            store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
            // Account restoration may add its own listener asynchronously;
            // only listeners acquired by this retain must be detached here.
            for (const listener of retainedListeners) expect(runtime.listeners.has(listener)).toBe(false);
            vi.useRealTimers();
        }
    });

    it.each([
        { fetchPolicy: 'poll', refused: false },
        { fetchPolicy: 'once', refused: false },
        { fetchPolicy: 'once', refused: true },
    ] as const)('reloads the consumed account in the admitted Home generation without requesting another provider refresh ($fetchPolicy, refused=$refused)', async ({ fetchPolicy, refused }) => {
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const store = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const current = buildContext('server-a', 1);
        const other = buildContext('server-b', 1);
        const currentKey = store.buildQualifiedQuotaSnapshotScopeKey(current);
        const otherKey = store.buildQualifiedQuotaSnapshotScopeKey(other);
        const releaseOther = store.retainQualifiedQuotaSnapshotPolling(otherKey, other);
        const releaseCurrent = fetchPolicy === 'poll'
            ? store.retainQualifiedQuotaSnapshotPolling(currentKey, current)
            : store.loadQualifiedQuotaSnapshotOnce(currentKey, current);
        await flushAsyncTurns();
        const refreshed = { ...snapshot, fetchedAt: 2, recoveryCredits: { availableCount: 1, credits: [] } };
        snapshotFixture.mockReturnValue(refreshed);
        const receipt = { idempotencyKey: 'manual-1', status: refused ? 'not_available' : 'consumed' };
        boundary.socket.mockResolvedValue(refused
            ? { ok: false, errorCode: 'connected_service_quota_recovery_credit_not_available', error: 'unavailable', receipt }
            : { ok: true, receipt, snapshot: null });
        const { connectedServiceQuotaRecoveryCreditConsume } = await import('@/sync/ops/connectedServiceQuotaRecoveryCredits');
        const result = await connectedServiceQuotaRecoveryCreditConsume({ machineId: 'machine-selected', serviceId: 'anthropic', profileId: ref.accountId });
        expect(result).toMatchObject({ ok: !refused, receipt });
        expect(store.getQualifiedQuotaSnapshotEntry(currentKey).snapshot).toEqual(refreshed);
        expect(store.getQualifiedQuotaSnapshotEntry(otherKey).snapshot).toEqual(snapshot);
        expect(boundary.refresh).not.toHaveBeenCalled();
        releaseCurrent();
        releaseOther();
    });

    it('deduplicates the qualified read across concurrent consumers', async () => {
        const response = { ref, sourceResolution };
        const snapshot = {
            v: 1,
            ref,
            activeAccountId: 'provider-work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };
        getQuotaMock.mockResolvedValue(response);
        snapshotFixture.mockReturnValue(snapshot);
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = buildQualifiedQuotaSnapshotScopeKey(context);

        const releaseFirst =
            retainQualifiedQuotaSnapshotPolling(key, context);
        const releaseSecond =
            retainQualifiedQuotaSnapshotPolling(key, context);
        await flushAsyncTurns();

        expect(getQuotaMock).toHaveBeenCalledOnce();
        expect(getQualifiedQuotaSnapshotEntry(key)).toEqual(
            expect.objectContaining({
                snapshot,
                supported: true,
                loading: false,
                error: null,
            }),
        );
        releaseFirst();
        releaseSecond();
    });

    it('keeps a newly connected account refreshable when its first read has no snapshot', async () => {
        getQuotaMock.mockResolvedValue(null);
        const store = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await flushAsyncTurns();
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                snapshot: null,
                supported: null,
                read: true,
                loading: false,
            });
            await store.refreshQualifiedQuotaSnapshot(key, context);
            expect(boundary.controls).toEqual([{ machineId: 'machine-selected', command: { operation: 'describeService', service: ref.service, requiredOperation: 'quota_refresh' } }]);
            expect(boundary.refresh).toHaveBeenCalledWith(ref);
            expect(getQuotaMock).toHaveBeenCalledTimes(2);
        } finally {
            release();
        }
    });

    it('shows a producer refresh failure while retaining its last-known usage', async () => {
        const snapshot = {
            v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1,
            staleAfterMs: 60_000, planLabel: 'Existing plan', accountLabel: null, meters: [],
        };
        snapshotFixture.mockReturnValue(snapshot);
        getQuotaMock.mockResolvedValue({ metadata: { status: 'error' } });
        const store = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await flushAsyncTurns();
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                snapshot,
                supported: true,
                loading: false,
                error: t('connectedServices.errors.quotaRefreshFailed'),
            });
        } finally {
            release();
        }
    });

    it('marks quota support unavailable only when refresh admission proves the operation unsupported', async () => {
        getQuotaMock.mockResolvedValue(null);
        const store = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        boundary.control.mockResolvedValue({ status: 'unavailable', code: 'connected_account_v4_operation_unsupported' });
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await flushAsyncTurns();
            await store.refreshQualifiedQuotaSnapshot(key, context);
            expect(store.getQualifiedQuotaSnapshotEntry(key).supported).toBe(false);
            expect(boundary.refresh).not.toHaveBeenCalled();
        } finally {
            release();
        }
    });

    it('shows safe provider retry guidance and clears it after a successful observation', async () => {
        const retryAtMs = Date.now() + 60_000;
        const snapshot = {
            v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1,
            staleAfterMs: 60_000, planLabel: 'Existing plan', accountLabel: null, meters: [],
            diagnostics: [{
                kind: 'provider_http', code: 'provider_backoff', status: 429,
                message: 'Untranslated provider detail', observedAtMs: 1, retryAtMs,
                headers: { 'x-provider-detail': 'Untranslated header detail' },
            }],
        };
        snapshotFixture.mockReturnValue(snapshot);
        getQuotaMock.mockResolvedValue({ metadata: { status: 'error' } });
        const store = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await flushAsyncTurns();
            const entry = store.getQualifiedQuotaSnapshotEntry(key);
            expect(entry.snapshot).toEqual(snapshot);
            expect(entry.error).toBe(t('connectedServices.errors.quotaRefreshRetryAt', {
                error: `${t('connectedServices.errors.quotaRefreshFailed')} (HTTP 429)`,
                time: new Date(retryAtMs).toLocaleString(),
            }));
            expect(entry.error).not.toContain('Untranslated');
            expect(entry.error).not.toContain('provider_backoff');

            const recovered = { ...snapshot, fetchedAt: 2, diagnostics: [] };
            snapshotFixture.mockReturnValue(recovered);
            getQuotaMock.mockResolvedValue({ metadata: { status: 'ok' } });
            await store.refreshQualifiedQuotaSnapshot(key, context);
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                snapshot: recovered, error: null, supported: true, refreshing: false,
            });
        } finally {
            release();
        }
    });

    it('isolates cache identity by active-server generation', async () => {
        getQuotaMock.mockImplementation(
            async (_credentials, _ref, options) => ({
                ref,
                sourceResolution,
                serverId: options?.expectedActiveServer?.serverId,
            }),
        );
        snapshotFixture.mockImplementation(({ response }) => ({
            v: 1,
            ref,
            fetchedAt: response.serverId === 'server-b' ? 2 : 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [{
                meterId: response.serverId,
                label: response.serverId,
                used: 0,
                limit: 1,
                unit: 'count',
                utilizationPct: 0,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: {},
            }],
        }));
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const serverA = buildContext('server-a', 1);
        const serverB = buildContext('server-b', 2);
        const keyA = buildQualifiedQuotaSnapshotScopeKey(serverA);
        const keyB = buildQualifiedQuotaSnapshotScopeKey(serverB);

        const releaseA = retainQualifiedQuotaSnapshotPolling(keyA, serverA);
        await flushAsyncTurns();
        const releaseB = retainQualifiedQuotaSnapshotPolling(keyB, serverB);
        await flushAsyncTurns();

        expect(keyB).not.toBe(keyA);
        expect(
            getQualifiedQuotaSnapshotEntry(keyA)
                .snapshot?.meters[0]?.meterId,
        ).toBe(getActiveServerSnapshot().serverId);
        expect(
            getQualifiedQuotaSnapshotEntry(keyB)
                .snapshot?.meters[0]?.meterId,
        ).toBe('server-b');
        releaseA();
        releaseB();
    });

    it('keeps the last-known-good snapshot and localizes a failed refresh', async () => {
        const snapshot = {
            v: 1,
            ref,
            activeAccountId: 'provider-work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };
        const failure = Object.assign(new Error('not found'), {
            code: 'connect_group_not_found',
        });
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        boundary.refresh.mockImplementation(async () => new Response(JSON.stringify({ error: failure.code }), { status: 404 }));
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            refreshQualifiedQuotaSnapshot,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = buildQualifiedQuotaSnapshotScopeKey(context);

        const release = retainQualifiedQuotaSnapshotPolling(key, context);
        await flushAsyncTurns();
        await refreshQualifiedQuotaSnapshot(key, context);

        expect(getQualifiedQuotaSnapshotEntry(key)).toEqual(
            expect.objectContaining({
                snapshot,
                supported: true,
                refreshing: false,
                error: resolveConnectedServiceSettingsErrorMessage(failure),
            }),
        );
        release();
    });

    it('does not claim quota support when the first read fails', async () => {
        const failure = Object.assign(new Error('unavailable'), {
            code: 'connected_account_v4_operation_unsupported',
        });
        getQuotaMock.mockRejectedValue(failure);
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = buildQualifiedQuotaSnapshotScopeKey(context);

        const release = retainQualifiedQuotaSnapshotPolling(key, context);
        await flushAsyncTurns();

        expect(getQualifiedQuotaSnapshotEntry(key)).toEqual(
            expect.objectContaining({
                snapshot: null,
                supported: null,
                loading: false,
                error: resolveConnectedServiceSettingsErrorMessage(failure),
            }),
        );
        release();
    });

    it('backs off exponentially while consecutive quota reads keep failing', async () => {
        vi.useFakeTimers();
        try {
            const snapshot = {
                v: 1,
                ref,
                activeAccountId: 'provider-work',
                fetchedAt: 1,
                staleAfterMs: 30_000,
                planLabel: null,
                accountLabel: null,
                meters: [],
            };
            snapshotFixture.mockReturnValue(snapshot);
            getQuotaMock.mockRejectedValue(new Error('unavailable'));
            const {
                buildQualifiedQuotaSnapshotScopeKey,
                retainQualifiedQuotaSnapshotPolling,
            } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
            const context = buildContext('server-a', 1);
            const key = buildQualifiedQuotaSnapshotScopeKey(context);

            const release = retainQualifiedQuotaSnapshotPolling(key, context);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(1);

            // One consecutive failure retries at the 30s floor.
            await vi.advanceTimersByTimeAsync(30_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(2);

            // Two consecutive failures must double the wait instead of
            // hammering the same failing account every 30s forever.
            await vi.advanceTimersByTimeAsync(30_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(30_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(3);

            // A success clears the ladder: the next poll is back at the floor.
            getQuotaMock.mockResolvedValue({ ref, sourceResolution });
            await vi.advanceTimersByTimeAsync(120_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(4);

            getQuotaMock.mockRejectedValue(new Error('unavailable again'));
            await vi.advanceTimersByTimeAsync(30_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(5);
            await vi.advanceTimersByTimeAsync(30_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(6);

            release();
        } finally {
            vi.useRealTimers();
        }
    });

    it('evicts released entries only once their credential scope is superseded', async () => {
        const snapshot = {
            v: 1,
            ref,
            activeAccountId: 'provider-work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('./qualifiedConnectedAccountQuotaSnapshotStore');
        const serverA = buildContext('server-a', 1);
        const serverB = buildContext('server-b', 2);
        const keyA = buildQualifiedQuotaSnapshotScopeKey(serverA);
        const keyB = buildQualifiedQuotaSnapshotScopeKey(serverB);

        const releaseA = retainQualifiedQuotaSnapshotPolling(keyA, serverA);
        await flushAsyncTurns();
        releaseA();

        // Unmounting the only reader keeps the cached snapshot: remounting the
        // same account under the same credential scope must not flash empty.
        expect(getQualifiedQuotaSnapshotEntry(keyA).snapshot).toEqual(snapshot);

        const releaseB = retainQualifiedQuotaSnapshotPolling(keyB, serverB);
        await flushAsyncTurns();

        expect(getQualifiedQuotaSnapshotEntry(keyA).snapshot).toBeNull();
        expect(getQualifiedQuotaSnapshotEntry(keyB).snapshot).toEqual(snapshot);
        releaseB();
    });
});
