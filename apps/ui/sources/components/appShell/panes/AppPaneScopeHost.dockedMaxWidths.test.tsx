import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';
import { DEFAULT_RIGHT_PREFERRED_PX } from '@/components/ui/panels/paneBreakpoints';


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
let mockedScopeOpen = { right: true, details: false };

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

vi.mock('./AppPaneProvider', () => {
    const useSelectedPaneContext = (select = (value: unknown) => value) => select({
            dispatch: vi.fn(),
            state: {
                scopes: {
                    scope1: {
                        right: { isOpen: mockedScopeOpen.right },
                        details: { isOpen: mockedScopeOpen.details },
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

// Cold runtime-graph loading is collection work, outside the mounted behavior budget.
await import('./AppPaneScopeHost');

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
                    rightPaneBuiltinAdapter={rightPaneBuiltinAdapter}
                />);

        expect(lastProps).not.toBeNull();
        // The right sidebar does not opt into the overlay-at-threshold behavior: a preferred width
        // wider than the budget stays docked and stops where the main content keeps its minimum.
        expect(lastProps.layout.right).toBe('docked');
        expect(lastProps.layout.details).toBe('hidden');
        expect(lastProps.rightDockMaxWidthPx).toBe(835 - 420);
        expect(lastProps.rightDockWidthPx).toBe(835 - 420);
    });

    it('turns the details pane into an overlay when its preferred width would squeeze the main content', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        lastProps = null;
        mockedWindowWidthPx = 835;
        mockedScopeOpen = { right: false, details: true };
        mockedSettings = {
            uiMultiPanePanelsEnabled: true,
            rightPaneWidthPx: 320,
            rightPaneWidthBasisPx: 835,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 835,
            bottomPaneHeightPx: 320,
            bottomPaneHeightBasisPx: 900,
        };

        await renderScreen(<AppPaneScopeHost
                    scopeId="scope1"
                    main={<div />}
                    detailsPaneBuiltinAdapter={detailsPaneBuiltinAdapter}
                />);

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.details).toBe('overlay');
        expect(lastProps.detailsDockWidthPx).toBe(520);
        mockedScopeOpen = { right: true, details: false };
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
                    rightPaneBuiltinAdapter={rightPaneBuiltinAdapter}
                />);

        expect(lastProps).not.toBeNull();
        expect(lastProps.layout.right).toBe('docked');
        expect(lastProps.layout.details).toBe('hidden');
        // The right pane should be able to expand up to the full budget after reserving the main min width.
        expect(lastProps.rightDockMaxWidthPx).toBe(1800 - 420);
        expect(lastProps.rightDockWidthPx).toBe(520);
    });

    it('keeps the right sidebar at its 380 px default width at every window width until the user resizes it', async () => {
        const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
        const render = async (windowWidthPx: number, rightPaneWidthPx: number) => {
            lastProps = null;
            mockedWindowWidthPx = windowWidthPx;
            mockedSettings = {
                uiMultiPanePanelsEnabled: true,
                rightPaneWidthPx,
                rightPaneWidthBasisPx: 1200,
                detailsPaneWidthPx: 520,
                detailsPaneWidthBasisPx: 1200,
                bottomPaneHeightPx: 320,
                bottomPaneHeightBasisPx: 900,
            };
            await renderScreen(<AppPaneScopeHost scopeId="scope1" main={<div />} rightPaneBuiltinAdapter={rightPaneBuiltinAdapter} />);
            return lastProps.rightDockWidthPx as number;
        };
        // The lab's side panel (calm-shell `csinfo`, `csrail`) is 380 px wide.
        expect(await render(1440, DEFAULT_RIGHT_PREFERRED_PX)).toBe(380);
        expect(await render(946, DEFAULT_RIGHT_PREFERRED_PX)).toBe(380);
        // A width the user chose is fixed pixels; it no longer scales with the window.
        expect(await render(1440, 400)).toBe(400);
    });
});
