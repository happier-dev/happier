import * as React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import type { ReactTestRenderer } from 'react-test-renderer';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { renderScreen, invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import { act } from 'react-test-renderer';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider, createRetainedPresentationSlotsStore, useRetainedPresentationSlot } from '@/components/ui/presentation/retainedPresentationSlots';
import { useLayoutPresentationActive, usePluginSurfaceCurrentUiContextEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { DestinationInstanceHost, useDestinationFocus, useDestinationParams, useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';

import {
    BrowserPresentationRetentionProvider,
    createBrowserPresentationRetentionStore,
} from './browserPresentationRetention';

function hasTestId(tree: ReactTestRenderer, testID: string): boolean {
    return tree.root.findAll((node) => node.props?.testID === testID).length > 0;
}

/**
 * UX-6: the webview must be hosted by a route-stable portal ABOVE the router, so a sidebar toggle /
 * route change repositions it instead of remounting (reloading) it. These tests drive the portal
 * primitive through a simulated route change and assert the hosted webview instance is preserved.
 */

// A stand-in for the real (expensive) webview engine. It records every mount so the test can prove the
// page was NOT reloaded across a route change. Mounting is the observable proxy for a reload.
let webviewMountCount = 0;

function MountCountingWebview(props: Readonly<{ label: string }>): React.ReactElement {
    React.useEffect(() => {
        webviewMountCount += 1;
    }, []);
    return <Text>{props.label}</Text>;
}

function PortalBinder(props: Readonly<{ slotId: string; label: string }>): React.ReactElement {
    const { portalActive } = useRetainedPresentationSlot({
        slotId: props.slotId,
        node: <MountCountingWebview label={props.label} />,
        geometry: { x: 0, y: 0, width: 320, height: 480 },
        visible: true,
    });
    // When the portal hosts the webview, the panel renders only a geometry placeholder; otherwise it
    // would render the webview inline (covered by the no-provider case below).
    return portalActive
        ? <View testID="binder-placeholder" />
        : <MountCountingWebview label={props.label} />;
}

describe('browser presentation portal (UX-6 webview-above-router)', () => {
    it('moves an explicitly placed picture outside its former pane clip without remounting', async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
        const globals = { window: globalThis.window, HTMLElement: globalThis.HTMLElement };
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        class WebNode {
            parentElement: WebNode | null = null;
            clientLeft = 0;
            clientTop = 0;
            clientWidth = 200;
            clientHeight = 100;
            getBoundingClientRect() { return { x: 20, y: 30, width: 200, height: 100 }; }
            measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) { callback(20, 30, 200, 100); }
        }
        // Only the DOM/window measurement boundary is substituted; placement and retention are real.
        vi.stubGlobal('HTMLElement', WebNode);
        vi.stubGlobal('window', Object.assign(new EventTarget(), {
            innerWidth: 1440, innerHeight: 900, getComputedStyle: () => ({ overflow: 'hidden' }),
        }));
        const placeholder = new WebNode();
        placeholder.parentElement = new WebNode();
        const store = createRetainedPresentationSlotsStore();
        const body = <MountCountingWebview label="moving picture" />;
        type Rect = { x: number; y: number; width: number; height: number };
        function Harness(props: Readonly<{ geometry?: Rect | null; clip?: Rect | null }>) {
            return <RetainedPresentationSlotsProvider store={store}>
                <RetainedPresentationSlotBinder slotId="explicit-placement" enabled
                    windowGeometry={props.geometry} windowClipGeometry={props.clip}>{body}</RetainedPresentationSlotBinder>
            </RetainedPresentationSlotsProvider>;
        }
        webviewMountCount = 0;
        const screen = await renderScreen(<Harness />, { createNodeMock: () => placeholder });
        const placement = () => StyleSheet.flatten(screen.findHostByTestId('browser-presentation-portal-slot-explicit-placement')!.props.style);
        try {
            await act(async () => { invokeTestInstanceHandler(screen.findByTestId('browser-keepalive-placeholder-explicit-placement'), 'onLayout', {}); });
            expect(store.getPortalSnapshot()[0]?.clipGeometry).toEqual({ x: 20, y: 30, width: 200, height: 100 });
            const geometry = { x: 600, y: 400, width: 150, height: 100 };
            await screen.update(<Harness geometry={geometry} />);
            expect(placement()).toMatchObject({ width: 150, height: 100 });
            expect(placement().opacity).not.toBe(0);
            await screen.update(<Harness geometry={null} />);
            expect(placement()).toMatchObject({ width: 150, height: 100 });
            await screen.update(<Harness geometry={geometry} clip={{ x: 600, y: 400, width: 50, height: 50 }} />);
            expect(placement()).toMatchObject({ width: 50, height: 50 });
            await screen.update(<Harness geometry={geometry} clip={null} />);
            expect(placement()).toMatchObject({ width: 150, height: 100 });
            await screen.update(<Harness />);
            expect(placement()).toMatchObject({ width: 200, height: 100 });
            expect(webviewMountCount).toBe(1);
        } finally {
            await screen.unmount();
            for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value);
            if (originalPlatform) Object.defineProperty(Platform, 'OS', originalPlatform);
        }
    });

    it('tracks a retained picture during ancestor scrolling without replacing its source', async () => {
        const originalWindow = globalThis.window;
        const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const scrollEvents = new EventTarget();
        vi.stubGlobal('window', scrollEvents);
        const store = createRetainedPresentationSlotsStore();
        let measured = { x: 1050, y: 250, width: 300, height: 300 };
        webviewMountCount = 0;
        const screen = await renderScreen(<RetainedPresentationSlotsProvider store={store}>
            <RetainedPresentationSlotBinder slotId="scrolling-picture" enabled
                windowClipGeometry={{ x: 1000, y: 200, width: 500, height: 200 }}>
                <MountCountingWebview label="retained picture" />
            </RetainedPresentationSlotBinder>
        </RetainedPresentationSlotsProvider>, {
            // Window measurement and scroll events are the platform boundary; the binder,
            // store, portal and physical-source lifetime remain real.
            createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
                callback(measured.x, measured.y, measured.width, measured.height) }),
        });
        try {
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('browser-keepalive-placeholder-scrolling-picture'), 'onLayout', {});
            });
            expect(store.getPortalSnapshot()[0]?.geometry?.y).toBe(250);
            measured = { ...measured, y: 80 };
            // An ancestor scroll does not emit another layout event for this placeholder.
            await act(async () => { scrollEvents.dispatchEvent(new Event('scroll')); });
            expect(store.getPortalSnapshot()[0]?.geometry?.y).toBe(80);
            expect(store.getPortalSnapshot()[0]?.clipGeometry).toEqual({ x: 1000, y: 200, width: 500, height: 200 });
            expect(webviewMountCount).toBe(1);
        } finally {
            await screen.unmount();
            vi.stubGlobal('window', originalWindow);
            if (originalPlatform) Object.defineProperty(Platform, 'OS', originalPlatform);
        }
    });


    it('remeasures hydration ancestor layout without a window event or remount, and parks layout observation', async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
        const globals = { window: globalThis.window, HTMLElement: globalThis.HTMLElement, ResizeObserver: globalThis.ResizeObserver };
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        let measured = { x: 300, y: 96, width: 380, height: 600 };
        class WebNode {
            parentElement: WebNode | null = null;
            clientLeft = 0;
            clientTop = 0;
            clientWidth = 1000;
            clientHeight = 800;
            constructor(readonly placeholder = false) {}
            getBoundingClientRect() { return this.placeholder ? measured : { x: 0, y: 0, width: this.clientWidth, height: this.clientHeight }; }
            measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) {
                const rect = this.getBoundingClientRect(); callback(rect.x, rect.y, rect.width, rect.height);
            }
        }
        // ResizeObserver and the DOM/native measurement ports are genuine platform boundaries.
        const live = new Set<{ callback: () => void }>();
        class LayoutObserver {
            constructor(readonly callback: () => void) { live.add(this); }
            observe(_target: unknown) {}
            disconnect() { live.delete(this); }
        }
        vi.stubGlobal('HTMLElement', WebNode);
        vi.stubGlobal('ResizeObserver', LayoutObserver);
        vi.stubGlobal('window', Object.assign(new EventTarget(), {
            innerWidth: 1440, innerHeight: 900, getComputedStyle: () => ({ overflow: 'visible' }),
        }));
        const ancestor = new WebNode();
        const placeholder = new WebNode(true);
        placeholder.parentElement = ancestor;
        const overlay = new WebNode();
        const store = createRetainedPresentationSlotsStore();
        const body = <MountCountingWebview label="retained reload page" />;
        function Harness({ visible }: { visible: boolean }) {
            return <RetainedPresentationSlotsProvider store={store}>
                <RetainedPresentationSlotBinder slotId="hydration-layout" enabled visible={visible}>{body}</RetainedPresentationSlotBinder>
            </RetainedPresentationSlotsProvider>;
        }
        webviewMountCount = 0;
        const screen = await renderScreen(<Harness visible />, {
            createNodeMock: element => String(element.props.testID ?? '').startsWith('browser-keepalive-placeholder') ? placeholder : overlay,
        });
        try {
            await act(async () => { invokeTestInstanceHandler(screen.findByTestId('browser-keepalive-placeholder-hydration-layout'), 'onLayout', {}); });
            expect(store.getPortalSnapshot()[0]?.geometry?.x).toBe(300);
            // Hydration changes the enclosing pane, while the fixed-width picture keeps its own size.
            ancestor.clientWidth -= 108;
            measured = { ...measured, x: 192 };
            await act(async () => { for (const observer of [...live]) observer.callback(); });
            expect(store.getPortalSnapshot()[0]?.geometry).toEqual(measured);
            expect(webviewMountCount).toBe(1);
            const listener = vi.fn();
            const release = store.subscribePortal(listener);
            try {
                for (let echo = 0; echo < 139; echo++) await act(async () => { for (const observer of [...live]) observer.callback(); });
                expect(listener).not.toHaveBeenCalled();
            } finally { release(); }
            await screen.update(<Harness visible={false} />);
            expect(live.size).toBe(0);
        } finally {
            await screen.unmount();
            for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value);
            if (originalPlatform) Object.defineProperty(Platform, 'OS', originalPlatform);
        }
    });

    it('does not republish unchanged content or layout echoes and still delivers changed content', async () => {
        const store = createRetainedPresentationSlotsStore();
        let presses = '';
        const firstBody = <Text testID="current-retained-action" onPress={() => { presses = 'first'; }}>First</Text>;
        const nextBody = <Text testID="current-retained-action" onPress={() => { presses = 'next'; }}>Next</Text>;
        function Harness(props: Readonly<{ x: number; body: React.ReactNode }>) {
            return <RetainedPresentationSlotsProvider store={store}>
                <RetainedPresentationSlotBinder slotId="unchanged" enabled
                    windowGeometry={{ x: props.x, y: 20, width: 358, height: 224 }}
                    transition={{ durationMs: 200, easingCss: 'linear', properties: 'transform' }}>
                    {props.body}
                </RetainedPresentationSlotBinder>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness x={16} body={firstBody} />);
        try {
            const initial = store.getPortalSnapshot();
            await screen.update(<Harness x={16} body={firstBody} />);
            expect(store.getPortalSnapshot() === initial).toBe(true);
            await screen.update(<Harness x={32} body={firstBody} />);
            expect(store.getPortalSnapshot()[0]?.geometry?.x).toBe(32);
            expect(store.getPortalSnapshot()[0]?.node).toBe(initial[0]?.node);
            await screen.update(<Harness x={32} body={nextBody} />);
            await screen.pressByTestIdAsync('current-retained-action');
            expect(presses).toBe('next');
            expect(store.getPortalSnapshot()[0]?.node).not.toBe(initial[0]?.node);
        } finally { await screen.unmount(); }
    });

    it('keeps the last measured placement while a replacement visible binder awaits nonzero geometry', async () => {
        const store = createRetainedPresentationSlotsStore();
        let measured = { x: 20, y: 30, width: 640, height: 400 };
        function Harness(props: Readonly<{ phone: boolean; shown?: boolean }>) {
            return <RetainedPresentationSlotsProvider store={store}>
                {props.shown !== false ? <RetainedPresentationSlotBinder key={props.phone ? 'phone' : 'wide'} slotId="reflow" enabled>
                    <MountCountingWebview label="picture" />
                </RetainedPresentationSlotBinder> : null}
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness phone={false} />, {
            // Native/window measurement is the boundary; the binder, registry and portal are real.
            createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(measured.x, measured.y, measured.width, measured.height) }),
        });
        const placement = () => StyleSheet.flatten(screen.findHostByTestId('browser-presentation-portal-slot-reflow')!.props.style);
        const measure = async () => { await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('browser-keepalive-placeholder-reflow'), 'onLayout', {});
        }); };
        try {
            await measure();
            expect(placement()).toMatchObject({ width: 640, height: 400 });
            await screen.update(<Harness phone />);
            expect(placement()).toMatchObject({ width: 640, height: 400 });
            measured = { x: 0, y: 0, width: 0, height: 0 };
            await measure();
            expect(placement()).toMatchObject({ width: 640, height: 400 });
            measured = { x: 16, y: 120, width: 358, height: 224 };
            await measure();
            expect(placement()).toMatchObject({ width: 358, height: 224 });
            await screen.update(<Harness phone={false} />);
            expect(placement()).toMatchObject({ width: 358, height: 224 });
            await screen.update(<Harness phone={false} shown={false} />);
            expect(placement().opacity).toBe(0);
        } finally { await screen.unmount(); }
    });
    it('parks an ordinary hidden pane without an explicit visible prop and preserves its source state', async () => {
        const store = createRetainedPresentationSlotsStore();
        function SourceBody() {
            const [page, setPage] = React.useState('initial');
            return <View testID="ordinary-pane-source" accessibilityLabel={page}>
                <Text testID="ordinary-pane-change-page" onPress={() => setPage('retained-page')}>{page}</Text>
            </View>;
        }
        function Harness(props: Readonly<{ active: boolean }>) {
            return <RetainedPresentationSlotsProvider store={store}>
                <RetainedPanelSurface isActive={props.active} mode="absolute-overlay">
                    <RetainedPresentationSlotBinder slotId="ordinary-pane" enabled><SourceBody /></RetainedPresentationSlotBinder>
                </RetainedPanelSurface>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness active />, {
            // Window measurement is a native UI boundary; portal/layout ownership remains real.
            createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 20, 320, 480) }),
        });
        try {
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('browser-keepalive-placeholder-ordinary-pane'), 'onLayout', {});
            });
            expect(store.getPortalSnapshot()[0]).toMatchObject({ visible: true, geometry: { x: 10, y: 20, width: 320, height: 480 } });
            await screen.pressByTestIdAsync('ordinary-pane-change-page');
            await screen.update(<Harness active={false} />);
            expect(store.getPortalSnapshot()[0]?.visible).toBe(false);
            expect(StyleSheet.flatten(screen.findHostByTestId('browser-presentation-portal-slot-ordinary-pane')!.props.style).opacity).toBe(0);
            expect(screen.findHostByTestId('browser-presentation-portal-slot-ordinary-pane')?.props.pointerEvents).toBe('none');
            expect(screen.findHostByTestId('ordinary-pane-source')?.props.accessibilityLabel).toBe('retained-page');
            await screen.update(<Harness active />);
            expect(store.getPortalSnapshot()[0]?.visible).toBe(true);
            expect(screen.findAllHostsByTestId('ordinary-pane-source')).toHaveLength(1);
            expect(screen.findHostByTestId('ordinary-pane-source')?.props.accessibilityLabel).toBe('retained-page');
        } finally {
            await screen.unmount();
        }
    });
    it('preserves exact destination navigation and retires its focus while parked above the router', async () => {
        const opened: string[] = [];
        function DestinationProbe() {
            const params = useDestinationParams<{ id?: string }>();
            const router = useDestinationRouter();
            return React.createElement('RetainedDestinationProbe', {
                id: params.id, focused: useDestinationFocus(), current: usePluginSurfaceCurrentUiContextEligibility(),
                open: () => router.push('/settings'),
            });
        }
        function Harness(props: Readonly<{ visible: boolean }>) {
            return <BrowserPresentationRetentionProvider>
                {props.visible ? <DestinationInstanceHost tabId="session-a" ref={{ kind: 'session', params: { id: 'A' } }}
                    pathname="/session/A" focused visible navigation={{ push: () => { opened.push('A'); }, replace: () => {}, back: () => {} }}>
                    <RetainedPresentationSlotBinder slotId="destination-a" enabled
                        windowGeometry={{ x: 0, y: 0, width: 320, height: 400 }}><DestinationProbe /></RetainedPresentationSlotBinder>
                </DestinationInstanceHost> : null}
            </BrowserPresentationRetentionProvider>;
        }
        const result = await renderWithAppProviders(<Harness visible />);
        const probe = () => result.tree.root.findByType('RetainedDestinationProbe');
        expect(probe().props.id).toBe('A');
        expect(probe().props.current).toBe(true);
        probe().props.open();
        expect(opened).toEqual(['A']);
        await result.update(<Harness visible={false} />);
        expect(probe().props.focused).toBe(false);
        expect(probe().props.current).toBe(false);
        await result.update(<Harness visible />);
        expect(probe().props.id).toBe('A');
        expect(probe().props.current).toBe(true);
        await result.unmount();
    });
    it('carries the enclosing pane scope right-sidebar chooser into the body it hosts above the router', async () => {
        const { RightSidebarActionsContext } = await import('@/components/appShell/rightSidebar/rightSidebarActions');
        const sideActions = { current: { tabs: ['services'], selectTab: () => {} } };
        function ChooserProbe() {
            return React.createElement('RetainedChooserProbe', { owner: React.useContext(RightSidebarActionsContext) });
        }
        const result = await renderWithAppProviders(<BrowserPresentationRetentionProvider>
            <RightSidebarActionsContext.Provider value={sideActions}>
                <RetainedPresentationSlotBinder slotId="chooser" enabled><ChooserProbe /></RetainedPresentationSlotBinder>
            </RightSidebarActionsContext.Provider>
        </BrowserPresentationRetentionProvider>);
        expect(result.tree.root.findByType('RetainedChooserProbe').props.owner).toBe(sideActions);
        await result.unmount();
    });
    it("keeps its slot's bottom-chrome reservation for the body it hosts above the router", async () => {
        // A phone cockpit screen already reserves the floating tab bar and zeroes it for what it holds;
        // the retained body must read that, not the shell's raw height, or its bottom bar reserves it twice.
        const { SessionCockpitBottomChromeHeightContext, useSessionCockpitBottomChromeHeight } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        function ReservationProbe() {
            return React.createElement('RetainedReservationProbe', { height: useSessionCockpitBottomChromeHeight() });
        }
        const result = await renderWithAppProviders(<SessionCockpitBottomChromeHeightContext.Provider value={56}>
            <BrowserPresentationRetentionProvider>
                <SessionCockpitBottomChromeHeightContext.Provider value={0}>
                    <RetainedPresentationSlotBinder slotId="reservation" enabled><ReservationProbe /></RetainedPresentationSlotBinder>
                </SessionCockpitBottomChromeHeightContext.Provider>
            </BrowserPresentationRetentionProvider>
        </SessionCockpitBottomChromeHeightContext.Provider>);
        expect(result.tree.root.findByType('RetainedReservationProbe').props.height).toBe(0);
        await result.unmount();
    });
    it('retires presentation demand inside a retained body while its binder is parked', async () => {
        function DemandProbe(): React.ReactElement {
            return React.createElement('RetainedDemandProbe', { testID: 'retained-demand', active: useLayoutPresentationActive() });
        }
        function Harness(props: Readonly<{ visible: boolean }>): React.ReactElement {
            return <BrowserPresentationRetentionProvider>
                {props.visible ? <RetainedPresentationSlotBinder slotId="demand-slot" enabled visible
                    windowGeometry={{ x: 0, y: 0, width: 320, height: 400 }}>
                    <DemandProbe />
                </RetainedPresentationSlotBinder> : null}
            </BrowserPresentationRetentionProvider>;
        }
        const result = await renderWithAppProviders(<Harness visible />);
        expect(result.tree.root.findByProps({ testID: 'retained-demand' }).props.active).toBe(true);
        await result.update(<Harness visible={false} />);
        expect(result.tree.root.findByProps({ testID: 'retained-demand' }).props.active).toBe(false);
        await result.update(<Harness visible />);
        expect(result.tree.root.findByProps({ testID: 'retained-demand' }).props.active).toBe(true);
        await result.unmount();
    });
    it('preserves the portal-hosted webview instance across a simulated route change', async () => {
        webviewMountCount = 0;

        function Harness(props: Readonly<{ onBrowserRoute: boolean }>): React.ReactElement {
            return (
                <BrowserPresentationRetentionProvider>
                    {props.onBrowserRoute
                        ? <PortalBinder slotId="session:s1:details:slot" label="wv" />
                        : <View testID="other-route" />}
                </BrowserPresentationRetentionProvider>
            );
        }

        const result = await renderWithAppProviders(<Harness onBrowserRoute />);
        // The portal mounts the webview exactly once.
        expect(webviewMountCount).toBe(1);
        expect(hasTestId(result.tree, 'browser-presentation-portal-slot-session:s1:details:slot')).toBe(true);

        // Route change: the browser panel fully unmounts (a different route renders). The provider +
        // portal host stay mounted above the router.
        await result.update(<Harness onBrowserRoute={false} />);
        expect(hasTestId(result.tree, 'other-route')).toBe(true);
        const retainedSlot = result.tree.root.findByProps({
            testID: 'browser-presentation-portal-slot-session:s1:details:slot',
        });
        expect(retainedSlot.props.pointerEvents).toBe('none');

        // Navigate back to the browser route — a brand-new panel binder mounts.
        await result.update(<Harness onBrowserRoute />);

        // The webview was NOT remounted/reloaded: the route-stable portal kept the same instance alive.
        expect(webviewMountCount).toBe(1);

        await result.unmount();
    });

    it('removes the portal-hosted webview only on an explicit close', async () => {
        const store = createBrowserPresentationRetentionStore();
        store.upsertPortalEntry({
            slotId: 'slot-x',
            node: <Text>wv</Text>,
            geometry: { x: 0, y: 0, width: 10, height: 10 },
            visible: true,
        });
        expect(store.getPortalSnapshot().map((entry) => entry.slotId)).toEqual(['slot-x']);

        // A `closed` lifecycle tears the webview down (a real close, not a route change).
        store.recordLifecycle('slot-x', {
            logicalViewId: 'view-1',
            lifecycleState: 'closed',
            slotsById: {},
            cleanupReason: 'logical_view_closed',
        });
        expect(store.getPortalSnapshot()).toEqual([]);
    });

    it('returns a referentially stable snapshot until the registry mutates', () => {
        const store = createBrowserPresentationRetentionStore();
        const first = store.getPortalSnapshot();
        expect(store.getPortalSnapshot()).toBe(first);

        const entry = {
            slotId: 'slot-y',
            node: <Text>wv</Text>,
            geometry: null,
            visible: false,
        } as const;
        store.upsertPortalEntry(entry);
        const afterInsert = store.getPortalSnapshot();
        expect(afterInsert).not.toBe(first);
        // An idempotent upsert (same entry) must not churn the snapshot reference.
        store.upsertPortalEntry(entry);
        expect(store.getPortalSnapshot()).toBe(afterInsert);
    });

    it('renders the webview inline (no portal) when no provider is mounted', async () => {
        webviewMountCount = 0;
        const result = await renderWithAppProviders(<PortalBinder slotId="slot-z" label="inline" />);
        // No provider ⇒ the binder renders the webview itself; nothing is registered into a portal.
        expect(webviewMountCount).toBe(1);
        expect(hasTestId(result.tree, 'binder-placeholder')).toBe(false);
        await result.unmount();
    });

    it('RetainedPresentationSlotBinder hosts children in the portal when enabled, renders a placeholder', async () => {
        webviewMountCount = 0;
        const result = await renderWithAppProviders(
            <BrowserPresentationRetentionProvider>
                <RetainedPresentationSlotBinder slotId="slot-binder" enabled visible>
                    <MountCountingWebview label="hosted" />
                </RetainedPresentationSlotBinder>
            </BrowserPresentationRetentionProvider>,
        );
        // The webview is hosted by the portal (mounted once), the panel shows only the placeholder.
        expect(webviewMountCount).toBe(1);
        expect(hasTestId(result.tree, 'browser-keepalive-placeholder-slot-binder')).toBe(true);
        expect(hasTestId(result.tree, 'browser-presentation-portal-slot-slot-binder')).toBe(true);
        await result.unmount();
    });

    it('lets a watched body pass the pointer to its presentation and keeps the same instance when it is driven again', async () => {
        webviewMountCount = 0;
        const slot = (inputPassthrough: boolean) => (
            <BrowserPresentationRetentionProvider>
                <RetainedPresentationSlotBinder slotId="watched" enabled visible inputPassthrough={inputPassthrough}
                    windowGeometry={{ x: 10, y: 20, width: 320, height: 200 }}>
                    <MountCountingWebview label="picture" />
                </RetainedPresentationSlotBinder>
            </BrowserPresentationRetentionProvider>
        );
        const result = await renderWithAppProviders(slot(true));
        const portalSlot = () => result.tree.root.findByProps({ testID: 'browser-presentation-portal-slot-watched' });
        // Watched: shown in place, but the frame beneath takes the pointer (it moves and expands by it).
        expect(StyleSheet.flatten(portalSlot().props.style)).toMatchObject({ left: 10, top: 20, width: 320, height: 200 });
        expect(portalSlot().props.pointerEvents).toBe('none');
        await result.update(slot(false));
        expect(portalSlot().props.pointerEvents).toBe('auto');
        expect(webviewMountCount).toBe(1);
        await result.unmount();
    });

    it('RetainedPresentationSlotBinder renders children inline when disabled', async () => {
        webviewMountCount = 0;
        const result = await renderWithAppProviders(
            <BrowserPresentationRetentionProvider>
                <RetainedPresentationSlotBinder slotId="slot-off" enabled={false}>
                    <MountCountingWebview label="inline" />
                </RetainedPresentationSlotBinder>
            </BrowserPresentationRetentionProvider>,
        );
        expect(webviewMountCount).toBe(1);
        expect(hasTestId(result.tree, 'browser-keepalive-placeholder-slot-off')).toBe(false);
        expect(hasTestId(result.tree, 'browser-presentation-portal-slot-slot-off')).toBe(false);
        await result.unmount();
    });
});
