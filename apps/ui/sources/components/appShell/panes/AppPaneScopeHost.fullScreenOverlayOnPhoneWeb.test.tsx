import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 390, height: 844 }),
    getLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 2000;
        if (key === 'detailsPaneWidthPx') return 420;
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
    useDeviceType: () => 'phone',
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

describe('AppPaneScopeHost (phone web full-screen overlays)', () => {
    it('uses full container width for overlay right pane on phone-sized web', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={null}
                />);

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.kind).toBe('overlayStack');
        expect(lastProps.layout.right).toBe('overlay');
        expect(lastProps.rightDockWidthPx).toBe(390);
    });
});
