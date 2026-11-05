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
const { SessionCockpitPanePresentationBoundary } = await import('./SessionCockpitTabNavigator');

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
