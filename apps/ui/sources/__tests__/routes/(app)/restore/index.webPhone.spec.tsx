import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    installRestoreRouteCommonModuleMocks,
} from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const restoreRouteIngressState = vi.hoisted(() => ({
    params: {} as Readonly<Record<string, string | string[]>>,
    scannerProps: null as Record<string, unknown> | null,
    replaceSpy: vi.fn(),
}));

installRestoreRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: {
                    web?: unknown;
                    default?: unknown;
                    ios?: unknown;
                    android?: unknown;
                }) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            Dimensions: {
                get: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: vi.fn(),
                push: vi.fn(),
                replace: restoreRouteIngressState.replaceSpy,
                canGoBack: () => false,
            },
            params: () => restoreRouteIngressState.params,
        }).module;
    },
});

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => true,
    canUseCurrentDeviceQrScanner: () => true,
}));

vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: () => React.createElement('div', { 'data-testid': 'RestoreQrView' }),
}));

vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
    RestoreScanComputerQrView: (props: Record<string, unknown>) => {
        restoreRouteIngressState.scannerProps = props;
        return React.createElement('div', { 'data-testid': 'RestoreScanComputerQrView' });
    },
}));

// Everything below that reaches react-native must load after the options above are installed.
const { installTokenStorageWebPlatformMocks } = await import('@/auth/storage/tokenStorage.testHelpers');
installTokenStorageWebPlatformMocks();
const { flushHookEffects, renderScreen } = await import('@/dev/testkit');
const { encodeBase64 } = await import('@/encryption/base64');
const { buildHomeQrInviteDeepLink, buildHomeQrInviteRestoreRoutePath } = await import('@/auth/pairing/pairingUrl');
const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
const { initializeAuthRouteRuntimeForTests } = await import('@/dev/testkit/harness/authRouteRuntimeHarness');
const { createDirectoryHttpFixture } = await import('@/sync/ops/accountDirectory/accountDirectoryTestFixtures');
const { adoptHomeProfile, resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
await initializeAuthRouteRuntimeForTests();
const { default: Screen } = await import('@/app/(app)/restore/index');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

/** Settings reaches Add Home signed in, where the route keeps its focused wizard card. */
async function renderSignedIn() {
    return await renderScreen(
        <InjectedAuthProvider credentials={{ token: 'signed-in-token', secret: 'secret' }}>
            <Screen />
        </InjectedAuthProvider>,
    );
}

let localStorage: ReturnType<typeof installLocalStorageMock> | undefined;
afterEach(() => {
    resetServerProfilesRuntimeForTests();
    localStorage?.restore();
    localStorage = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreRouteIngressState.params = {};
    restoreRouteIngressState.scannerProps = null;
    restoreRouteIngressState.replaceSpy.mockClear();
});

describe('/restore (web phone)', () => {
    it('selects the scan-desktop restore flow on phone-sized web even with one saved Home to display a QR for', async () => {
        localStorage = installLocalStorageMock();
        resetServerProfilesRuntimeForTests();
        // One established saved Home makes the QR-first branch reachable, so only the phone heuristic can pick the scanner.
        vi.stubGlobal('navigator', {
            ...globalThis.navigator,
            locks: globalThis.navigator.locks,
            maxTouchPoints: 5,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
        } as any);
        // The viewport is a platform fact: report the phone window through the Dimensions authority useWindowDimensions reads.
        const { Dimensions } = await import('react-native');
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 360, height: 800, scale: 2, fontScale: 1 });
        await adoptHomeProfile({
            descriptor: createDirectoryHttpFixture().home.connectionDescriptor,
            source: 'account-directory', descriptorAuthority: 'current_connection_observation',
        });

        const screen = await renderScreen(<Screen />);
        await flushHookEffects();
        expect(screen.findAllByProps({ 'data-testid': 'RestoreScanComputerQrView' })).toHaveLength(1);
        expect(screen.findAllByProps({ 'data-testid': 'RestoreQrView' })).toHaveLength(0);
        expect(restoreRouteIngressState.scannerProps?.entryIntent).toBe('enter_home');
    });

    it('consumes a routed V2 handoff once and passes the link to the embedded restore owner', async () => {
        const pairingLink = buildHomeQrInviteDeepLink({
            invite: {
                v: 2,
                intent: 'home_device',
                direction: 'trusted_home_displays',
                pairId: 'pair-route-handoff',
                home: {
                    v: 1,
                    homeServerIdentityId: 'srv_route_handoff',
                    canonicalServerUrl: 'https://route-handoff.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://route-handoff.test' }],
                },
                qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(6), 'base64url'),
                issuedAtMs: Date.now(),
                expiresAtMs: Date.now() + 60_000,
            },
        });
        const restorePath = buildHomeQrInviteRestoreRoutePath(pairingLink, 'add_home');
        expect(restorePath).not.toContain(pairingLink);
        const routeUrl = new URL(restorePath!, 'https://app.example.test');
        restoreRouteIngressState.params = Object.fromEntries(routeUrl.searchParams.entries());

        await renderScreen(<Screen />);

        expect(restoreRouteIngressState.scannerProps?.initialPairingLink).toBe(
            pairingLink,
        );
        expect(restoreRouteIngressState.scannerProps?.entryIntent).toBe('add_home');
    });

    it('frames a routed reverse-direction invite as approving the new device, not adding a Home', async () => {
        const pairingLink = buildHomeQrInviteDeepLink({
            invite: {
                v: 2,
                intent: 'home_device',
                direction: 'requester_displays',
                pairId: 'pair-route-reverse',
                requesterPublicKeyBase64Url: encodeBase64(new Uint8Array(32).fill(8), 'base64url'),
                home: {
                    v: 1,
                    homeServerIdentityId: 'srv_route_reverse',
                    canonicalServerUrl: 'https://route-reverse.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://route-reverse.test' }],
                },
                qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(6), 'base64url'),
                issuedAtMs: Date.now(),
                expiresAtMs: Date.now() + 60_000,
            },
        });
        const restorePath = buildHomeQrInviteRestoreRoutePath(pairingLink, 'add_home');
        const routeUrl = new URL(restorePath!, 'https://app.example.test');
        restoreRouteIngressState.params = Object.fromEntries(routeUrl.searchParams.entries());

        const screen = await renderScreen(<Screen />);

        expect(restoreRouteIngressState.scannerProps?.initialPairingLink).toBe(pairingLink);
        const chrome = screen.getTextContent();
        expect(chrome).toContain('connect.approveNewDeviceTitle');
        expect(chrome).toContain('connect.approveNewDeviceSubtitle');
        expect(chrome).not.toContain('connect.linkNewDeviceSubtitle');
        expect(chrome).not.toContain('setupOnboarding.addHomeTitle');
        expect(chrome).not.toContain('setupOnboarding.addHomeSubtitle');
        // Approving a device is not a step of the three-step Home setup.
        expect(screen.findByTestId('restore-wizard-progress')).toBeNull();
    });

    it('follows the invite direction the embedded scanner reports for an in-place scan', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);
        restoreRouteIngressState.params = { entryIntent: 'add_home' };

        const screen = await renderSignedIn();
        expect(screen.getTextContent()).toContain('setupOnboarding.addHomeTitle');
        expect(screen.findByTestId('restore-wizard-progress')).not.toBeNull();
        const reportDirection = restoreRouteIngressState.scannerProps?.onInviteDirectionChange;
        expect(reportDirection).toBeInstanceOf(Function);

        await act(async () => {
            (reportDirection as (direction: string | null) => void)('requester_displays');
        });
        expect(screen.getTextContent()).toContain('connect.approveNewDeviceTitle');
        expect(screen.getTextContent()).not.toContain('setupOnboarding.addHomeTitle');
        expect(screen.findByTestId('restore-wizard-progress')).toBeNull();

        await act(async () => {
            (reportDirection as (direction: string | null) => void)(null);
        });
        expect(screen.getTextContent()).toContain('setupOnboarding.addHomeTitle');
        expect(screen.getTextContent()).not.toContain('connect.approveNewDeviceTitle');
    });

    it.each(['missing', 'malformed'] as const)(
        'refuses to consume a registered routed V2 link whose entry intent is %s',
        async (intentCase) => {
            const pairingLink = buildHomeQrInviteDeepLink({
                invite: {
                    v: 2,
                    intent: 'home_device',
                    direction: 'trusted_home_displays',
                    pairId: `pair-route-${intentCase}`,
                    home: {
                        v: 1,
                        homeServerIdentityId: 'srv_route_intent',
                        canonicalServerUrl: 'https://route-intent.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://route-intent.test' }],
                    },
                    qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(6), 'base64url'),
                    issuedAtMs: Date.now(),
                    expiresAtMs: Date.now() + 60_000,
                },
            });
            const routeUrl = new URL(buildHomeQrInviteRestoreRoutePath(pairingLink, 'add_home')!, 'https://app.example.test');
            // The handoff is registered for real; only the closed entry intent is missing or garbled.
            const params = Object.fromEntries(routeUrl.searchParams.entries());
            if (intentCase === 'missing') delete params.entryIntent;
            else params.entryIntent = 'focus_home';
            restoreRouteIngressState.params = params;

            const screen = await renderScreen(<Screen />);

            expect(restoreRouteIngressState.scannerProps?.initialPairingLink).toBeNull();
            expect(restoreRouteIngressState.scannerProps?.entryIntent).toBe('enter_home');
            expect(screen.findAllByProps({ 'data-testid': 'RestoreQrView' })).toHaveLength(0);
            // Signing in, the camera step titles itself; nothing reads as adding a Home.
            expect(screen.getTextContent()).toContain('connect.pointAtComputerTitle');
            expect(screen.getTextContent()).not.toContain('setupOnboarding.addHomeTitle');
        },
    );

    it('passes the closed add-home intent to the scanner and presents truthful navigation', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);
        restoreRouteIngressState.params = { entryIntent: 'add_home' };

        const screen = await renderSignedIn();

        expect(restoreRouteIngressState.scannerProps?.entryIntent).toBe('add_home');
        expect(screen.getTextContent()).toContain('setupOnboarding.addHomeTitle');
        expect(screen.getTextContent()).toContain('setupOnboarding.addHomeSubtitle');

        screen.pressByTestId('restore-wizard-back');
        expect(restoreRouteIngressState.replaceSpy).toHaveBeenCalledWith('/settings/account');
    });

    it('disables the wizard Back action while the joining enrollment is past its commit boundary', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);

        const screen = await renderScreen(<Screen />);
        await act(async () => {
            const setNavigationLocked = restoreRouteIngressState.scannerProps?.onNavigationLockChange;
            expect(setNavigationLocked).toBeInstanceOf(Function);
            (setNavigationLocked as (locked: boolean) => void)(true);
        });

        // Signed out, the step sits in the welcome split; a locked enrollment offers no way back.
        expect(screen.findByTestId('unauth-shell-workflow-pane')).not.toBeNull();
        expect(screen.findByTestId('unauth-shell-back-chevron')).toBeNull();
    });
});
