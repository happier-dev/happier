import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol/auth/terminalConnectLinkV4';
import { standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests, renderTerminalRoute } from './terminalRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const modalAlertAsyncMock = vi.fn(async () => {});

installTerminalRouteCommonModuleMocks({
    router: async () => createExpoRouterMock({
        router: { back: vi.fn(), replace: replaceMock, push: vi.fn(), setParams: vi.fn() },
        pathname: '/terminal/connect',
    }).module,
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: modalAlertAsyncMock } }).module;
});

vi.mock('@/sync/domains/pending/pendingTerminalConnect', async () => (
    await import('@/sync/domains/pending/pendingTerminalConnect.web')
));

// The web Home-selection owner needs the browser's document and tab storage,
// in addition to the location read by this route.
const browser = await installBrowserRuntimeForTests({ url: 'https://ui.example.test/terminal/connect' });
await initializeTerminalRouteRuntimeForTests();
afterAll(() => browser.restore());

function createV4Link(serverUrl: string, serverIdentityId: string) {
    const descriptor = {
        v: 1 as const,
        homeServerIdentityId: serverIdentityId,
        canonicalServerUrl: serverUrl,
        revision: 1,
        endpoints: serverUrl.startsWith('https://')
            ? [{ kind: 'https' as const, url: serverUrl }]
            : [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const payload = encodeTerminalConnectLinkV4Payload({
        v: 4,
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        pairing: {
            v: 3,
            secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_900_000_060_000,
            homeServerIdentityId: serverIdentityId,
            supportsTokenOnly: false,
        },
        homeConnectionDescriptor: descriptor,
    });
    return { descriptor, href: `https://ui.example.test/terminal/connect#v4=${encodeURIComponent(payload)}` };
}

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    return upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
}

function setWindowLocation(href: string) {
    browser.reconfigureUrl(href);
}

describe('TerminalConnectScreen unauthenticated redirect', () => {
    beforeEach(async () => {
        browser.activate();
        replaceMock.mockClear();
        modalAlertAsyncMock.mockClear();
        browser.window.sessionStorage.clear();
        await activateServer('https://api.happier.dev');
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
    });

    afterEach(async () => {
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
        standardCleanup();
    });

    it('does not crash when bootstrap session storage is unavailable', async () => {
        setWindowLocation('https://ui.example.test/terminal/connect');
        const deniedStorage = vi.spyOn(browser.window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('storage denied'); });
        try {
            const Screen = (await import('@/app/(app)/terminal/connect')).default;
            await expect(renderTerminalRoute(Screen, null)).resolves.toBeDefined();
            const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
            expect(getPendingTerminalConnect()).toBeNull();
        } finally {
            deniedStorage.mockRestore();
        }
    });

    it('uses real compatibility admission to prompt for an update without persistence or approval', async () => {
        const href = 'https://ui.example.test/terminal/connect#key=abc123'
            + '&server=https%3A%2F%2Fcompany.example.test'
            + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1800000000000&expiresAt=1800000060000';
        setWindowLocation(href);
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderTerminalRoute(Screen, null);
        await act(async () => {});

        expect(modalAlertAsyncMock).toHaveBeenCalledWith(
            'connect.updateRequiredTitle',
            'connect.legacyPairingUpdateRequiredBody',
            expect.any(Array),
        );
        expect((await import('@/sync/domains/pending/pendingTerminalConnect')).getPendingTerminalConnect()).toBeNull();
        expect(replaceMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('terminal-connect-approve')).toBeNull();
    });

    it('retains a strict V4 target without redirecting authentication through a different active Home', async () => {
        await activateServer('http://localhost:53288');
        const link = createV4Link('http://127.0.0.1:3005', 'srv_loopback_home');
        setWindowLocation(link.href);
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderTerminalRoute(Screen, null);
        await act(async () => {});

        const { getActiveServerUrl } = await import('@/sync/domains/server/serverProfiles');
        expect(getActiveServerUrl()).toBe('http://localhost:53288');
        const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        expect(replaceMock).not.toHaveBeenCalled();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('welcome.serverUnavailableTitle');
        expect(JSON.stringify(screen.tree.toJSON())).toContain('welcome.serverUnavailableBody');
        await activateServer('http://127.0.0.1:3005');
        await vi.waitFor(() => expect(getPendingTerminalConnect()).toMatchObject({
            serverUrl: 'http://127.0.0.1:3005',
            serverIdentityId: 'srv_loopback_home',
            homeConnectionDescriptor: link.descriptor,
        }));
    });

});
