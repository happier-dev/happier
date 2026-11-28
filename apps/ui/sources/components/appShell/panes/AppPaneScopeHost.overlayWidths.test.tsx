import { writePaneGeometry } from '@/sync/domains/state/paneGeometryUiState';
import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastProps: any = null;
const rightPaneBuiltinAdapter = {
    destinationIds: ['right'],
    defaultDestinationId: 'right',
    render: () => <div />,
};
const detailsPaneBuiltinAdapter = {
    destinationIds: ['details'],
    defaultDestinationId: 'details',
    render: () => <div />,
};

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 2000, height: 900 }),
    getLocalSetting: (key) => {
        if (key === 'uiMultiPanePanelsEnabled') return true;
        return null;
    },
});

vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: any) => {
        lastProps = props;
        return React.createElement('MultiPaneHostStub');
    },
}));

vi.mock('./AppPaneProvider', () => {
    const useSelectedPaneContext = (select = (value: unknown) => value) => select({
            dispatch: vi.fn(),
            state: {
                scopes: {
                    scope1: {
                        right: { isOpen: true },
                        details: { isOpen: true },
                        bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
                    },
                },
            },
            getDriver: () => null,
            registerDriver: () => () => {},
            driverRegistryVersion: 1,
        });
    return { useAppPaneContext: useSelectedPaneContext, useOptionalAppPaneContext: useSelectedPaneContext };
});

describe('AppPaneScopeHost (overlay widths)', () => {
    it('allows overlay panes to use widths beyond docked global max constraints', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        writePaneGeometry('rightPaneWidthPx', 360);
        writePaneGeometry('detailsPaneWidthPx', 1400);

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    rightPaneBuiltinAdapter={rightPaneBuiltinAdapter}
                    detailsPaneBuiltinAdapter={detailsPaneBuiltinAdapter}
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
