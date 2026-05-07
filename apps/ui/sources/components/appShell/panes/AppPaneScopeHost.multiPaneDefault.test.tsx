import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastMultiPaneLayout: any = null;

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 1200, height: 800 }),
    getLocalSetting: (key: string) => {
        if (key === 'uiMultiPanePanelsEnabled') return undefined;
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
                    details: { isOpen: false },
                },
            },
        },
        getDriver: () => null,
        driverRegistryVersion: 1,
    }),
}));

describe('AppPaneScopeHost (multi-pane default)', () => {
    it('treats uiMultiPanePanelsEnabled as enabled when unset', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastMultiPaneLayout = null;

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPane={<div />}
                    detailsPane={null}
                />);

        expect(lastMultiPaneLayout).not.toBeNull();
        expect(lastMultiPaneLayout.kind).not.toBe('single');
        expect(lastMultiPaneLayout.right).not.toBe('hidden');
    });
});
