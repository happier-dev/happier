import { expect, it, vi } from 'vitest';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

const document = Object.assign(new EventTarget(), { visibilityState: 'visible', wasDiscarded: false,
    getElementById: () => null });
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

it('keeps web lifecycle and tab presence idle without timer fires or presence writes, and resumes on browser events', async () => {
    const locks = installWebLockManagerMock();
    const local = installLocalStorageMock();
    vi.stubGlobal('sessionStorage', localStorage);
    installBrowserEvents();
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    const requests: string[] = [];
    try {
        await loadSyncSingletonForTests();
        account = await restoreServerAccountForTest({ serverUrl: 'https://web-idle.example.test', accountId: 'web-idle',
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                requests.push(path);
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'web-idle' });
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: '0', hasMore: false });
                return createEmptyAccountBootstrapHttpResponse(path, init);
            } });
        await sync.awaitBootstrapForegroundAcquisition();
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
        for (const event of ['pageshow', 'resume']) {
            const beforeWake = requests.length;
            browser.dispatchEvent(new Event(event));
            await vi.waitFor(() => expect(requests.length).toBeGreaterThan(beforeWake));
        }
        document.visibilityState = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        document.visibilityState = 'visible';
        const beforeVisible = requests.length;
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(requests.length).toBeGreaterThan(beforeVisible));
    } finally {
        await account?.dispose();
        timers.stop();
        intervals.clear();
        locks.restore();
        local.restore();
        vi.unstubAllGlobals();
    }
});
