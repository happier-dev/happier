import * as React from 'react';
import { Text, View } from 'react-native';
import { describe, expect, it } from 'vitest';

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
            expect(store.getPortalSnapshot()[0]).toMatchObject({ visible: false, geometry: null });
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
                    <RetainedPresentationSlotBinder slotId="destination-a" enabled><DestinationProbe /></RetainedPresentationSlotBinder>
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
    it('retires presentation demand inside a retained body while its binder is parked', async () => {
        function DemandProbe(): React.ReactElement {
            return React.createElement('RetainedDemandProbe', { testID: 'retained-demand', active: useLayoutPresentationActive() });
        }
        function Harness(props: Readonly<{ visible: boolean }>): React.ReactElement {
            return <BrowserPresentationRetentionProvider>
                {props.visible ? <RetainedPresentationSlotBinder slotId="demand-slot" enabled visible>
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
        expect(portalSlot().props.style).toMatchObject({ left: 10, top: 20, width: 320, height: 200 });
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
