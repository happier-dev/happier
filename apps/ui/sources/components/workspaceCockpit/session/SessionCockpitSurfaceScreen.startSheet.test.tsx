import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
// Exercise the real modal lifecycle as well as pane dispatch and cockpit effects.
vi.doUnmock('@/modal');
vi.doUnmock('@/components/ui/popover');
vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(), useIsFocused: () => true,
}));

await prepareSessionFilesViewTestkit();
const { ModalProvider } = await import('@/modal');
const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createSessionBoardDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
const { SessionCockpitPanePresentationBoundary } = await import('./SessionCockpitTabNavigator');
const { resolveSessionCockpitMobileCatalog } = await import('./sessionCockpitMobileCatalog');
const { paneUiState } = await import('@/sync/domains/state/filePaneUiState');
const { replacePersistentUiStateForTest } = await import('@/dev/testkit/harness/persistentUiState');
const originalPanes = paneUiState.readAll();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => {
    await standardCleanup();
    replacePersistentUiStateForTest(paneUiState, originalPanes);
    await fixture?.dispose();
});

it('keeps phone Start open over the focused Chat scene until the person dismisses it', async () => {
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-start-lifetime.test', rootPath: '/tmp/repo' });
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    let pane!: ReturnType<typeof useAppPaneScope>;
    function StartBody() {
        const scope = useAppPaneScope('phone-start-lifetime');
        return <button data-testid="dismiss-start" onClick={scope.closeDetails}>Dismiss Start</button>;
    }
    function Probe() {
        pane = useAppPaneScope('phone-start-lifetime');
        const register = useAppPaneContext(value => value.registerDriver);
        React.useEffect(() => register({ scopeId: 'phone-start-lifetime', detailsPaneBuiltinAdapter: {
            destinationIds: ['details'], render: () => <StartBody />,
        } }), [register]);
        return null;
    }
    const catalog = resolveSessionCockpitMobileCatalog({ terminalTabAvailable: false });
    const navigate = vi.fn();
    const screen = await fixture.render(<>
        <SessionCockpitPanePresentationBoundary cockpit scopeId="phone-start-lifetime" sessionId="s1" serverId={fixture.home.id}
            catalog={catalog} navigate={navigate} commitSurface={navigate}>
            <SessionCockpitSurfaceScreen catalog={catalog} sessionId="s1" scopeId="phone-start-lifetime" surface="chat" routeServerId={fixture.home.id} />
            <Probe />
        </SessionCockpitPanePresentationBoundary>
        <ModalProvider>{null}</ModalProvider>
    </>);
    const tab = createSessionBoardDetailsTab();
    await act(async () => pane.openDetailsTab(tab, { start: true, intent: 'pinned' }));
    await flushHookEffects({ cycles: 20 });
    expect(pane.scopeState?.details.isOpen).toBe(true);
    expect(screen.getTextContent()).toContain('Dismiss Start');
    expect(navigate).not.toHaveBeenCalled();
    // Subsequent normal pane updates must not turn Chat into an implicit dismissal.
    await act(async () => pane.setDetailsTabState(tab.key, { question: 'Still editing' }));
    await flushHookEffects({ cycles: 20 });
    expect(screen.getTextContent()).toContain('Dismiss Start');
    await act(async () => { screen.tree.findByProps({ 'data-testid': 'dismiss-start' }).props.onClick(); });
    expect(pane.scopeState?.details.isOpen).toBe(false);
    await act(async () => pane.openDetailsTab(tab, { intent: 'pinned', present: false }));
    await flushHookEffects({ cycles: 20 });
    expect(pane.scopeState?.details.isOpen).toBe(false);
    await screen.unmount();
});
