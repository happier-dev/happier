import { writePaneGeometry } from '@/sync/domains/state/paneGeometryUiState';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

let width = 1200;
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', useWindowDimensions: () => ({ width, height: 900, scale: 1, fontScale: 1 }) });
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const initialStorage = storage.getState();
beforeEach(() => {
    storage.getState().applyLocalSettings({ paneArrangement: 'session', uiMultiPanePanelsEnabled: true }, { source: 'ui' });
    writePaneGeometry('rightPaneWidthPx', 360);
});
afterEach(async () => { await standardCleanup(); storage.setState(initialStorage, true); width = 1200; });
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { MultiPaneHostWithBottom } = await import('@/components/ui/panels/MultiPaneHostWithBottom');

const rightAdapter = { destinationIds: ['right'], defaultDestinationId: 'right', render: () => <div /> };
function Main() {
    const { dispatch } = useAppPaneContext();
    React.useEffect(() => {
        dispatch({ type: 'openRight', scopeId: 'app' });
        dispatch({ type: 'setMainHidden', scopeId: 'app', hidden: true });
    }, [dispatch]);
    return <div />;
}

describe('AppPaneScopeHost hidden main sizing', () => {
    it.each([1200, 1800])('fills the remaining %i px host budget without a global pane cap', async (hostWidth) => {
        width = hostWidth;
        const screen = await renderScreen(<AppPaneProvider><AppPaneScopeHost
            scopeId="app" main={<Main />}
            mainColumn={{ hideLabel: 'Hide page', showLabel: 'Show page', identity: { name: 'Page' } }}
            rightPaneBuiltinAdapter={rightAdapter}
            destinationDetails={{ pane: <div />, onClose: () => {} }}
        /></AppPaneProvider>);
        const paneHost = screen.findByType(MultiPaneHostWithBottom);
        expect(paneHost.props.layout.right).toBe('docked');
        expect(paneHost.props.layout.details).toBe('docked');
        expect(paneHost.props.rightDockWidthPx).toBe(360);
        expect(paneHost.props.detailsDockWidthPx).toBe(hostWidth - 360);
        await screen.unmount();
    });
});
