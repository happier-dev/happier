import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';

const state = vi.hoisted(() => ({ windowWidthPx: 1200 }));
installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const dimensions = () => ({ width: state.windowWidthPx, height: 800, scale: 1, fontScale: 1 });
        return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
    },
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'app' });
let MultiPaneHostWithBottom: typeof import('@/components/ui/panels/MultiPaneHostWithBottom')['MultiPaneHostWithBottom'];
let currentScreen: Awaited<ReturnType<typeof renderPanelScreen>>;
beforeEach(async () => {
    ({ MultiPaneHostWithBottom } = await import('@/components/ui/panels/MultiPaneHostWithBottom'));
    state.windowWidthPx = 1200;
});
function Wrapper({ children }: React.PropsWithChildren) {
    return <runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current',
        interactionEnabled: true, machineId: null, serverId: runtime.serverId, platform: 'web',
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        reloadConnectedAccountProjection: () => {},
    }}>{children}</AppShellPluginUiProjectionValueProvider></runtime.Wrapper>;
}
async function renderScreen(element: React.ReactElement) {
    currentScreen = await renderPanelScreen(element, { wrapper: Wrapper });
    return currentScreen;
}
function hostProps(): React.ComponentProps<typeof MultiPaneHostWithBottom> {
    // Query the real layout host; React TestRenderer's SDK props are untyped.
    return currentScreen.root.findByType(MultiPaneHostWithBottom).props;
}
function useSettings(settings: Partial<ReturnType<typeof storage.getState>['localSettings']>) {
    storage.setState({ localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: true, ...settings } });
}

describe('DetailsPaneHost', () => {
    it('opens a tabless details pane with its header, and closes it when the destination clears the selection', async () => {
        useSettings({ detailsPaneWidthPx: 520, detailsPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const onClose = vi.fn();
        const screen = await renderScreen((<DetailsPaneHost
            main={<div />}
            details={{
                header: { title: 'Auggie', subtitle: 'happier.agent.auggie · 0.0.0' },
                content: React.createElement('PluginDetailStub'),
            }}
            onCloseDetails={onClose}
        />));

        expect(hostProps().layout.details).toBe('docked');
        expect(hostProps().detailsDockWidthPx).toBe(520);
        const pane = screen;
        expect(pane.getTextContent()).toContain('Auggie');
        expect(pane.getTextContent()).toContain('happier.agent.auggie · 0.0.0');
        expect(pane.root.findAll(node => typeof node.type === 'string' && String(node.type) === 'PluginDetailStub')).toHaveLength(1);
        await pressTestInstance(pane.findByTestId('details-pane.header.close')!);
        expect(onClose).toHaveBeenCalledTimes(1);

        await screen.update((<DetailsPaneHost main={<div />} details={null} onCloseDetails={onClose} />));
        expect(hostProps().detailsPane).toBeNull();
        expect(hostProps().layout.details).toBe('hidden');
    });

    it('overlays instead of squeezing the main content below the minimum the destination declares', async () => {
        useSettings({ detailsPaneWidthPx: 520, detailsPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const details = { content: React.createElement('PluginDetailStub') };

        // 1200 − 520 leaves 680 for main: enough for the canonical minimum…
        await renderScreen((<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} />));
        expect(hostProps().layout.details).toBe('docked');

        // …but not for a page that needs 700 (two card columns, say): the pane floats over it.
        await renderScreen((<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} mainMinWidthPx={700} />));
        expect(hostProps().layout.details).toBe('overlay');
        expect(hostProps().detailsDockWidthPx).toBe(520);
    });

    it('persists a resized width, with the container it was chosen in, for every details pane', async () => {
        useSettings({ detailsPaneWidthPx: 520, detailsPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        await renderScreen((<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
        />));

        await act(async () => { hostProps().onCommitDetailsDockWidthPx?.(610); });
        // (The pane provider persists its own scopes too; only the width writes are this contract.)
        expect(storage.getState().localSettings).toMatchObject({ detailsPaneWidthPx: 610, detailsPaneWidthBasisPx: 1200 });
    });

    it('budgets the docked pane from its own container, so the shell column beside it is a fixed claim', async () => {
        // Window 1440, but the shell's rail and contextual column take 450 of it: the page gets 990.
        state.windowWidthPx = 1440;
        useSettings({ detailsPaneWidthPx: 400, detailsPaneWidthBasisPx: 990 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const screen = await renderScreen((<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
            mainMinWidthPx={560}
        />));
        const root = screen.root.findAll((node) => typeof node.props?.onLayout === 'function')[0];
        await act(async () => {
            root.props.onLayout({ nativeEvent: { layout: { width: 990, height: 800 } } });
        });

        expect(hostProps().layout.details).toBe('docked');
        expect(hostProps().detailsDockMaxWidthPx).toBe(990 - 560);
    });

    it('never docks wider than main allows while dragging: pulled past the threshold it becomes an overlay and stays one', async () => {
        state.windowWidthPx = 990;
        useSettings({ detailsPaneWidthPx: 400, detailsPaneWidthBasisPx: 990 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        await renderScreen((<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
            mainMinWidthPx={560}
        />));
        const budget = 990 - 560;

        // Dragging inside the budget: still docked, and the docked pane can never be made wider.
        await act(async () => {
            hostProps().onDragDetailsDockWidthPx?.(420, { attemptedSizePx: 420, clampedSizePx: 420, exceededMinPx: false, exceededMaxPx: false });
        });
        expect(hostProps().layout.details).toBe('docked');
        expect(hostProps().detailsDockMaxWidthPx).toBe(budget);

        // Pulling past it: the pane leaves the row and floats over main at the pulled width.
        await act(async () => {
            hostProps().onDragDetailsDockWidthPx?.(budget, { attemptedSizePx: 600, clampedSizePx: budget, exceededMinPx: false, exceededMaxPx: true });
        });
        expect(hostProps().layout.details).toBe('overlay');
        expect(hostProps().detailsDockWidthPx).toBe(600);

        // The docked handle unmounts mid-drag (it became an overlay): the pane keeps the width it was pulled to.
        await act(async () => {
            hostProps().onDragDetailsDockWidthPx?.(null, null);
        });
        expect(storage.getState().localSettings.detailsPaneWidthPx).toBe(600);
    });

    it("stands a destination's details and the App's right sidebar in one pane host", async () => {
        useSettings({ detailsPaneWidthPx: 420, detailsPaneWidthBasisPx: 1200, rightPaneWidthPx: 360, rightPaneWidthBasisPx: 1200 });
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        await renderScreen(<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
        />);
        await act(async () => {
            runtime.pane.selectRightDestination({
                kind: 'plugin', destination: { pluginId: 'happier.inspector', localId: 'inspector-panel' },
            });
        });
        expect(hostProps().detailsPane).not.toBeNull();
        expect(hostProps().rightPane).not.toBeNull();
        expect(hostProps().layout.details).not.toBe('hidden');
        expect(hostProps().layout.right).not.toBe('hidden');
    });

    it('reports no side pane on phones so the destination pushes a page instead', async () => {
        useSettings({});
        const { useDetailsPaneAvailable } = await import('./detailsPaneAvailability');
        const seen: boolean[] = [];
        const Probe = () => { seen.push(useDetailsPaneAvailable()); return null; };
        await renderScreen(<Probe />);
        state.windowWidthPx = 390;
        await renderScreen(<Probe />);
        expect(seen[0]).toBe(true);
        expect(seen[seen.length - 1]).toBe(false);
    });
});
