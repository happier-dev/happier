import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness, quotaTestResponse } from './qualifiedConnectedAccountQuotaTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { QualifiedConnectedAccountQuotaSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

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

let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
function installQuotaReadBoundary(): void {
    // Control HTTP only; the real API, scope admission and ciphertext parser stay live.
    boundary.read.mockImplementation(async requestedRef => {
        const response = await getQuotaMock(requestedRef);
        if (response instanceof Response) return response;
        if (!response) return Response.json({ error: 'connect_quotas_not_found' }, { status: 404 });
        const snapshot = { ...snapshotFixture({ response }), activeAccountId: 'provider-work' };
        return Response.json(quotaTestResponse(snapshot, response.metadata?.status ?? 'ok', response.metadata?.refreshRequestedAt));
    });
}
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
    if (serverId === 'server-a' && generation === 1) return boundary.context(ref);
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
    await flushHookEffects({ cycles: turns, turns });
}

describe('qualifiedConnectedAccountQuotaSnapshotStore', () => {
    it('keeps settled retain and release quiet, preserving the view and equal snapshot through reload', async () => {
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: Date.now(), staleAfterMs: 60_000,
            planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockImplementation(() => ({ ...snapshot, meters: [] }));
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        await flushAsyncTurns();
        await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
        const before = store.getQualifiedQuotaSnapshotEntry(key);
        const listener = vi.fn();
        const unsubscribe = store.subscribeQualifiedQuotaSnapshotEntry(key, listener);
        const releaseAgain = store.retainQualifiedQuotaSnapshotPolling(key, context);
        releaseAgain();
        releaseAgain();
        release();
        expect(store.getQualifiedQuotaSnapshotEntry(key)).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        await store.reloadQualifiedQuotaSnapshotAfterRecovery(context);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBe(before.snapshot);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getQualifiedQuotaSnapshotEntry(key).loading).toBe(false);
        unsubscribe();
    });

    it('publishes the stale deadline once without acquiring another snapshot', async () => {
        vi.useFakeTimers();
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: Date.now(), staleAfterMs: 100,
            planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        await vi.advanceTimersByTimeAsync(0);
        await flushAsyncTurns();
        const before = store.getQualifiedQuotaSnapshotEntry(key);
        expect(before).toMatchObject({ snapshot, loading: false, read: true });
        const listener = vi.fn();
        const unsubscribe = store.subscribeQualifiedQuotaSnapshotEntry(key, listener);
        await vi.advanceTimersByTimeAsync(snapshot.fetchedAt + snapshot.staleAfterMs - Date.now());
        expect(store.getQualifiedQuotaSnapshotEntry(key)).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const stale = store.getQualifiedQuotaSnapshotEntry(key);
        expect(stale).not.toBe(before);
        expect(stale.snapshot).toBe(before.snapshot);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getQuotaMock).toHaveBeenCalledTimes(1);
        release();
        release();
        expect(store.getQualifiedQuotaSnapshotEntry(key)).toBe(stale);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        vi.useRealTimers();
    });

    it.each([
        { intent: 'retry', policy: 'poll' },
        { intent: 'retry', policy: 'cached' },
        { intent: 'join', policy: 'poll' },
        { intent: 'cancel', policy: 'poll' },
    ] as const)('handles an unresolved native refresh on $intent for a $policy consumer', async ({ intent, policy }) => {
        vi.useFakeTimers();
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        let finishRequest!: (response: Response) => void;
        boundary.refresh.mockReturnValueOnce(new Promise<Response>((resolve) => { finishRequest = resolve; }));
        const retain = () => {
            const release = policy === 'poll'
                ? store.retainQualifiedQuotaSnapshotPolling(key, context)
                : store.loadQualifiedQuotaSnapshotOnce(key, context);
            const unsubscribe = store.subscribeQualifiedQuotaSnapshotEntry(key, () => {});
            return () => { unsubscribe(); release(); };
        };
        const release = retain();
        let releaseAgain = () => {};
        try {
            await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                snapshot, loading: false, read: true,
            }));
            getQuotaMock.mockResolvedValue({ ref, sourceResolution, metadata: { refreshRequestedAt: snapshot.fetchedAt + 1 } });
            const first = store.refreshQualifiedQuotaSnapshot(key, context);
            await vi.waitFor(() => expect(boundary.refresh).toHaveBeenCalledTimes(1));
            if (intent !== 'join') release();
            if (intent === 'retry') releaseAgain = retain();
            const retry = intent !== 'cancel' ? store.refreshQualifiedQuotaSnapshot(key, context) : undefined;
            const joined = intent === 'retry' ? store.refreshQualifiedQuotaSnapshot(key, context) : undefined;
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ refreshing: intent !== 'cancel', snapshot, error: null });
            finishRequest(new Response(JSON.stringify({ success: true }), { status: 200 }));
            await Promise.all([first, retry, joined]);
            expect(boundary.refresh).toHaveBeenCalledTimes(intent === 'retry' ? 2 : 1);
            expect(getQuotaMock).toHaveBeenCalledTimes(intent === 'cancel' ? 1 : 2);
            snapshotFixture.mockReturnValue({ ...snapshot, fetchedAt: 2 });
            getQuotaMock.mockResolvedValue({ ref, sourceResolution });
            publishHomeAccountChange(context.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await vi.advanceTimersByTimeAsync(0);
            await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                loading: false,
                refreshing: false, snapshot: { fetchedAt: intent === 'cancel' ? 1 : 2 }, error: null,
            }));
        } finally {
            release();
            releaseAgain();
            store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
            vi.useRealTimers();
        }
    });

    it('ignores a pre-marker read begun during the refresh POST after acceptance', async () => {
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: Date.now(), staleAfterMs: 30 * 60_000,
            planLabel: null, accountLabel: null, meters: [] } satisfies QualifiedConnectedAccountQuotaSnapshotV4;
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        let acceptPost!: (response: Response) => void;
        let finishOldRead!: (response: Response) => void;
        try {
            await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key).loading).toBe(false));
            boundary.refresh.mockImplementationOnce(() => new Promise<Response>(resolve => { acceptPost = resolve; }));
            const refresh = store.refreshQualifiedQuotaSnapshot(key, context);
            await vi.waitFor(() => expect(boundary.refresh).toHaveBeenCalledTimes(1));
            getQuotaMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOldRead = resolve; }));
            const oldRead = store.reloadQualifiedQuotaSnapshotAfterRecovery(context);
            await vi.waitFor(() => expect(getQuotaMock).toHaveBeenCalledTimes(2));
            getQuotaMock.mockResolvedValue({ ref, sourceResolution, metadata: { refreshRequestedAt: snapshot.fetchedAt + 1 } });
            acceptPost(Response.json({ success: true }));
            await refresh;
            expect(getQuotaMock).toHaveBeenCalledTimes(3);
            expect(store.getQualifiedQuotaSnapshotEntry(key).refreshing).toBe(true);
            // This response predates the POST marker despite arriving after its acknowledgement.
            finishOldRead(Response.json(quotaTestResponse(snapshot)));
            await oldRead;
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot });
            getQuotaMock.mockResolvedValue({ ref, sourceResolution });
            publishHomeAccountChange(context.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key).refreshing).toBe(false));
        } finally {
            acceptPost?.(Response.json({ success: true }));
            finishOldRead?.(Response.json(quotaTestResponse(snapshot)));
            release();
            store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
        }
    });

    it('settles an unchanged snapshot when a pushed read clears the producer refresh request', async () => {
        vi.useFakeTimers();
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: Date.now(), staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const release = store.loadQualifiedQuotaSnapshotOnce(key, context);
        const unsubscribe = store.subscribeQualifiedQuotaSnapshotEntry(key, () => {});
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(getQuotaMock).toHaveBeenCalledTimes(1);
            // The server accepts a same-timestamp write to clear this request.
            getQuotaMock.mockResolvedValue({ ref, sourceResolution, metadata: { refreshRequestedAt: snapshot.fetchedAt } });
            await store.refreshQualifiedQuotaSnapshot(key, context);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(store.getQualifiedQuotaSnapshotEntry(key).refreshing).toBe(true);
            expect(getQuotaMock).toHaveBeenCalledTimes(2);
            getQuotaMock.mockResolvedValue({ ref, sourceResolution });
            publishHomeAccountChange(context.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await vi.advanceTimersByTimeAsync(0);
            expect(getQuotaMock).toHaveBeenCalledTimes(3);
            await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                loading: false, refreshing: false, snapshot,
            }));
            const reads = getQuotaMock.mock.calls.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(getQuotaMock.mock.calls.length).toBe(reads);
        } finally {
            unsubscribe();
            release();
            store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
            vi.useRealTimers();
        }
    });
    it.each(['snapshot', 'error'] as const)('keeps an accepted native refresh pending until a newer %s arrives', async (outcome) => {
        vi.useFakeTimers();
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await vi.advanceTimersByTimeAsync(0);
            getQuotaMock.mockResolvedValue({ ref, sourceResolution, metadata: { refreshRequestedAt: snapshot.fetchedAt + 1 } });
            await store.refreshQualifiedQuotaSnapshot(key, context);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ refreshing: true, snapshot, error: null });
            snapshotFixture.mockReturnValue({ ...snapshot, fetchedAt: 2 });
            getQuotaMock.mockResolvedValue({ ref, sourceResolution, metadata: { status: outcome === 'error' ? 'error' : 'ok' } });
            publishHomeAccountChange(context.serverBasis.serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await vi.advanceTimersByTimeAsync(0);
            await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                loading: false,
                refreshing: false,
                snapshot: { fetchedAt: 2 },
                error: outcome === 'error' ? t('connectedServices.errors.quotaRefreshFailed') : null,
            }));
        } finally {
            release();
            store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
            vi.useRealTimers();
        }
    });

    it('retains the last native snapshot when an accepted refresh read temporarily has no data', async () => {
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 30 * 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await flushAsyncTurns();
            getQuotaMock.mockResolvedValue(null);
            await store.refreshQualifiedQuotaSnapshot(key, context);
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ snapshot, refreshing: true, error: null });
        } finally {
            release();
        }
    });

    it('stops pending native refresh polling when its last consumer leaves', async () => {
        vi.useFakeTimers();
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        getQuotaMock.mockResolvedValue(null);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await vi.advanceTimersByTimeAsync(0);
            await store.refreshQualifiedQuotaSnapshot(key, context);
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ snapshot: null, refreshing: true, error: null });
            release();
            expect(store.getQualifiedQuotaSnapshotEntry(key).refreshing).toBe(false);
            const reads = getQuotaMock.mock.calls.length;
            await vi.advanceTimersByTimeAsync(120_000);
            expect(getQuotaMock.mock.calls.length).toBe(reads);
        } finally {
            release();
            store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
            vi.useRealTimers();
        }
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        runtime.active = true;
        boundary = await createQualifiedQuotaTestHarness();
        installQuotaReadBoundary();
    });
    afterEach(async () => {
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        vi.useRealTimers();
        await boundary?.dispose();
        vi.restoreAllMocks();
    });

    it('parks retained reads while inactive and refreshes immediately on return, retaining the last snapshot', async () => {
        vi.useFakeTimers();
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        expect(store.getQualifiedQuotaSnapshotEntry(otherKey).snapshot).toBeNull();
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
        } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
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
        snapshotFixture.mockReturnValue(snapshot);
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const serverA = buildContext('server-a', 1);
        const keyA = buildQualifiedQuotaSnapshotScopeKey(serverA);
        const releaseA = retainQualifiedQuotaSnapshotPolling(keyA, serverA);
        await flushAsyncTurns();
        await boundary.dispose();
        boundary = await createQualifiedQuotaTestHarness();
        installQuotaReadBoundary();
        snapshotFixture.mockReturnValue({ ...snapshot, fetchedAt: 2 });
        const serverB = buildContext('server-a', 1);
        const keyB = buildQualifiedQuotaSnapshotScopeKey(serverB);
        const releaseB = retainQualifiedQuotaSnapshotPolling(keyB, serverB);
        await flushAsyncTurns();

        expect(keyB).not.toBe(keyA);
        expect(getQualifiedQuotaSnapshotEntry(keyA).snapshot?.fetchedAt).toBe(1);
        expect(getQualifiedQuotaSnapshotEntry(keyB).snapshot?.fetchedAt).toBe(2);
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
        } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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

    it('settles an accepted refresh on a quota read refusal while retaining the last snapshot', async () => {
        const store = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const context = buildContext('server-a', 1);
        const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        const snapshot = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: 1, staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [] };
        getQuotaMock.mockResolvedValue({ ref, sourceResolution });
        snapshotFixture.mockReturnValue(snapshot);
        const release = store.retainQualifiedQuotaSnapshotPolling(key, context);
        try {
            await flushAsyncTurns();
            getQuotaMock.mockResolvedValue(Response.json({ error: 'not_found' }, { status: 404 }));
            await store.refreshQualifiedQuotaSnapshot(key, context);
            expect(boundary.refresh).toHaveBeenCalledWith(ref);
            expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                snapshot, refreshing: false,
                error: resolveConnectedServiceSettingsErrorMessage({ code: 'not_found' }),
            });
        } finally {
            release();
        }
    });

    it('does not claim quota support when the first read fails', async () => {
        const failure = Object.assign(new Error('unavailable'), {
            code: 'connected_account_v4_operation_unsupported',
        });
        getQuotaMock.mockImplementation(async () => Response.json({ error: failure.code }, { status: 400 }));
        const {
            buildQualifiedQuotaSnapshotScopeKey,
            getQualifiedQuotaSnapshotEntry,
            retainQualifiedQuotaSnapshotPolling,
        } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
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

    it('keeps failed reads idle and recovers immediately through pushes and explicit recovery', async () => {
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
            getQuotaMock.mockImplementation(async () => Response.json({ error: 'unavailable' }, { status: 400 }));
            const {
                buildQualifiedQuotaSnapshotScopeKey,
                retainQualifiedQuotaSnapshotPolling,
                getQualifiedQuotaSnapshotEntry,
                reloadQualifiedQuotaSnapshotAfterRecovery,
            } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
            const context = buildContext('server-a', 1);
            const key = buildQualifiedQuotaSnapshotScopeKey(context);

            const release = retainQualifiedQuotaSnapshotPolling(key, context);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(1);

            await vi.waitFor(() => expect(getQualifiedQuotaSnapshotEntry(key).loading).toBe(false));
            await vi.advanceTimersByTimeAsync(120_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(1);

            getQuotaMock.mockResolvedValue({ ref, sourceResolution });
            const recoveredAt = Date.now();
            snapshotFixture.mockReturnValue({ ...snapshot, fetchedAt: recoveredAt });
            publishHomeAccountChange(getActiveServerSnapshot().serverId,
                [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await flushAsyncTurns();
            await vi.waitFor(() => expect(getQualifiedQuotaSnapshotEntry(key)).toMatchObject({
                snapshot: { fetchedAt: recoveredAt }, loading: false, error: null,
            }));
            expect(getQuotaMock).toHaveBeenCalledTimes(2);

            getQuotaMock.mockImplementation(async () => Response.json({ error: 'unavailable' }, { status: 400 }));
            await reloadQualifiedQuotaSnapshotAfterRecovery(context);
            expect(getQuotaMock).toHaveBeenCalledTimes(3);
            expect(getQualifiedQuotaSnapshotEntry(key).loading).toBe(false);
            expect(getQualifiedQuotaSnapshotEntry(key).error).not.toBeNull();
            await vi.advanceTimersByTimeAsync(120_000);
            await flushAsyncTurns();
            expect(getQuotaMock).toHaveBeenCalledTimes(3);

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
        } = await import('@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore');
        const serverA = buildContext('server-a', 1);
        const keyA = buildQualifiedQuotaSnapshotScopeKey(serverA);

        const releaseA = retainQualifiedQuotaSnapshotPolling(keyA, serverA);
        await flushAsyncTurns();
        releaseA();

        // Unmounting the only reader keeps the cached snapshot: remounting the
        // same account under the same credential scope must not flash empty.
        expect(getQualifiedQuotaSnapshotEntry(keyA).snapshot).toEqual(snapshot);

        await boundary.dispose();
        boundary = await createQualifiedQuotaTestHarness();
        installQuotaReadBoundary();
        const serverB = buildContext('server-a', 1);
        const keyB = buildQualifiedQuotaSnapshotScopeKey(serverB);
        const releaseB = retainQualifiedQuotaSnapshotPolling(keyB, serverB);
        await flushAsyncTurns();

        expect(getQualifiedQuotaSnapshotEntry(keyA).snapshot).toBeNull();
        expect(getQualifiedQuotaSnapshotEntry(keyB).snapshot).toEqual(snapshot);
        releaseB();
    });
});
