/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { createDeferred, renderScreen } from '@/dev/testkit';

installTokenStorageWebPlatformMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/user/launch-profile', segments: ['(app)', 'user', '[id]'], params: { id: 'launch-profile' },
}).module);
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown is outside the profile launch journey'); },
}));

vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: media === '(prefers-reduced-motion: reduce)',
    addEventListener: () => {},
    removeEventListener: () => {},
}));
afterAll(() => vi.unstubAllGlobals());

await initializeRealAppRuntimeForTests();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { AppShellPluginUiProjectionProvider } = await import('../plugins/AppShellPluginUiProjection');
const { WorkspaceAppShellProvider } = await import('./WorkspaceAppShellProvider');
const { useOptionalWorkspaceNavigation } = await import('./WorkspaceNavigationContext');
const { LaunchCurtain } = await import('./AppLaunchState');
const { default: ProfileRoute } = await import('@/app/(app)/user/[id]');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { sync } = await import('@/sync/sync');

it('releases the desktop curtain through an Expo profile without mounting retained Home', async () => {
    const previousHref = window.location.href;
    window.history.replaceState(null, '', '/user/launch-profile');
    const accountId = 'desktop-profile-launch';
    const restored = await restoreServerAccountForTest({
        serverUrl: 'https://desktop-profile-launch.example.test', accountId,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v1/user/launch-profile') return Response.json({ user: {
                id: 'launch-profile', firstName: 'Launch profile', lastName: null, username: 'launch-profile',
                avatar: null, bio: null, status: 'none', publicKey: null,
            } });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    const fade = createDeferred<void>();
    const launch = startTestLaunchCurtain();
    function FocusedProfile() {
        const workspace = useOptionalWorkspaceNavigation();
        return <>
            {React.createElement('ProfileWorkspace', {
                accountId: workspace?.desktopPresentation?.accountId,
                phone: workspace?.phone != null,
            })}
            <ProfileRoute />
        </>;
    }
    const screen = await renderScreen(<AuthProvider initialCredentials={restored.credentials}>
        <AppShellPluginUiProjectionProvider>
            <WorkspaceAppShellProvider><FocusedProfile /></WorkspaceAppShellProvider>
        </AppShellPluginUiProjectionProvider>
        <CurtainProbe />
        <LaunchCurtain />
    </AuthProvider>, { createNodeMock: element => (element.props as { testID?: string }).testID === 'launch-curtain'
        ? { animate: () => ({ finished: fade.promise, cancel: () => {} }) } : null });
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    try {
        await act(async () => { await sync.awaitBootstrapForegroundAcquisition(); });
        await vi.waitFor(() => {
            expect(screen.root.findByType('ProfileWorkspace').props).toMatchObject({ accountId, phone: false });
            expect(screen.findByTestId('user-profile.header')).not.toBeNull();
            expect(screen.getTextContent()).toContain('@launch-profile');
            expect(screen.findByTestId('user-profile.loading')).toBeNull();
        });
        expect(screen.findByTestId('home-hub.loading')).toBeNull();
        expect(curtain()).toBe('up');
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('leaving');
        expect(screen.findHostByTestId('launch-curtain')?.props.pointerEvents).toBe('none');
        await act(async () => { fade.resolve(); });
        expect(curtain()).toBe('gone');
        expect(screen.findHostByTestId('launch-curtain')).toBeNull();
    } finally {
        fade.resolve();
        await screen.unmount();
        launch.dispose();
        window.history.replaceState(null, '', previousHref);
        await restored.dispose();
    }
});
