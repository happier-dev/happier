import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import tweetnacl from 'tweetnacl';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests, renderTerminalRoute } from './terminalRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const backMock = vi.fn();
const replaceMock = vi.fn();
const canGoBackMock = vi.fn(() => false);
const homeUrl = 'https://navigation-home.example.test';
const homeIdentity = 'srv_navigation_home';
const credentials = { token: 'e30.eyJzdWIiOiJuYXZpZ2F0aW9uLWFjY291bnQifQ.signature' };
const approvals: unknown[] = [];

installTerminalRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { back: backMock, replace: replaceMock, canGoBack: canGoBackMock }, pathname: '/terminal/connect' }).module;
    },
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
await initializeTerminalRouteRuntimeForTests();

describe('TerminalConnectScreen safe navigation', () => {
    let restoreCredentials: (() => void) | undefined;
    beforeEach(async () => {
        backMock.mockClear();
        replaceMock.mockClear();
        canGoBackMock.mockClear();
        approvals.length = 0;
        const descriptor = { v: 1 as const, homeServerIdentityId: homeIdentity, canonicalServerUrl: homeUrl, revision: 1, endpoints: [{ kind: 'https' as const, url: homeUrl }] };
        const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const home = await adoptHomeProfile({ descriptor, source: 'manual', descriptorAuthority: 'current_connection_observation' });
        await setActiveServerId(home.id, { scope: 'device' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        // Credential persistence and remote HTTP are the replaced system boundaries.
        const credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        restoreCredentials = () => credentialBoundary.mockRestore();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe(homeUrl);
            const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
            if (url.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/features') return json(createRootLayoutFeaturesResponse({ features: { encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } } } }));
            if (url.pathname === '/v1/auth/request/status') return json({ status: 'pending', supportsV2: true });
            if (url.pathname === '/v1/auth/response') {
                expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + credentials.token);
                approvals.push(JSON.parse(String(init?.body)));
                return json({});
            }
            if (url.pathname === '/v1/auth/ping') return json({});
            throw new Error('Unexpected pairing HTTP request: ' + url.pathname);
        });
        const createdAtMs = Date.now();
        const payload = encodeTerminalConnectLinkV4Payload({
            v: 4,
            publicKeyB64Url: Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64url'),
            pairing: { v: 3, secretB64Url: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'), createdAtMs, expiresAtMs: createdAtMs + 60_000, homeServerIdentityId: homeIdentity, supportsTokenOnly: true },
            homeConnectionDescriptor: descriptor,
        });
        const href = 'https://ui.example.test/terminal/connect#v4=' + encodeURIComponent(payload);
        const url = new URL(href);
        vi.stubGlobal('window', { location: { hash: url.hash, pathname: url.pathname, search: '', href }, history: { replaceState: vi.fn() } });
        const { clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        clearPendingTerminalConnect();
    });
    afterEach(() => {
        standardCleanup();
        restoreCredentials?.();
        vi.unstubAllGlobals();
    });

    it('replaces with / after approving terminal connect', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        const screen = await renderTerminalRoute(Screen, credentials);
        await vi.waitFor(() => expect(screen.findByTestId('terminal-connect-approve')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('terminal-connect-approve'); });
        await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/'));
        expect(approvals).toEqual([expect.objectContaining({ responseKind: 'tokenOnly', authorizeUnattendedTeamAccess: true })]);
        expect(backMock).not.toHaveBeenCalled();
    });

    it('falls back to replace(/) when router cannot go back (reject)', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        const screen = await renderTerminalRoute(Screen, credentials);
        expect(screen.findByTestId('terminal-connect-reject')).not.toBeNull();
        await act(async () => { screen.pressByTestId('terminal-connect-reject'); });
        expect(backMock).not.toHaveBeenCalled();
        expect(replaceMock).toHaveBeenCalledWith('/');
        expect(approvals).toHaveLength(0);
    });
});
