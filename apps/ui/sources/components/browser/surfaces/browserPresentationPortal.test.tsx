import * as React from 'react';
import { Text, View } from 'react-native';
import { describe, expect, it } from 'vitest';

import type { ReactTestRenderer } from 'react-test-renderer';

import { renderWithAppProviders } from '@/dev/testkit';

import {
    BrowserKeepAliveBinder,
    BrowserPresentationRetentionProvider,
    createBrowserPresentationRetentionStore,
    useBrowserPresentationPortalSlot,
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
    const { portalActive } = useBrowserPresentationPortalSlot({
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

    it('BrowserKeepAliveBinder hosts children in the portal when enabled, renders a placeholder', async () => {
        webviewMountCount = 0;
        const result = await renderWithAppProviders(
            <BrowserPresentationRetentionProvider>
                <BrowserKeepAliveBinder slotId="slot-binder" enabled visible>
                    <MountCountingWebview label="hosted" />
                </BrowserKeepAliveBinder>
            </BrowserPresentationRetentionProvider>,
        );
        // The webview is hosted by the portal (mounted once), the panel shows only the placeholder.
        expect(webviewMountCount).toBe(1);
        expect(hasTestId(result.tree, 'browser-keepalive-placeholder-slot-binder')).toBe(true);
        expect(hasTestId(result.tree, 'browser-presentation-portal-slot-slot-binder')).toBe(true);
        await result.unmount();
    });

    it('BrowserKeepAliveBinder renders children inline when disabled', async () => {
        webviewMountCount = 0;
        const result = await renderWithAppProviders(
            <BrowserPresentationRetentionProvider>
                <BrowserKeepAliveBinder slotId="slot-off" enabled={false}>
                    <MountCountingWebview label="inline" />
                </BrowserKeepAliveBinder>
            </BrowserPresentationRetentionProvider>,
        );
        expect(webviewMountCount).toBe(1);
        expect(hasTestId(result.tree, 'browser-keepalive-placeholder-slot-off')).toBe(false);
        expect(hasTestId(result.tree, 'browser-presentation-portal-slot-slot-off')).toBe(false);
        await result.unmount();
    });
});
