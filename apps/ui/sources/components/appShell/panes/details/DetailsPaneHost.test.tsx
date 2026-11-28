import { paneGeometryDefaults, readPaneGeometry, writePaneGeometry } from '@/sync/domains/state/paneGeometryUiState';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';

const state = vi.hoisted(() => ({ windowWidthPx: 1200, hookReadWidths: [] as number[] }));
installSessionDetailsPanelNonRnModuleMocks();
// Collection-time SDK registration supplies stable functions to already-imported consumers.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // The testkit routes `Dimensions.get` (the presentation geometry authority) through this read.
    return createReactNativeWebMock({
        useWindowDimensions: () => {
            state.hookReadWidths.push(state.windowWidthPx);
            return { width: state.windowWidthPx, height: 800, scale: 1, fontScale: 1 };
        },
    });
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'app' });
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
// Collection-time consumers bind the same real store as the runtime harness.
vi.doUnmock('@/sync/domains/state/storage');
// Load the real graph once after platform/transport registration, outside the
// per-journey budget. A cold import must not outlive a timed-out render act().
const { MultiPaneHostWithBottom } = await import('@/components/ui/panels/MultiPaneHostWithBottom');
const { DetailsPaneHost } = await import('./DetailsPaneHost');
let currentScreen: Awaited<ReturnType<typeof renderPanelScreen>>;
beforeEach(async () => {
    state.windowWidthPx = 1200;
    state.hookReadWidths = [];
});
function Wrapper({ children }: React.PropsWithChildren) {
    return <runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current',
        interactionEnabled: true, machineId: null, serverId: runtime.serverId, platform: 'web',
        accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        reloadConnectedAccountProjection: () => {},
    }}>{children}</AppShellPluginUiProjectionValueProvider></runtime.Wrapper>;
}
async function renderScreen(element: React.ReactElement) {
    currentScreen = await renderPanelScreen(element, { wrapper: Wrapper });
    return currentScreen;
}
function hostProps(): React.ComponentProps<typeof MultiPaneHostWithBottom> {
    // Query the real layout host through the component-typed renderer boundary.
    return currentScreen.findByType<typeof MultiPaneHostWithBottom>(MultiPaneHostWithBottom).props;
}
function setPaneFixture(widths: Partial<Record<'detailsPaneWidthPx' | 'rightPaneWidthPx', number>>) {
    storage.setState({ localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: true } });
    writePaneGeometry('detailsPaneWidthPx', widths.detailsPaneWidthPx ?? paneGeometryDefaults.detailsPaneWidthPx);
    writePaneGeometry('rightPaneWidthPx', widths.rightPaneWidthPx ?? paneGeometryDefaults.rightPaneWidthPx);
}

describe('DetailsPaneHost', () => {
    it('opens a tabless details pane with its header, and closes it when the destination clears the selection', async () => {
        setPaneFixture({ detailsPaneWidthPx: 520 });
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

    it('never squeezes the main content below the minimum the destination declares: it clamps, then overlays', async () => {
        setPaneFixture({ detailsPaneWidthPx: 520 });
        const details = { content: React.createElement('PluginDetailStub') };

        // 1200 − 520 leaves 680 for main: enough for the canonical minimum…
        await renderScreen((<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} />));
        expect(hostProps().layout.details).toBe('docked');

        // …a page that needs 700 (two card columns, say) keeps it: the pane docks at the 500 left beside it
        // (UI refinements 2026-11-18: a stored width is clamped, never a reason to float)…
        await renderScreen((<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} mainMinWidthPx={700} />));
        expect(hostProps().layout.details).toBe('docked');
        expect(hostProps().detailsDockMaxWidthPx).toBe(500);

        // …and only a page whose minimum leaves less than the pane's own minimum (300 < 320) has it float over it.
        await renderScreen((<DetailsPaneHost main={<div />} details={details} onCloseDetails={() => {}} mainMinWidthPx={900} />));
        expect(hostProps().layout.details).toBe('overlay');
        expect(hostProps().detailsDockWidthPx).toBe(520);
    });

    it('persists a fixed resized width for every details pane', async () => {
        setPaneFixture({ detailsPaneWidthPx: 520 });
        await renderScreen((<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
        />));

        await act(async () => { hostProps().onCommitDetailsDockWidthPx?.(610); });
        // (The pane provider persists its own scopes too; only the width writes are this contract.)
        expect(readPaneGeometry('detailsPaneWidthPx')).toBe(610);
    });

    it('budgets the docked pane from its own container, so the shell column beside it is a fixed claim', async () => {
        // Window 1440, but the shell's rail and contextual column take 450 of it: the page gets 990.
        state.windowWidthPx = 1440;
        setPaneFixture({ detailsPaneWidthPx: 400 });
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
        setPaneFixture({ detailsPaneWidthPx: 400 });
        await renderScreen((<DetailsPaneHost
            main={<div />}
            details={{ content: React.createElement('PluginDetailStub') }}
            onCloseDetails={() => {}}
            mainMinWidthPx={560}
        />));
        const budget = 990 - 560;

        // Dragging inside the budget: still docked, and the docked pane can never be made wider.
        await act(async () => {
            hostProps().onDragDetailsDockWidthPx?.(420, { attemptedSizePx: 420, clampedSizePx: 420, exceededMinPx: false, exceededMaxPx: false, overshootPx: 0, collapseArmed: false });
        });
        expect(hostProps().layout.details).toBe('docked');
        expect(hostProps().detailsDockMaxWidthPx).toBe(budget);

        // Pulling past it: the pane leaves the row and floats over main at the pulled width.
        await act(async () => {
            hostProps().onDragDetailsDockWidthPx?.(budget, { attemptedSizePx: 600, clampedSizePx: budget, exceededMinPx: false, exceededMaxPx: true, overshootPx: 600 - budget, collapseArmed: false });
        });
        expect(hostProps().layout.details).toBe('overlay');
        expect(hostProps().detailsDockWidthPx).toBe(600);

        // The docked handle unmounts mid-drag (it became an overlay): the pane keeps the width it was pulled to.
        await act(async () => {
            hostProps().onDragDetailsDockWidthPx?.(null, null);
        });
        expect(readPaneGeometry('detailsPaneWidthPx')).toBe(600);
    });

    it("stands a destination's details and the App's right sidebar in one pane host", async () => {
        setPaneFixture({ detailsPaneWidthPx: 420, rightPaneWidthPx: 360 });
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
        setPaneFixture({});
        const { useDetailsPaneAvailable } = await import('./detailsPaneAvailability');
        const seen: boolean[] = [];
        const Probe = () => { seen.push(useDetailsPaneAvailable()); return null; };
        await renderScreen(<Probe />);
        state.windowWidthPx = 390;
        state.hookReadWidths = [];
        await renderScreen(<Probe />);
        // A geometry fixture that the real responsive consumer never reads is not a phone RED.
        expect(state.hookReadWidths).toContain(390);
        expect(seen[0]).toBe(true);
        expect(seen[seen.length - 1]).toBe(false);
    });
});
