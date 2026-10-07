import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from '../appPaneScopeHostTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    lastHostProps: null as any,
    windowWidthPx: 1200,
    deviceType: 'tablet' as 'phone' | 'tablet',
    settings: {} as Record<string, unknown>,
    writes: [] as Array<[string, unknown]>,
}));

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: state.windowWidthPx, height: 800 }),
    getLocalSetting: (key) => (Object.prototype.hasOwnProperty.call(state.settings, key) ? state.settings[key] : null),
    onSetLocalSetting: (key, value) => { state.writes.push([key, value]); },
});

// The pane host's layout decision is the contract under test; the presentational column host is
// the boundary it hands that decision to.
vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: any) => {
        state.lastHostProps = props;
        return React.createElement('MultiPaneHostStub');
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => state.deviceType,
    useHeaderHeight: () => 56,
}));

/** The details pane stands in the App's pane host: render it under the app-lifetime pane provider. */
async function inAppPanes(element: React.ReactElement): Promise<React.ReactElement> {
    const { AppPaneProvider } = await import('../AppPaneProvider');
    return <AppPaneProvider>{element}</AppPaneProvider>;
}

function useSettings(settings: Record<string, unknown>) {
    state.settings = { uiMultiPanePanelsEnabled: true, ...settings };
}

afterEach(() => {
    state.lastHostProps = null;
    state.writes = [];
    state.windowWidthPx = 1200;
    state.deviceType = 'tablet';
});

describe('DetailsPaneHost', () => {
    it('opens a tabless details pane with its header, and closes it when the destination clears the selection', async () => {
        useSettings({ detailsPaneWidthPx: 520, detailsPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const onClose = vi.fn();
        const screen = await renderScreen(await inAppPanes(<DetailsPaneHost
            main={<div />}
            details={{
                header: { title: 'Auggie', subtitle: 'happier.agent.auggie · 0.0.0' },
                content: React.createElement('PluginDetailStub'),
            }}
            onCloseDetails={onClose}
        />));

        expect(state.lastHostProps.layout.details).toBe('docked');
        expect(state.lastHostProps.detailsDockWidthPx).toBe(520);
        const pane = await renderScreen(state.lastHostProps.detailsPane);
        expect(pane.findByTestId('details-pane.header.title')?.props.children).toBe('Auggie');
        expect(pane.getTextContent()).toContain('happier.agent.auggie · 0.0.0');
        expect(pane.root.findAllByType('PluginDetailStub' as any)).toHaveLength(1);
        await pressTestInstance(pane.findByTestId('details-pane.header.close')!);
        expect(onClose).toHaveBeenCalledTimes(1);

        await screen.update(await inAppPanes(<DetailsPaneHost main={<div />} details={null} onCloseDetails={onClose} />));
        expect(state.lastHostProps.detailsPane).toBeNull();
        expect(state.lastHostProps.layout.details).toBe('hidden');
    });

    it('overlays instead of squeezing the main content below the minimum the destination declares', async () => {
        useSettings({ detailsPaneWidthPx: 520, detailsPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const details = { content: React.createElement('PluginDetailStub') };

        // 1200 − 520 leaves 680 for main: enough for the canonical minimum…
        await renderScreen(await inAppPanes(<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} />));
        expect(state.lastHostProps.layout.details).toBe('docked');

        // …but not for a page that needs 700 (two card columns, say): the pane floats over it.
        await renderScreen(await inAppPanes(<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} mainMinWidthPx={700} />));
        expect(state.lastHostProps.layout.details).toBe('overlay');
        expect(state.lastHostProps.detailsDockWidthPx).toBe(520);
    });

    it('persists a resized width, with the container it was chosen in, for every details pane', async () => {
        useSettings({ detailsPaneWidthPx: 520, detailsPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        await renderScreen(await inAppPanes(<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
        />));

        state.lastHostProps.onCommitDetailsDockWidthPx(610);
        // (The pane provider persists its own scopes too; only the width writes are this contract.)
        expect(state.writes.filter(([key]) => key.startsWith('detailsPaneWidth')))
            .toEqual([['detailsPaneWidthPx', 610], ['detailsPaneWidthBasisPx', 1200]]);
    });

    it('budgets the docked pane from its own container, so the shell column beside it is a fixed claim', async () => {
        // Window 1440, but the shell's rail and contextual column take 450 of it: the page gets 990.
        state.windowWidthPx = 1440;
        useSettings({ detailsPaneWidthPx: 400, detailsPaneWidthBasisPx: 990 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const screen = await renderScreen(await inAppPanes(<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
            mainMinWidthPx={560}
        />));
        const root = screen.root.findAll((node) => typeof node.props?.onLayout === 'function')[0];
        await act(async () => {
            root.props.onLayout({ nativeEvent: { layout: { width: 990, height: 800 } } });
        });

        expect(state.lastHostProps.layout.details).toBe('docked');
        expect(state.lastHostProps.detailsDockMaxWidthPx).toBe(990 - 560);
    });

    it('never docks wider than main allows while dragging: pulled past the threshold it becomes an overlay and stays one', async () => {
        state.windowWidthPx = 990;
        useSettings({ detailsPaneWidthPx: 400, detailsPaneWidthBasisPx: 990 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        await renderScreen(await inAppPanes(<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
            mainMinWidthPx={560}
        />));
        const budget = 990 - 560;

        // Dragging inside the budget: still docked, and the docked pane can never be made wider.
        await act(async () => {
            state.lastHostProps.onDragDetailsDockWidthPx(420, { attemptedSizePx: 420, clampedSizePx: 420, exceededMinPx: false, exceededMaxPx: false });
        });
        expect(state.lastHostProps.layout.details).toBe('docked');
        expect(state.lastHostProps.detailsDockMaxWidthPx).toBe(budget);

        // Pulling past it: the pane leaves the row and floats over main at the pulled width.
        await act(async () => {
            state.lastHostProps.onDragDetailsDockWidthPx(budget, { attemptedSizePx: 600, clampedSizePx: budget, exceededMinPx: false, exceededMaxPx: true });
        });
        expect(state.lastHostProps.layout.details).toBe('overlay');
        expect(state.lastHostProps.detailsDockWidthPx).toBe(600);

        // The docked handle unmounts mid-drag (it became an overlay): the pane keeps the width it was pulled to.
        await act(async () => {
            state.lastHostProps.onDragDetailsDockWidthPx(null, null);
        });
        expect(state.writes).toContainEqual(['detailsPaneWidthPx', 600]);
    });

    it("stands a destination's details and the App's right sidebar in one pane host", async () => {
        useSettings({ detailsPaneWidthPx: 420, detailsPaneWidthBasisPx: 1200, rightPaneWidthPx: 360, rightPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const { AppPaneProvider, useAppPaneContext } = await import('../AppPaneProvider');
        const { APP_PANE_SCOPE_ID } = await import('@/components/appShell/rightSidebar/appScopeRightSidebarNavigation');
        let dispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | null = null;
        function DispatchProbe() {
            dispatch = useAppPaneContext().dispatch;
            return null;
        }
        await renderScreen(
            <AppPaneProvider>
                <DispatchProbe />
                <DetailsPaneHost
                    main={<div />}
                    details={{ content: React.createElement('PluginDetailStub') }}
                    onCloseDetails={() => {}}
                />
            </AppPaneProvider>,
        );
        // An App panel opened on this page (as the rail's Inspector entry does) joins the same host.
        await act(async () => {
            dispatch!({
                type: 'selectRightDestination',
                scopeId: APP_PANE_SCOPE_ID,
                destination: { kind: 'plugin', destination: { pluginId: 'happier.inspector', localId: 'inspector-panel' } },
            });
        });
        expect(state.lastHostProps.detailsPane).not.toBeNull();
        expect(state.lastHostProps.rightPane).not.toBeNull();
        expect(state.lastHostProps.layout.details).not.toBe('hidden');
        expect(state.lastHostProps.layout.right).not.toBe('hidden');
    });

    it('reports no side pane on phones so the destination pushes a page instead', async () => {
        useSettings({});
        const { useDetailsPaneAvailable } = await import('./detailsPaneAvailability');
        const seen: boolean[] = [];
        const Probe = () => { seen.push(useDetailsPaneAvailable()); return null; };
        await renderScreen(<Probe />);
        state.deviceType = 'phone';
        await renderScreen(<Probe />);
        expect(seen[0]).toBe(true);
        expect(seen[seen.length - 1]).toBe(false);
    });
});
