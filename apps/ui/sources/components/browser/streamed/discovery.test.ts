import type { BrowserDaemonViewV1 } from '@happier-dev/protocol/browser/control/v1';
import { describe, expect, it } from 'vitest';
import { BrowserEventV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { createBrowserSidecarCdpControlAdapter } from '../../../../../cli/src/daemon/browser/sidecar/controlAdapter';

import { reconcileBrowserDiscovery } from './discovery';

describe('Browser discovery admission', () => {
    it('preserves authoritative opening facts and delivers a changed capability once without replaying navigation', () => {
        const opened = BrowserEventV1Schema.parse({ kind: 'viewOpened', eventId: 'opened', occurredAt: 1,
            browserSessionId: 'browser', viewId: 'view', platform: 'web', adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
            target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test/' },
            adapterCapabilities: { adapterKind: 'chromiumSidecar', navigation: { canGoBack: true },
                diagnosticsFidelityByFamily: { console: 'cdp' }, supportsPopups: true } });
        if (opened.kind !== 'viewOpened') throw new Error('Expected opening fixture');
        const navigation = BrowserEventV1Schema.parse({ kind: 'navigationStateChanged', eventId: 'nav', occurredAt: 2,
            browserSessionId: 'browser', viewId: 'view', loadingState: 'ready', canGoBack: true, canGoForward: false });
        const view = { browserSessionId: 'browser', viewId: 'view', sourceId: 'source', target: opened.target,
            platform: 'web', adapterKind: 'chromiumSidecar', events: [opened, navigation],
            captureSource: { v: 1, sourceId: 'source', sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                inputMode: 'shared', sidebands: [], health: { status: 'available' } } } satisfies BrowserDaemonViewV1;
        const initial = reconcileBrowserDiscovery(undefined, [view]);
        expect(initial.events[0]).toEqual({ ...opened, target: { kind: 'streamedBrowser', targetId: 'source', streamId: 'source',
            daemonView: { browserSessionId: 'browser', viewId: 'view' } } });
        const equal = reconcileBrowserDiscovery(initial.views, [structuredClone(view)]);
        expect(equal.views).toBe(initial.views);
        expect(equal.events).toHaveLength(0);
        const changed = { ...view, events: [{ ...opened,
            adapterCapabilities: { ...opened.adapterCapabilities, supportsPopups: false } }, navigation] };
        const update = reconcileBrowserDiscovery(equal.views, [changed]);
        expect(update.events).toMatchObject([{ kind: 'viewOpened', adapterCapabilities: { supportsPopups: false } }]);
        expect(reconcileBrowserDiscovery(update.views, [structuredClone(changed)]).events).toHaveLength(0);
        const navigated = { ...changed, events: [{ ...changed.events[0]!, eventId: 'opened:new', occurredAt: 4 },
            { ...navigation, eventId: 'nav:new', occurredAt: 4, title: 'New title' }] };
        expect(reconcileBrowserDiscovery(update.views, [navigated]).events).toMatchObject([
            { kind: 'navigationStateChanged', title: 'New title' },
        ]);
    });

    it('delivers changed navigation when an adapter restarts its event sequence for a retained view', async () => {
        const readReopenedView = async (url: string) => {
            const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar',
                transport: { openPage: async () => ({ targetId: 'target' }),
                    dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}) } });
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId: 'browser', viewId: 'view',
                target: { kind: 'externalUrl', targetId: 'target', url }, platform: 'web', focus: true });
            const view = adapter.listViews?.('browser')[0];
            if (!view) throw new Error('Expected an opened native view');
            adapter.dispose();
            return { ...view, captureSource: { v: 1, sourceId: view.sourceId, sourceKind: 'browser',
                supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } } satisfies BrowserDaemonViewV1;
        };
        const first = await readReopenedView('https://first.test/');
        const reopened = await readReopenedView('https://next.test/');
        expect(reopened.events[0]?.eventId).toBe(first.events[0]?.eventId);
        const initial = reconcileBrowserDiscovery(undefined, [first]);
        expect(reconcileBrowserDiscovery(initial.views, [reopened]).events)
            .toMatchObject([{ kind: 'navigationStateChanged', currentUrl: 'https://next.test/' }]);
    });

    it('adopts a retained view once its capture source becomes available and again after removal', () => {
        const view = { browserSessionId: 'browser', viewId: 'view', sourceId: 'source',
            target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test/' },
            platform: 'web', adapterKind: 'chromiumSidecar', events: [BrowserEventV1Schema.parse({
                kind: 'viewOpened', eventId: 'opened', occurredAt: 1, browserSessionId: 'browser', viewId: 'view',
                target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test/' },
                platform: 'web', adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
                adapterCapabilities: { adapterKind: 'chromiumSidecar' },
            })] } satisfies BrowserDaemonViewV1;
        const unavailable = reconcileBrowserDiscovery(undefined, [view]);
        expect(unavailable.events).toHaveLength(0);
        const available = { ...view, captureSource: { v: 1, sourceId: view.sourceId, sourceKind: 'browser',
            supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } } satisfies BrowserDaemonViewV1;
        const admitted = reconcileBrowserDiscovery(unavailable.views, [available]);
        expect(admitted.events).toMatchObject([{ kind: 'viewOpened', browserSessionId: view.browserSessionId, viewId: view.viewId }]);
        const equal = reconcileBrowserDiscovery(admitted.views, [structuredClone(available)]);
        expect(equal.events).toHaveLength(0);
        expect(equal.views).toBe(admitted.views);
        const removed = reconcileBrowserDiscovery(equal.views, []);
        expect(reconcileBrowserDiscovery(removed.views, [available]).events).toHaveLength(1);
    });
});
