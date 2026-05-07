import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;
let mockedWindowWidthPx = 835;
let mockedSettings: Record<string, any> = {
    uiMultiPanePanelsEnabled: true,
    rightPaneWidthPx: 520,
    rightPaneWidthBasisPx: 835,
    detailsPaneWidthPx: 520,
    detailsPaneWidthBasisPx: 835,
    bottomPaneHeightPx: 320,
    bottomPaneHeightBasisPx: 900,
};

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: mockedWindowWidthPx, height: 800 }),
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
                    right: { isOpen: true },
                    details: { isOpen: false },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (docked max widths)', () => {
    it('caps docked right pane max width to preserve main min width', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        mockedWindowWidthPx = 835;
        mockedSettings = {
            uiMultiPanePanelsEnabled: true,
            rightPaneWidthPx: 520,
            rightPaneWidthBasisPx: 835,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 835,
            bottomPaneHeightPx: 320,
            bottomPaneHeightBasisPx: 900,
        };

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={null}
                />);

        expect(lastProps).not.toBeNull();
        // When the user-preferred right width cannot fit while keeping the main region usable,
        // the pane should switch to an overlay instead of forcing a narrow docked layout.
        expect(lastProps.layout.right).toBe('overlay');
        expect(lastProps.layout.details).toBe('hidden');
        expect(lastProps.rightDockMaxWidthPx).toBe(835);
        expect(lastProps.rightDockWidthPx).toBe(520);
    });

    it('allows the docked right pane max width to exceed the legacy 720px cap on wide containers', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        mockedWindowWidthPx = 1800;
        mockedSettings = {
            uiMultiPanePanelsEnabled: true,
            rightPaneWidthPx: 520,
            rightPaneWidthBasisPx: 1800,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 1800,
            bottomPaneHeightPx: 320,
            bottomPaneHeightBasisPx: 900,
        };

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={null}
                />);

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.right).toBe('docked');
        expect(lastProps.layout.details).toBe('hidden');
        // The right pane should be able to expand up to the full budget after reserving the main min width.
        expect(lastProps.rightDockMaxWidthPx).toBe(1800 - 420);
        expect(lastProps.rightDockWidthPx).toBe(520);
    });
});
