import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;
let mockedWindowHeightPx = 900;
let mockedSettings: Record<string, any> = {
    uiMultiPanePanelsEnabled: true,
    rightPaneWidthPx: 520,
    rightPaneWidthBasisPx: 1200,
    detailsPaneWidthPx: 520,
    detailsPaneWidthBasisPx: 1200,
    bottomPaneHeightPx: 320,
    bottomPaneHeightBasisPx: 900,
};

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 1200, height: mockedWindowHeightPx }),
    getLocalSetting: (key: string) =>
        Object.prototype.hasOwnProperty.call(mockedSettings, key) ? mockedSettings[key] : null,
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
                    right: { isOpen: false, activeTabId: null },
                    details: { isOpen: false, tabs: [], activeTabKey: null },
                    bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (bottom overlay height)', () => {
    it('promotes the bottom pane to overlay when the preferred height no longer fits docked layout', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        mockedWindowHeightPx = 900;
        mockedSettings = {
            uiMultiPanePanelsEnabled: true,
            rightPaneWidthPx: 520,
            rightPaneWidthBasisPx: 1200,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 1200,
            bottomPaneHeightPx: 560,
            bottomPaneHeightBasisPx: 900,
        };

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                bottomPane={<div />}
            />,
        );

        expect(lastProps).not.toBeNull();
        expect(lastProps.bottomPresentation).toBe('overlay');
        expect(lastProps.bottomDockHeightPx).toBe(560);
        expect(lastProps.bottomDockMaxHeightPx).toBe(900);
    });

    it('promotes the bottom pane to overlay while the user drags it beyond the dock budget', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        mockedWindowHeightPx = 900;
        mockedSettings = {
            uiMultiPanePanelsEnabled: true,
            rightPaneWidthPx: 520,
            rightPaneWidthBasisPx: 1200,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 1200,
            bottomPaneHeightPx: 320,
            bottomPaneHeightBasisPx: 900,
        };

        await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                bottomPane={<div />}
            />,
        );

        expect(lastProps).not.toBeNull();
        expect(lastProps.bottomPresentation).toBe('docked');

        await act(async () => {
            lastProps.onDragBottomDockHeightPx(560);
        });

        expect(lastProps.bottomPresentation).toBe('overlay');
        expect(lastProps.bottomDockHeightPx).toBe(560);
        expect(lastProps.bottomDockMaxHeightPx).toBe(900);
    });

    it('updates measured height even when the reported width is still zero', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        mockedWindowHeightPx = 900;
        mockedSettings = {
            uiMultiPanePanelsEnabled: true,
            rightPaneWidthPx: 520,
            rightPaneWidthBasisPx: 1200,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 1200,
            bottomPaneHeightPx: 320,
            bottomPaneHeightBasisPx: 900,
        };

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                bottomPane={<div />}
            />,
        );

        const initialBottomDockMaxHeightPx = lastProps.bottomDockMaxHeightPx;
        const rootView = screen.findByType('View');

        await act(async () => {
            rootView.props.onLayout({ nativeEvent: { layout: { width: 0, height: 500 } } });
        });

        expect(lastProps.bottomDockMaxHeightPx).not.toBe(initialBottomDockMaxHeightPx);
    });
});
