import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

// Execute one coherent installed SDK source graph so native platform files keep
// the same context identities as their navigators and public exports.
vi.mock('@react-navigation/native', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native/src/index.tsx'));
vi.mock('@react-navigation/native-stack', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native-stack/src/index.tsx'));
vi.mock('@react-navigation/elements', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/elements/src/index.tsx'));
// Node has no Metro platform resolver. These are the installed native choices.
vi.mock('../../../../node_modules/@react-navigation/native/src/useDocumentTitle', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native/src/useDocumentTitle.native.tsx'));
vi.mock('../../../../node_modules/@react-navigation/native/src/useLinking', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native/src/useLinking.native.tsx'));
vi.mock('../../../../node_modules/@react-navigation/native/src/useBackButton', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native/src/useBackButton.native.tsx'));
// Both installed iOS and Android MaskedView variants delegate to this native view adapter.
vi.mock('../../../../node_modules/@react-navigation/elements/src/MaskedView', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/elements/src/MaskedViewNative.tsx'));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

vi.mock('react-native-screens', async () => {
    const { createNativeScreensMock } = await import('@/dev/testkit/mocks/nativeScreens');
    return createNativeScreensMock();
});
// Node has no Metro platform resolver. Run the installed native scene implementation,
// including its retained routes, rather than native-stack's web scene implementation.
vi.mock('../../../../node_modules/@react-navigation/native-stack/src/views/NativeStackView', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native-stack/src/views/NativeStackView.native.tsx'));
vi.mock('../../../../node_modules/@react-navigation/native-stack/src/views/FontProcessor', async () =>
    vi.importActual('../../../../node_modules/@react-navigation/native-stack/src/views/FontProcessor.native.tsx'));


await initializeArtifactInventoryDemandHarness();

describe('Sync native route Artifact inventory demand', () => {
    let fixture: Awaited<ReturnType<typeof createArtifactInventoryDemandHarness>>;
    beforeEach(async () => { fixture = await createArtifactInventoryDemandHarness(); });
    afterEach(async () => { await fixture?.dispose(); vi.restoreAllMocks(); });

    it('withdraws a retained native browser full read and recovery demand beneath a pushed detail, then refreshes once on return', async () => {
        const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
        const { createNativeStackNavigator } = await import('@react-navigation/native-stack');
        const { WorkspaceRouteEntry } = await import('@/components/appShell/workspace/createWorkspaceRouteEntry');
        const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { useArtifactInventoryRead } = await import('@/components/artifacts/useArtifactInventoryRead');
        const { storage } = await import('./domains/state/storage');
        const Stack = createNativeStackNavigator<{ browser: undefined; detail: undefined }>();
        const navigation = createNavigationContainerRef<{ browser: undefined; detail: undefined }>();
        const requestStarted = createDeferred<AbortSignal | null | undefined>(), release = createDeferred<void>();
        let browserMounts = 0, browserUnmounts = 0;
        const workspace: WorkspaceNavigationContextValue = {
            active: false, ownsRoute: false,
            state: createWorkspaceState({ id: 'browser', target: { kind: 'artifacts', params: {} }, pinned: false, preview: true }),
            canGoBack: false, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        };
        function BrowserBody() {
            const loaded = storage(state => state.artifactsLoaded);
            useArtifactInventoryRead(!loaded, undefined, { includeProvenance: true });
            React.useEffect(() => { browserMounts += 1; return () => { browserUnmounts += 1; }; }, []);
            return React.createElement('ArtifactBrowser', { testID: 'native-artifact-browser' });
        }
        function BrowserRoute() { return <WorkspaceRouteEntry Body={BrowserBody} />; }
        function DetailRoute() { return React.createElement('ArtifactDetail'); }
        fixture.holdList = signal => { requestStarted.resolve(signal); return release.promise; };
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            // Resolve the SDK scene before mounting; a platform import failure must
            // reject this test directly rather than strand a suspended browser.
            await vi.importActual('../../../../node_modules/@react-navigation/native-stack/src/views/NativeStackView.native.tsx');
            screen = await renderScreen(<WorkspaceNavigationProvider value={workspace}>
                <NavigationContainer ref={navigation}>
                    <Stack.Navigator screenOptions={{ headerShown: false }}>
                        <Stack.Screen name="browser" component={BrowserRoute} />
                        <Stack.Screen name="detail" component={DetailRoute} />
                    </Stack.Navigator>
                </NavigationContainer>
            </WorkspaceNavigationProvider>);
            try {
                // Flush native scene admission before waiting on its deliberately held HTTP read.
                expect(screen.findByTestId('native-artifact-browser')).not.toBeNull();
                expect(storage.getState().settingsScope).not.toBeNull();
                await vi.waitFor(async () => {
                    await act(async () => {});
                    expect(fixture.pages).toEqual([{ kinds: null, headers: 500 }]);
                });
                const requestSignal = await requestStarted.promise;
                await act(async () => { navigation.navigate('detail'); });
                expect(navigation.getRootState().routes).toHaveLength(2);
                expect(screen.findAllByType('ScreenStackItem').map(scene => scene.props['aria-hidden'])).toEqual([true, false]);
                expect(screen.findByTestId('native-artifact-browser')).not.toBeNull();
                expect(browserMounts).toBe(1);
                expect(browserUnmounts).toBe(0);
                expect(requestSignal?.aborted).toBe(true);
            } finally { fixture.holdList = null; release.resolve(); }
            await fixture.settleInventory();
            expect(storage.getState().artifactsLoaded).toBe(false);
            expect(fixture.pages).toEqual([{ kinds: null, headers: 500 }]);
            fixture.pages.length = 0;
            await fixture.recoverSnapshot();
            expect(fixture.pages).toEqual([]);
            await act(async () => { navigation.goBack(); });
            await vi.waitFor(() => expect(storage.getState().artifactsLoaded).toBe(true));
            expect(fixture.pages).toHaveLength(8);
            expect(fixture.pages.reduce((count, page) => count + page.headers, 0)).toBe(fixture.inventory.length);
            expect(browserMounts).toBe(1);
            expect(browserUnmounts).toBe(0);
        } finally {
            fixture.holdList = null;
            release.resolve();
            await screen?.unmount();
        }
    }, 120_000);
});
