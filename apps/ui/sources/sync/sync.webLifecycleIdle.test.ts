import { expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { InvalidateSync } from '@/utils/sessions/sync';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
let homeSocket: Socket | undefined;
installDisconnectedServerSocketBoundary((socket, url) => {
    configureConnectedServerSocketBoundary(socket);
    if (url?.startsWith('https://web-idle.example.test')) homeSocket = socket;
});

const document = Object.assign(new EventTarget(), { visibilityState: 'visible', wasDiscarded: false,
    documentElement: { style: {} }, getElementById: () => null });
const browser = new EventTarget();
function installBrowserEvents() {
    vi.stubGlobal('document', document);
    vi.stubGlobal('addEventListener', browser.addEventListener.bind(browser));
    vi.stubGlobal('removeEventListener', browser.removeEventListener.bind(browser));
}
// Capture the real constructor's clock boundary during collection. The shared
// beforeEach restores Vitest clocks; this manual interval port survives that
// reset and lets module loading finish before the test's operation begins.
const intervals = new Map<unknown, { fire(): void; delay: number }>();
vi.stubGlobal('setInterval', (...[callback, delay, ...args]: Parameters<typeof globalThis.setInterval>) => {
    const handle = { fire: () => callback(...args), delay: delay ?? 0 };
    intervals.set(handle, handle);
    return handle;
});
vi.stubGlobal('clearInterval', (handle: unknown) => { intervals.delete(handle); });
const timers = installTimerCensus(stack => stack.includes('syncEngine') ? 'syncEngine' : null);
installBrowserEvents();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { sync } = await import('./syncEngine');

it('keeps settled browser tabs idle and reconciles a missed profile change after a socket gap', async () => {
    const locks = installWebLockManagerMock();
    const local = installLocalStorageMock();
    vi.stubGlobal('sessionStorage', localStorage);
    installBrowserEvents();
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    const requests: string[] = [];
    let profileName = 'Before gap';
    let changesCursor = 0;
    const { storage } = await import('./domains/state/storage');
    const owner = sync as unknown as {
        bootstrapSync(): Promise<void>;
        resumeInFlight: Promise<void> | null;
        ownedSyncUnits(): InvalidateSync[];
    };
    const bootstrap = vi.spyOn(owner, 'bootstrapSync');
    const settle = async () => {
        // Wait for the owner and its queued follow-up, if any. The event loop
        // also delivers the external transport's immediate connection event.
        await new Promise<void>(resolve => setImmediate(resolve));
        while (owner.resumeInFlight) await owner.resumeInFlight;
        await Promise.all(owner.ownedSyncUnits().map(unit => unit.awaitQueue()));
    };
    const setVisible = (visible: boolean) => {
        document.visibilityState = visible ? 'visible' : 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
        await loadSyncSingletonForTests();
        account = await restoreServerAccountForTest({ serverUrl: 'https://web-idle.example.test', accountId: 'web-idle',
            requestOwnsReachabilityProbes: true,
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                requests.push(path);
                if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'web-idle', firstName: profileName });
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/changes') {
                    const after = Number(new URL(String(input)).searchParams.get('after'));
                    return Response.json({
                        changes: after < changesCursor
                            ? [{ cursor: changesCursor, kind: 'account', entityId: 'self', changedAt: 2, hint: { profileVersion: changesCursor } }]
                            : [],
                        nextCursor: changesCursor,
                    });
                }
                return createEmptyAccountBootstrapHttpResponse(path, init);
            } });
        await bootstrap.mock.results[0]?.value;
        await vi.waitFor(() => expect(homeSocket?.connected).toBe(true));
        await settle();
        expect(storage.getState().profile.firstName).toBe('Before gap');
        local.setItemMock.mockClear();
        const before = timers.readFires().interval;
        for (const timer of [...intervals.values()]) {
            for (let elapsed = timer.delay; timer.delay > 0 && elapsed <= 60_000; elapsed += timer.delay) timer.fire();
        }
        expect({ fires: timers.readFires().interval - before,
            writes: local.setItemMock.mock.calls.filter(([key]) => key === 'happier-sync-live-instances-v1').length,
        }).toEqual({ fires: 0, writes: 0 });
        expect(timers.read().filter(timer => timer.kind === 'interval' && timer.consumer === 'syncEngine')).toEqual([]);
        expect(intervals.size).toBe(0);
        requests.length = 0;
        const liveSocket = homeSocket;
        if (!liveSocket?.connected) throw new Error('The existing Account socket must be connected');
        let publications = 0;
        const unsubscribe = storage.subscribe(() => { publications++; });
        setVisible(false);
        setVisible(true);
        browser.dispatchEvent(new Event('pageshow'));
        browser.dispatchEvent(new Event('resume'));
        browser.dispatchEvent(new Event('focus'));
        try {
            await settle();
        } finally {
            unsubscribe();
        }
        expect(requests, 'HTTP after settled tab return').toEqual([]);
        expect(publications).toBe(0);
        expect(homeSocket).toBe(liveSocket);
        expect(homeSocket?.connected).toBe(true);

        setVisible(false);
        liveSocket.disconnect();
        expect(liveSocket.connected).toBe(false);
        profileName = 'After gap';
        changesCursor = 1;
        requests.length = 0;
        setVisible(true);
        await vi.waitFor(() => expect(storage.getState().profile.firstName).toBe('After gap'));
        await settle();
        const gapChangesReads = requests.filter(path => path === '/v2/changes').length;
        console.info('TAB_RETURN_HTTP', { settled: 0, publications, gapChangesReads, gapRequests: requests });
        expect(gapChangesReads).toBe(1);
        expect(requests.filter(path => path === '/v1/account/profile')).toHaveLength(1);
        expect(requests).not.toContain('/v2/session-organization');
    } finally {
        bootstrap.mockRestore();
        await account?.dispose();
        timers.stop();
        intervals.clear();
        locks.restore();
        local.restore();
        vi.unstubAllGlobals();
    }
});

it('releases a retired cold Account bootstrap while the web tab stays hidden', async () => {
    const local = installLocalStorageMock();
    vi.stubGlobal('sessionStorage', localStorage);
    installBrowserEvents();
    const { storage } = await import('./domains/state/storage');
    const { isAppliedActiveServerRuntimeAvailable } = await import('./runtime/orchestration/appliedActiveServerRuntime');
    const owner = sync as unknown as { bootstrapSync(): Promise<void> };
    const bootstrap = vi.spyOn(owner, 'bootstrapSync');
    const requests: string[] = [];
    const restore = (accountId: string) => restoreServerAccountForTest({
        serverUrl: 'https://web-bootstrap.example.test',
        accountId,
        credentials: {
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.sig`,
            secret: Buffer.alloc(32, 7).toString('base64url'),
            custody: 'historical',
        },
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            requests.push(path);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/cursor') return Response.json({ cursor: 17, changesFloor: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    const corePaths = ['/v2/cursor', '/v2/account/settings', '/v1/account/profile'];
    const setVisible = (visible: boolean) => {
        document.visibilityState = visible ? 'visible' : 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
    };
    let account: Awaited<ReturnType<typeof restore>> | undefined;
    try {
        setVisible(false);
        account = await restore('retired-bootstrap');
        expect(isAppliedActiveServerRuntimeAvailable()).toBe(true);
        expect(storage.getState().profileScope?.accountId).toBe('retired-bootstrap');
        expect(requests).toContain('/v1/account/encryption/currentness');
        expect(storage.getState().isDataReady).toBe(false);
        expect(requests.filter(path => corePaths.includes(path))).toEqual([]);

        const pausedBootstrap = bootstrap.mock.results[0].value;
        let settled = false;
        void pausedBootstrap.then(() => { settled = true; });
        await account.dispose();
        account = undefined;
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(requests.filter(path => corePaths.includes(path))).toEqual([]);

        account = await restore('foreground-bootstrap');
        expect(storage.getState().isDataReady).toBe(false);
        setVisible(true);
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        expect(requests.filter(path => corePaths.includes(path)).slice(0, 1)).toEqual(['/v2/cursor']);
        expect(requests).toEqual(expect.arrayContaining(corePaths));
        expect(storage.getState().profile.id).toBe('foreground-bootstrap');
    } finally {
        await account?.dispose();
        setVisible(true);
        bootstrap.mockRestore();
        local.restore();
        vi.unstubAllGlobals();
    }
});
