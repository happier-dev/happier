import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 1200, height: 800 }),
    getLocalSetting: (key) => {
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
            activeScopeId: 'scope1',
            focusMode: { scopeId: 'scope1' },
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

describe('AppPaneScopeHost (focus mode widths)', () => {
    it('stretches docked details pane to fill remaining width', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={<div />}
                />);

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.kind).not.toBe('single');
        expect(lastProps.layout.right).toBe('docked');
        expect(lastProps.layout.details).toBe('docked');

        // In focus mode, main is effectively hidden, so details should expand to fill the full
        // container width minus the right pane.
        expect(lastProps.rightDockWidthPx).toBe(360);
        expect(lastProps.detailsDockWidthPx).toBe(1200 - 360);
    });
});
