import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { abortServerFetches } from '@/sync/http/client';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('expo-constants', () => ({
    default: {
        expoConfig: {
            version: '1.2.3',
            ios: { bundleIdentifier: 'dev.happier.app.test' },
        },
    },
}));

const runtimeFetchMock = vi.fn();

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function versionResponse(): Response {
    return new Response(JSON.stringify({ v: 1, status: 'current' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function versionRequestPaths(): string[] {
    return runtimeFetchMock.mock.calls
        .map((call) => new URL(String(call[0])).pathname)
        .filter((path) => path === '/v1/version');
}

async function createSyncWithCredentials() {
    const { sync } = await import('./sync');
    (sync as any).credentials = { token: 'token-a', secret: new Uint8Array([1]) };
    return sync;
}

describe('native update check staleness gate', () => {
    // The gate lives on the `sync` singleton, so each case starts from a distinct day: that leaves
    // the previous case's success stamp unambiguously stale without re-importing the module graph.
    let testDayIndex = 0;

    beforeEach(() => {
        vi.useFakeTimers();
        testDayIndex += 1;
        vi.setSystemTime(new Date(Date.UTC(2026, 0, testDayIndex)));
        runtimeFetchMock.mockReset();
        runtimeFetchMock.mockImplementation(async () => versionResponse());
        setRuntimeFetch(runtimeFetchMock);
        setActiveServerId(upsertServerProfile({ serverUrl: 'https://native-version-retry.example' }).id);
    });

    afterEach(() => {
        abortServerFetches();
        resetRuntimeFetch();
        vi.useRealTimers();
    });

    it('skips the version check while the last successful result is still fresh', async () => {
        const sync = await createSyncWithCredentials();
        const fetchNativeUpdate = (sync as any).fetchNativeUpdate as () => Promise<void>;

        await fetchNativeUpdate();
        // A background→foreground cycle re-invalidates the unit moments later.
        await vi.advanceTimersByTimeAsync(5_000);
        await fetchNativeUpdate();

        expect(versionRequestPaths()).toEqual(['/v1/version']);
    });

    it('allows Retry to cancel the read-only native version POST', async () => {
        const sync = await createSyncWithCredentials();
        const owner = sync as unknown as { fetchNativeUpdate: () => Promise<void> };
        const entered = createDeferred<void>();
        const held = createDeferred<Response>();
        let signal: AbortSignal | null | undefined;
        setRuntimeFetch(async (_input, init) => {
            signal = init?.signal;
            entered.resolve();
            return await held.promise;
        });
        let settled = false;
        const pending = owner.fetchNativeUpdate().finally(() => { settled = true; });
        try {
            await entered.promise;
            abortServerFetches('manual-retry', { readOnly: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(signal?.aborted).toBe(true);
            expect(settled).toBe(true);
        } finally {
            held.resolve(versionResponse());
            await pending;
            resetRuntimeFetch();
        }
    });

    it('checks again once the last successful result is stale', async () => {
        const sync = await createSyncWithCredentials();
        const fetchNativeUpdate = (sync as any).fetchNativeUpdate as () => Promise<void>;

        await fetchNativeUpdate();
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await fetchNativeUpdate();

        expect(versionRequestPaths()).toEqual(['/v1/version', '/v1/version']);
    });

    it('retries on the next invalidation when the check failed', async () => {
        const sync = await createSyncWithCredentials();
        const fetchNativeUpdate = (sync as any).fetchNativeUpdate as () => Promise<void>;

        runtimeFetchMock.mockImplementationOnce(async () => new Response('boom', { status: 503 }));

        await fetchNativeUpdate();
        await fetchNativeUpdate();

        expect(versionRequestPaths()).toEqual(['/v1/version', '/v1/version']);
    });
});
