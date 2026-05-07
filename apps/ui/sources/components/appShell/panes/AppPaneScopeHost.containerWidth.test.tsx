import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastMultiPaneLayout: any = null;

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 1200, height: 800 }),
    getLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 420;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        if (key === 'bottomPaneHeightPx') return 320;
        if (key === 'bottomPaneHeightBasisPx') return 900;
        return null;
    },
});

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: any) => {
        lastMultiPaneLayout = props.layout;
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
                    right: { isOpen: true },
                    details: { isOpen: true },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost', () => {
    it('uses measured container width (onLayout) when resolving multi-pane breakpoints', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastMultiPaneLayout = null;

        const screen = await renderScreen(
            <AppPaneScopeHost
                scopeId="scope1"
                main={<div />}
                rightPane={<div />}
                detailsPane={<div />}
            />,
        );

        expect(lastMultiPaneLayout).not.toBeNull();
        const initialKind = lastMultiPaneLayout.kind;

        const rootView = screen.findByType('View' as any);
        expect(typeof rootView.props.onLayout).toBe('function');

        await act(async () => {
            rootView.props.onLayout({ nativeEvent: { layout: { width: 600, height: 800 } } });
        });

        expect(lastMultiPaneLayout.kind).not.toBe(initialKind);
        expect(lastMultiPaneLayout.kind).toBe('overlayStack');
        expect(lastMultiPaneLayout.details).toBe('overlay');
        expect(lastMultiPaneLayout.right).toBe('hidden');
    });
});
