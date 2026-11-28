import { readPaneGeometry, writePaneGeometry } from '@/sync/domains/state/paneGeometryUiState';
import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { AppPaneScopeLayoutState } from './hooks/useAppPaneScopeLayout';

// Window geometry and the disconnected transport are real system boundaries.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', useWindowDimensions: () => ({ width: 1200, height: 900 }) });
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppPaneProvider } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { useAppPaneScope } = await import('./hooks/useAppPaneScope');
const { useOptionalAppPaneScopeLayout } = await import('./hooks/useAppPaneScopeLayout');
const initialStorage = storage.getState();

afterEach(async () => { await standardCleanup(); storage.setState(initialStorage, true); });

const bottomPaneBuiltinAdapter = {
    destinationIds: ['terminal'], defaultDestinationId: 'terminal', render: () => <div />,
};

async function renderBottomHost(heightPx: number) {
    storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: true }, { source: 'ui' });
    writePaneGeometry('bottomPaneHeightPx', heightPx);
    const layouts: AppPaneScopeLayoutState[] = [];
    function Probe() {
        const layout = useOptionalAppPaneScopeLayout();
        if (layout) layouts.push(layout);
        return null;
    }
    function Host() {
        const { openBottom } = useAppPaneScope('bottom-height');
        React.useEffect(() => openBottom({ tabId: 'terminal' }), [openBottom]);
        return <AppPaneScopeHost scopeId="bottom-height" main={<Probe />} bottomPaneBuiltinAdapter={bottomPaneBuiltinAdapter} />;
    }
    const screen = await renderScreen(<AppPaneProvider><Host /></AppPaneProvider>);
    const geometry = () => {
        const current = layouts.at(-1);
        if (!current) throw new Error('The real pane owner did not publish geometry');
        return current;
    };
    // The real resize seam drives the same owner used by pointer and keyboard gestures.
    const columns = () => screen.root.find(node => typeof node.props.onDragBottomDockHeightPx === 'function');
    return { screen, geometry, columns };
}

describe('AppPaneScopeHost bottom height', () => {
    it('promotes a preferred height that exceeds the dock budget without reserving main height', async () => {
        const { geometry, columns } = await renderBottomHost(560);
        expect(geometry()).toMatchObject({ bottomPresentation: 'overlay', mainRegionHeightPx: 900 });
        expect(columns().props.bottomDockHeightPx).toBe(560);
        expect(columns().props.bottomDockMaxHeightPx).toBe(900);
    });

    it('promotes a drag past the dock budget and restores the full main height', async () => {
        const { geometry, columns } = await renderBottomHost(320);
        expect(geometry()).toMatchObject({ bottomPresentation: 'docked', mainRegionHeightPx: 580 });
        await act(async () => columns().props.onDragBottomDockHeightPx(560));
        expect(geometry()).toMatchObject({ bottomPresentation: 'overlay', mainRegionHeightPx: 900 });
        expect(columns().props.bottomDockHeightPx).toBe(560);
        expect(readPaneGeometry('bottomPaneHeightPx')).toBe(320);
    });

    it('uses a newly measured height even while the reported width is zero', async () => {
        const { screen, geometry, columns } = await renderBottomHost(320);
        const before = columns().props.bottomDockMaxHeightPx;
        const host = screen.root.findAllByType(View).find(node => typeof node.props.onLayout === 'function');
        if (!host) throw new Error('Missing measured pane root');
        const onLayout = host.props.onLayout;
        if (!onLayout) throw new Error('Missing pane layout callback');
        await act(async () => onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 0, height: 500 })));
        expect(geometry()).toMatchObject({ containerHeightPx: 500, containerWidthPx: 1200, bottomPresentation: 'overlay', mainRegionHeightPx: 500 });
        expect(columns().props.bottomDockMaxHeightPx).not.toBe(before);
        expect(columns().props.bottomDockMaxHeightPx).toBe(500);
    });
});
