import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests, renderTerminalRoute } from './terminalRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const modalAlertAsyncMock = vi.fn(async () => {});
let searchParamsValue: Record<string, string | undefined> = {};
const routerMock = createExpoRouterMock({
    router: { back: vi.fn(), replace: replaceMock },
    params: () => searchParamsValue,
});

installTerminalRouteCommonModuleMocks({ router: () => routerMock.module });

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: modalAlertAsyncMock } }).module;
});

await initializeTerminalRouteRuntimeForTests();

function createV4Params(serverUrl: string, serverIdentityId: string) {
    const descriptor = {
        v: 1 as const,
        homeServerIdentityId: serverIdentityId,
        canonicalServerUrl: serverUrl,
        revision: 1,
        endpoints: serverUrl.startsWith('https://')
            ? [{ kind: 'https' as const, url: serverUrl }]
            : [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    return {
        descriptor,
        params: {
            v4: encodeTerminalConnectLinkV4Payload({
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
            }),
        },
    };
}

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    return upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
}

describe('TerminalScreen unauthenticated redirect', () => {
    beforeEach(async () => {
        installTerminalRouteCommonModuleMocks({ router: () => routerMock.module });
        replaceMock.mockClear();
        modalAlertAsyncMock.mockClear();
        searchParamsValue = {};
        await activateServer('https://api.happier.dev');
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
    });

    afterEach(async () => {
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
        standardCleanup();
    });

    it('captures a strict V4 descriptor in the real pending owner before redirecting to auth', async () => {
        const link = createV4Params('https://example.test', 'srv_v4_home');
        searchParamsValue = link.params;
        const Screen = (await import('@/app/(app)/terminal/index')).default;

        await renderTerminalRoute(Screen, null);
        await act(async () => {});

        await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/?server=https%3A%2F%2Fexample.test'));
        await activateServer('https://example.test');
        const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        expect(getPendingTerminalConnect()).toMatchObject({
            serverIdentityId: 'srv_v4_home',
            homeConnectionDescriptor: link.descriptor,
        });
    });

    it('retains a strict V4 target without redirecting authentication through a different active Home', async () => {
        await activateServer('http://localhost:53288');
        const link = createV4Params('http://127.0.0.1:3005', 'srv_loopback_home');
        searchParamsValue = link.params;
        const Screen = (await import('@/app/(app)/terminal/index')).default;

        const screen = await renderTerminalRoute(Screen, null);
        await act(async () => {});

        expect(replaceMock).not.toHaveBeenCalled();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('welcome.serverUnavailableTitle');
        expect(JSON.stringify(screen.tree.toJSON())).toContain('welcome.serverUnavailableBody');
        await activateServer('http://127.0.0.1:3005');
        const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        expect(getPendingTerminalConnect()).toMatchObject({
            serverUrl: 'http://127.0.0.1:3005',
            serverIdentityId: 'srv_loopback_home',
            homeConnectionDescriptor: link.descriptor,
        });
    });

    it('uses the real compatibility admission to prompt for an update without persisting approval', async () => {
        searchParamsValue = {
            key: 'abc123',
            server: 'https://example.test',
            pairingSecret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            createdAt: '1800000000000',
            expiresAt: '1800000060000',
        };
        const Screen = (await import('@/app/(app)/terminal/index')).default;

        const screen = await renderTerminalRoute(Screen, null);
        await act(async () => {});

        expect(modalAlertAsyncMock).toHaveBeenCalledWith(
            'connect.updateRequiredTitle',
            'connect.legacyPairingUpdateRequiredBody',
            expect.any(Array),
        );
        await activateServer('https://example.test');
        const { getPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        expect(getPendingTerminalConnect()).toBeNull();
        expect(replaceMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('terminal-connect-approve')).toBeNull();
    });
});
