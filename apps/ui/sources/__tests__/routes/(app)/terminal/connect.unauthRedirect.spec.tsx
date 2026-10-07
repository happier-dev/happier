import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
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

await initializeTerminalRouteRuntimeForTests();

function createStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => { values.delete(key); },
        setItem: (key, value) => { values.set(key, value); },
    };
}

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

function setWindowLocation(href: string, sessionStorage: Storage) {
    const url = new URL(href);
    vi.stubGlobal('window', {
        location: {
            hash: url.hash,
            pathname: url.pathname,
            search: url.search,
            href,
        },
        history: { replaceState: vi.fn() },
        sessionStorage,
    });
}

describe('TerminalConnectScreen unauthenticated redirect', () => {
    let sessionStorage: Storage;

    beforeEach(async () => {
        replaceMock.mockClear();
        modalAlertAsyncMock.mockClear();
        const localStorage = createStorage();
        sessionStorage = createStorage();
        vi.stubGlobal('localStorage', localStorage);
        vi.stubGlobal('sessionStorage', sessionStorage);
        await activateServer('https://api.happier.dev');
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
    });

    afterEach(async () => {
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
        standardCleanup();
        vi.unstubAllGlobals();
    });

    it('captures a strict V4 descriptor in the real web owner and selects its Home before auth', async () => {
        const link = createV4Link('https://company.example.test', 'srv_company_home');
        setWindowLocation(link.href, sessionStorage);
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await renderTerminalRoute(Screen, null);
        await act(async () => {});

        const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/?server=https%3A%2F%2Fcompany.example.test'));
        // The route deliberately keeps the auth redirect recoverable when the live connection
        // switch cannot complete. Activate the target as the auth landing would, then read the
        // real target-bound pre-auth record.
        await activateServer('https://company.example.test');
        expect(getPendingTerminalConnect()).toMatchObject({
            serverIdentityId: 'srv_company_home',
            homeConnectionDescriptor: link.descriptor,
        });
    });

    it('does not crash when bootstrap session storage is unavailable', async () => {
        setWindowLocation('https://ui.example.test/terminal/connect', sessionStorage);
        Object.defineProperty((globalThis as typeof globalThis & { window: Window }).window, 'sessionStorage', {
            configurable: true,
            get: () => { throw new Error('storage denied'); },
        });
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await expect(renderTerminalRoute(Screen, null)).resolves.toBeDefined();
        const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('uses real compatibility admission to prompt for an update without persistence or approval', async () => {
        const href = 'https://ui.example.test/terminal/connect#key=abc123'
            + '&server=https%3A%2F%2Fcompany.example.test'
            + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1800000000000&expiresAt=1800000060000';
        setWindowLocation(href, sessionStorage);
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
        setWindowLocation(link.href, sessionStorage);
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
