import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Native geometry, modal presentation and the platform router are system boundaries.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { router } = await import('expo-router');
const { Modal, ModalProvider } = await import('@/modal');
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createSessionBoardDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { SessionCockpitPanePresentationBoundary, SessionCockpitSceneNavigationBoundary } = await import('./SessionCockpitTabNavigator');
const { usePanePresentation } = await import('@/components/appShell/panes/panePresentation');
const { useSessionCockpitSurfaceNavigation } = await import('./SessionCockpitSurfaceNavigation');

afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); });

it('retains phone Start before Session registration without leaving Chat, while ordinary Details navigates', async () => {
    let pane!: ReturnType<typeof useAppPaneScope>;
    let registerSession!: () => void;
    const navigate = vi.fn();
    const commitSurface = vi.fn();
    function Scope() {
        pane = useAppPaneScope('phone-start');
        const [ready, setReady] = React.useState(false);
        registerSession = () => setReady(true);
        const register = useAppPaneContext(value => value.registerDriver);
        React.useEffect(() => ready ? register({ scopeId: 'phone-start', detailsPaneBuiltinAdapter: {
            destinationIds: ['details'], render: () => <>{'Visible Start body'}</>,
        } }) : undefined, [ready, register]);
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider>
        <SessionCockpitPanePresentationBoundary cockpit scopeId="phone-start" sessionId="s1" serverId="home"
            catalog={[]} navigate={navigate} commitSurface={commitSurface}><Scope /></SessionCockpitPanePresentationBoundary>
        <ModalProvider>{null}</ModalProvider>
    </AppPaneProvider>);
    try {
        const start = createSessionBoardDetailsTab();
        await act(async () => pane.openDetailsTab(start, { start: true, intent: 'pinned' }));
        expect(pane.scopeState?.details.activeTabKey).toBe(start.key);
        expect(screen.getTextContent()).not.toContain('Visible Start body');
        await act(async () => registerSession());
        expect(screen.getTextContent()).toContain('Visible Start body');
        expect(router.replace).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(commitSurface).not.toHaveBeenCalled();
        await act(async () => pane.closeDetails());
        expect(screen.getTextContent()).not.toContain('Visible Start body');
        await act(async () => pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
        expect(navigate).toHaveBeenCalledExactlyOnceWith('tabs');
        expect(commitSurface).toHaveBeenCalledExactlyOnceWith('tabs');
        expect(router.replace).toHaveBeenCalledOnce();
    } finally {
        await screen.unmount();
    }
});

it('keeps a scene\'s pane presentation and surface switch when a tab press re-renders it with fresh navigator helpers', async () => {
    // A cockpit tab press re-renders every mounted scene with new navigator helpers, a rebuilt catalog and commit
    // callback. Every pane-scope reader (transcript rows included) holds the presentation; every scene reader holds
    // the switch. HEAD before: both changed identity on each press and rendered those readers (live Android,
    // ~2.1k renders per press back to Chat under the scene's pane boundary).
    let readerRenders = 0;
    const seen: { presentation: unknown; navigation: unknown }[] = [];
    const Reader = React.memo(function Reader() {
        readerRenders += 1;
        seen.push({ presentation: usePanePresentation(), navigation: useSessionCockpitSurfaceNavigation() });
        return null;
    });
    const reader = <Reader />;
    const scene = (navigate: (surface: string) => void, commitSurface: (surface: string) => void) => <AppPaneProvider>
        <SessionCockpitSceneNavigationBoundary cockpit navigation={{ navigate, canGoBack: () => false, goBack: () => {} }} commitSurface={commitSurface}>
            <SessionCockpitPanePresentationBoundary cockpit scopeId="phone-press" sessionId="s1" serverId="home"
                catalog={[]} navigate={navigate} commitSurface={commitSurface}>{reader}</SessionCockpitPanePresentationBoundary>
        </SessionCockpitSceneNavigationBoundary>
    </AppPaneProvider>;
    const screen = await renderScreen(scene(vi.fn(), vi.fn()));
    try {
        expect(readerRenders).toBe(1);
        const latestNavigate = vi.fn();
        const latestCommit = vi.fn();
        await screen.update(scene(vi.fn(), vi.fn()));
        await screen.update(scene(latestNavigate, latestCommit));
        expect(readerRenders).toBe(1);
        // The held switch and presentation act through the scene's latest helpers.
        const { presentation, navigation } = seen[0]!;
        await act(async () => (navigation as { switchSurface: (surface: string) => void }).switchSurface('git'));
        expect(latestNavigate).toHaveBeenCalledExactlyOnceWith('git');
        expect(latestCommit).toHaveBeenCalledExactlyOnceWith('git');
        await act(async () => { (presentation as (intent: unknown) => void)({ scopeId: 'phone-press', pane: 'details', tab: createSessionBoardDetailsTab() }); });
        expect(latestNavigate).toHaveBeenLastCalledWith('tabs');
        expect(latestCommit).toHaveBeenLastCalledWith('tabs');
    } finally {
        await screen.unmount();
    }
});
