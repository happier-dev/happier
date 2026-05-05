import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 2000, height: 900 }),
    getLocalSetting: (key) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 2000;
        // A user-resized overlay preference above the global docked max.
        if (key === 'detailsPaneWidthPx') return 1400;
        if (key === 'detailsPaneWidthBasisPx') return 2000;
        if (key === 'bottomPaneHeightPx') return 320;
        if (key === 'bottomPaneHeightBasisPx') return 900;
        return null;
    },
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
                    right: { isOpen: true },
                    details: { isOpen: true },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (overlay widths)', () => {
    it('allows overlay panes to use widths beyond docked global max constraints', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={<div />}
                />);

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.right).toBe('docked');
        expect(lastProps.layout.details).toBe('overlay');
        expect(lastProps.rightDockWidthPx).toBe(360);
        // Overlay details should honor the stored width preference when it fits inside the main region.
        expect(lastProps.detailsDockWidthPx).toBe(1400);
        expect(lastProps.detailsDockMaxWidthPx).toBeGreaterThanOrEqual(1400);
    });
});
