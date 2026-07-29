import { describe, expect, it } from 'vitest';

import { BrowserAdapterCapabilitiesV1Schema, type BrowserAdapterCapabilitiesV1 } from '@happier-dev/protocol';

import { createBrowserDiagnosticsRoutes } from '../../diagnostics/routes';
import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';

function cdpSidecarCapabilities(overrides: Record<string, unknown> = {}): BrowserAdapterCapabilitiesV1 {
    return BrowserAdapterCapabilitiesV1Schema.parse({
        adapterKind: 'chromiumSidecar',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['streamedSurface'],
        diagnosticsFidelityByFamily: {
            network: 'cdp',
            console: 'cdp',
            pageError: 'cdp',
            pageInfo: 'cdp',
        },
        contextKinds: ['browserPageReference'],
        inputRouting: 'native',
        ...overrides,
    });
}

describe('daemon browser sidecar diagnostics event sources', () => {
    it('publishes sidecar CDP source events through the daemon diagnostics route with redacted CDP metadata', async () => {
        const mod = await import('./eventSource');

        expect(mod?.createBrowserSidecarDiagnosticsEventSourceBridge).toBeTypeOf('function');
        expect(mod?.createInMemorySidecarDiagnosticsEventSource).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarDiagnosticsEventSourceBridge || !mod.createInMemorySidecarDiagnosticsEventSource) {
            return;
        }

        const store = createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 9_000,
            maxEventsPerView: 2,
        });
        const routes = createBrowserDiagnosticsRoutes({ store });
        const source = mod.createInMemorySidecarDiagnosticsEventSource({ sourceId: 'fixture_source_1' });
        const bridge = mod.createBrowserSidecarDiagnosticsEventSourceBridge({
            ownerAccountId: 'account_owner',
            store,
            nowMs: () => 9_000,
        });

        expect(bridge.attachView({
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 3,
            adapterCapabilities: cdpSidecarCapabilities(),
            featureEnabled: true,
            policyAllowed: true,
            source,
            families: ['network', 'console'],
        })).toEqual({
            status: 'attached',
            sourceId: 'fixture_source_1',
        });
        expect(source.startCount()).toBe(1);
        expect(source.activeSubscriberCount()).toBe(1);

        source.emitCdpEvent({
            capturedAtMs: 1_000,
            event: {
                kind: 'network.requestWillBeSent',
                requestId: 'raw_cdp_request_secret',
                method: 'GET',
                url: 'https://example.test/api?ok=1&token=secret',
                headers: {
                    Authorization: 'Bearer secret',
                    Accept: 'application/json',
                },
            },
        });
        source.emitCdpEvent({
            capturedAtMs: 1_001,
            event: {
                kind: 'runtime.consoleEntry',
                level: 'error',
                text: 'token=secret should not leave the daemon',
                argCount: 1,
            },
        });

        const snapshot = await routes.getSnapshot();
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events.map((event) => [event.kind, event.fidelity, event.trusted])).toEqual([
            ['network.requestStarted', 'cdp', true],
            ['console.entry', 'cdp', true],
        ]);
        expect(snapshot.events[0]?.data).toMatchObject({
            method: 'GET',
            url: {
                origin: 'https://example.test',
                path: '/api',
                queryKeys: ['ok'],
            },
            headers: {
                accept: 'application/json',
            },
        });
        expect(JSON.stringify(snapshot)).not.toContain('raw_cdp_request_secret');
        expect(JSON.stringify(snapshot)).not.toContain('Bearer secret');
        expect(JSON.stringify(snapshot)).not.toContain('token=secret');
    });

    it('keeps source publication bounded by the daemon store', async () => {
        const mod = await import('./eventSource');

        expect(mod?.createBrowserSidecarDiagnosticsEventSourceBridge).toBeTypeOf('function');
        expect(mod?.createInMemorySidecarDiagnosticsEventSource).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarDiagnosticsEventSourceBridge || !mod.createInMemorySidecarDiagnosticsEventSource) {
            return;
        }

        const store = createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 9_000,
            maxEventsPerView: 2,
        });
        const source = mod.createInMemorySidecarDiagnosticsEventSource({ sourceId: 'fixture_source_2' });
        const bridge = mod.createBrowserSidecarDiagnosticsEventSourceBridge({
            ownerAccountId: 'account_owner',
            store,
            nowMs: () => 9_000,
        });
        bridge.attachView({
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            adapterCapabilities: cdpSidecarCapabilities(),
            featureEnabled: true,
            policyAllowed: true,
            source,
            families: ['network'],
        });

        for (const index of [1, 2, 3]) {
            source.emitCdpEvent({
                capturedAtMs: 1_000 + index,
                event: {
                    kind: 'network.requestWillBeSent',
                    requestId: `request_${index}`,
                    method: 'GET',
                    url: `https://example.test/${index}.js`,
                },
            });
        }

        expect(store.getSnapshot().events.map((event) => event.eventId)).toEqual([
            'sidecar_diag_view_1_1_2',
            'sidecar_diag_view_1_1_3',
        ]);
    });

    it('cleans up active source subscriptions and daemon snapshots on view and session close', async () => {
        const mod = await import('./eventSource');

        expect(mod?.createBrowserSidecarDiagnosticsEventSourceBridge).toBeTypeOf('function');
        expect(mod?.createInMemorySidecarDiagnosticsEventSource).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarDiagnosticsEventSourceBridge || !mod.createInMemorySidecarDiagnosticsEventSource) {
            return;
        }

        const store = createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 9_000,
        });
        const sourceOne = mod.createInMemorySidecarDiagnosticsEventSource({ sourceId: 'fixture_source_view_1' });
        const sourceTwo = mod.createInMemorySidecarDiagnosticsEventSource({ sourceId: 'fixture_source_view_2' });
        const bridge = mod.createBrowserSidecarDiagnosticsEventSourceBridge({
            ownerAccountId: 'account_owner',
            store,
            nowMs: () => 9_000,
        });
        const attach = (source: ReturnType<typeof mod.createInMemorySidecarDiagnosticsEventSource>, viewId: string) => bridge.attachView({
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId,
            navigationGeneration: 1,
            adapterCapabilities: cdpSidecarCapabilities(),
            featureEnabled: true,
            policyAllowed: true,
            source,
            families: ['pageInfo'],
        });
        attach(sourceOne, 'view_1');
        attach(sourceTwo, 'view_2');
        sourceOne.emitCdpEvent({ capturedAtMs: 1_000, event: { kind: 'page.info', title: 'View one' } });
        sourceTwo.emitCdpEvent({ capturedAtMs: 1_001, event: { kind: 'page.info', title: 'View two' } });

        bridge.closeView({ browserSessionId: 'browser_session_1', viewId: 'view_1' });

        expect(sourceOne.activeSubscriberCount()).toBe(0);
        expect(sourceTwo.activeSubscriberCount()).toBe(1);
        expect(store.getSnapshot().events.map((event) => event.viewId)).toEqual(['view_2']);

        sourceOne.emitCdpEvent({ capturedAtMs: 1_002, event: { kind: 'page.info', title: 'Detached view' } });
        expect(store.getSnapshot().events.map((event) => event.viewId)).toEqual(['view_2']);

        bridge.closeSession({ browserSessionId: 'browser_session_1' });

        expect(sourceTwo.activeSubscriberCount()).toBe(0);
        expect(store.getSnapshot().events).toEqual([]);
    });

    it('fails closed without starting sources when the adapter does not support CDP diagnostics', async () => {
        const mod = await import('./eventSource');

        expect(mod?.createBrowserSidecarDiagnosticsEventSourceBridge).toBeTypeOf('function');
        expect(mod?.createInMemorySidecarDiagnosticsEventSource).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarDiagnosticsEventSourceBridge || !mod.createInMemorySidecarDiagnosticsEventSource) {
            return;
        }

        const store = createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 9_000,
        });
        const source = mod.createInMemorySidecarDiagnosticsEventSource({ sourceId: 'fixture_source_unsupported' });
        const bridge = mod.createBrowserSidecarDiagnosticsEventSourceBridge({
            ownerAccountId: 'account_owner',
            store,
            nowMs: () => 9_000,
        });

        expect(bridge.attachView({
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            adapterCapabilities: cdpSidecarCapabilities({
                adapterKind: 'localPreview',
                diagnosticsFidelityByFamily: {
                    network: 'injectedPage',
                },
            }),
            featureEnabled: true,
            policyAllowed: true,
            source,
            families: ['network'],
        })).toEqual({
            status: 'unsupported',
            reason: 'unsupported_fidelity',
            sourceStarted: false,
        });

        expect(source.startCount()).toBe(0);
        expect(store.getSnapshot().events).toEqual([
            expect.objectContaining({
                viewId: 'view_1',
                family: 'network',
                kind: 'diagnostics.unavailable',
                fidelity: 'unavailable',
                unavailableReason: 'unsupported_fidelity',
            }),
        ]);
    });
});
