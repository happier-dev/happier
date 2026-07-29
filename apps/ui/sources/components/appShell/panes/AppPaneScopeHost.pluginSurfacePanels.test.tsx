import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;
let mockedOpenState = {
    right: true,
    bottom: true,
};

const stackSpy = vi.hoisted(() => vi.fn());
const appScopeRightSidebarSpy = vi.hoisted(() => vi.fn());
const placementAvailabilityState = vi.hoisted(() => ({
    side: true,
    bottom: true,
    rightSidebarTab: false,
}));

installAppPaneScopeHostCommonModuleMocks({
    getLocalSetting: (key: string) => key === 'uiMultiPanePanelsEnabled' ? true : null,
});

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: any) => {
        lastProps = props;
        return React.createElement('MultiPaneHostStub');
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('./AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        dispatch: vi.fn(),
        state: {
            scopes: {
                scope1: {
                    right: { isOpen: mockedOpenState.right, activeTabId: null },
                    details: { isOpen: false, tabs: [], activeTabKey: null },
                    bottom: { isOpen: mockedOpenState.bottom, activeTabId: null, tabState: {} },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    AppPluginSurfacePlacementStack: (props: unknown) => {
        stackSpy(props);
        return React.createElement('AppPluginSurfacePlacementStackMock', { props });
    },
    useAppPluginSurfacePlacements: (placement: string) => ({
        placements: placement === 'app.sidePanel'
            ? (placementAvailabilityState.side ? [{}] : [])
            : placement === 'app.bottomPanel' && placementAvailabilityState.bottom ? [{}] : [],
    }),
    useAppShellHasRenderableRightSidebarTabPlacements: () => placementAvailabilityState.rightSidebarTab,
}));

vi.mock('@/components/appShell/rightSidebar/AppScopeRightSidebar', () => ({
    AppScopeRightSidebar: (props: unknown) => {
        appScopeRightSidebarSpy(props);
        return React.createElement('AppScopeRightSidebarMock');
    },
}));

describe('AppPaneScopeHost plugin surface panels', () => {
    it('uses app side and bottom placement stacks as generic fallback pane content', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        stackSpy.mockClear();
        appScopeRightSidebarSpy.mockClear();
        mockedOpenState = { right: true, bottom: true };
        placementAvailabilityState.side = true;
        placementAvailabilityState.bottom = true;
        placementAvailabilityState.rightSidebarTab = false;

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
            />,
        );

        expect(lastProps.rightPane).not.toBeNull();
        expect(lastProps.bottomPane).not.toBeNull();
        expect(lastProps.rightPane.props).toEqual(expect.objectContaining({
            placement: 'app.sidePanel',
        }));
        expect(lastProps.bottomPane.props).toEqual(expect.objectContaining({
            placement: 'app.bottomPanel',
        }));
    });

    it('does not replace explicit scope pane content with app plugin placements', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const explicitRightPane = <div data-testid="right" />;
        const explicitBottomPane = <div data-testid="bottom" />;
        lastProps = null;
        stackSpy.mockClear();

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                rightPane={explicitRightPane}
                bottomPane={explicitBottomPane}
            />,
        );

        expect(lastProps.rightPane).toBe(explicitRightPane);
        expect(lastProps.bottomPane).toBe(explicitBottomPane);
        expect(stackSpy).not.toHaveBeenCalled();
    });

    it('fails closed without mounting empty app plugin panes when projection has no placements', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        stackSpy.mockClear();
        appScopeRightSidebarSpy.mockClear();
        placementAvailabilityState.side = false;
        placementAvailabilityState.bottom = false;
        placementAvailabilityState.rightSidebarTab = false;

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
            />,
        );

        expect(lastProps.rightPane).toBeNull();
        expect(lastProps.bottomPane).toBeNull();
        expect(stackSpy).not.toHaveBeenCalled();
    });

    it('mounts the tabbed app-scope right sidebar when app.rightSidebarTab placements are renderable', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { AppScopeRightSidebar } = await import('@/components/appShell/rightSidebar/AppScopeRightSidebar');
        lastProps = null;
        stackSpy.mockClear();
        appScopeRightSidebarSpy.mockClear();
        mockedOpenState = { right: true, bottom: false };
        placementAvailabilityState.side = false;
        placementAvailabilityState.bottom = false;
        placementAvailabilityState.rightSidebarTab = true;

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
            />,
        );

        // The tabbed app-scope right sidebar (`app.rightSidebarTab`) takes the right pane.
        expect(lastProps.rightPane).not.toBeNull();
        expect(lastProps.rightPane.type).toBe(AppScopeRightSidebar);
        // It is NOT the single-stack `app.sidePanel` placement element.
        expect(lastProps.rightPane.props).not.toEqual(expect.objectContaining({
            placement: 'app.sidePanel',
        }));
    });

    it('prefers the tabbed right sidebar over the single-stack side panel when both are present', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const { AppScopeRightSidebar } = await import('@/components/appShell/rightSidebar/AppScopeRightSidebar');
        lastProps = null;
        stackSpy.mockClear();
        appScopeRightSidebarSpy.mockClear();
        mockedOpenState = { right: true, bottom: false };
        placementAvailabilityState.side = true;
        placementAvailabilityState.bottom = false;
        placementAvailabilityState.rightSidebarTab = true;

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
            />,
        );

        expect(lastProps.rightPane.type).toBe(AppScopeRightSidebar);
        expect(lastProps.rightPane.props).not.toEqual(expect.objectContaining({
            placement: 'app.sidePanel',
        }));
    });
});
