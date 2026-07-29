import { describe, expect, it } from 'vitest';

import type {
    PeerMediationObservabilityFlowSnapshotV1,
    PeerMediationObservabilityScopeV1,
    PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

import {
    applyPeerMediationObservabilitySnapshot,
    createPeerMediationObservabilityUiStore,
} from '@/sync/domains/machines/peer/mediation/observability/store';
import type { BrowserPreviewProxyDiagnosticsProjection } from './types';

type PreviewProxyModule = Readonly<{
    selectBrowserPreviewProxyDiagnostics?: (
        state: ReturnType<typeof createPeerMediationObservabilityUiStore>,
        input: Readonly<{
            scope: PeerMediationObservabilityScopeV1;
            previewId: string;
        }>,
    ) => BrowserPreviewProxyDiagnosticsProjection;
}>;

async function loadPreviewProxyModule(): Promise<PreviewProxyModule | null> {
    const path = './previewProxy';
    return import(path).catch(() => null) as Promise<PreviewProxyModule | null>;
}

const scope: PeerMediationObservabilityScopeV1 = {
    kind: 'machine',
    accountId: 'account_1',
    machineId: 'machine_1',
};

function tunnelFlow(): PeerMediationObservabilityFlowSnapshotV1 {
    return {
        flow: {
            flowKind: 'tcp_tunnel',
            flowId: 'tunnel_1',
            tunnelId: 'tunnel_1',
            substreamId: 'substream_1',
            productRef: { kind: 'preview', id: 'preview_1', redacted: false },
        },
        lifecycleState: 'active',
        startedAtMs: 1_000,
        lastActivityAtMs: 1_500,
        bytesIn: 128,
        bytesOut: 256,
        framesIn: 0,
        framesOut: 0,
        messagesIn: 2,
        messagesOut: 3,
        activeSubstreams: 1,
        movingThroughputBps: 512,
        http: {
            method: 'GET',
            path: '/dashboard',
            statusCode: 200,
        },
    };
}

function webSocketFlow(): PeerMediationObservabilityFlowSnapshotV1 {
    return {
        flow: {
            flowKind: 'tcp_tunnel',
            flowId: 'websocket_1',
            tunnelId: 'tunnel_1',
            substreamId: 'substream_2',
            productRef: { kind: 'preview', id: 'preview_1', redacted: false },
        },
        lifecycleState: 'active',
        startedAtMs: 1_100,
        lastActivityAtMs: 1_600,
        bytesIn: 64,
        bytesOut: 96,
        framesIn: 0,
        framesOut: 0,
        messagesIn: 4,
        messagesOut: 5,
        activeSubstreams: 1,
        websocket: {
            subprotocol: 'vite-hmr',
        },
    };
}

function snapshot(flows: readonly PeerMediationObservabilityFlowSnapshotV1[]): PeerMediationObservabilitySnapshotV1 {
    return {
        v: 1,
        scope,
        sequence: 1,
        capturedAtMs: 2_000,
        flows: [...flows],
    };
}

describe('browser previewProxy diagnostics projection', () => {
    it('maps PMS preview observability into previewProxy browser diagnostics without creating a second store', async () => {
        const mod = await loadPreviewProxyModule();

        expect(mod?.selectBrowserPreviewProxyDiagnostics).toBeTypeOf('function');
        if (!mod?.selectBrowserPreviewProxyDiagnostics) return;

        const state = applyPeerMediationObservabilitySnapshot(
            createPeerMediationObservabilityUiStore(),
            {
                source: 'server',
                snapshot: snapshot([tunnelFlow()]),
            },
        );

        const projection = mod.selectBrowserPreviewProxyDiagnostics(state, {
            scope,
            previewId: 'preview_1',
        });

        expect(projection).toMatchObject({
            status: 'available',
            sourceKind: 'previewProxy',
            fidelity: 'previewProxy',
            trusted: true,
            attribution: 'traffic_for_preview_all_views',
            activeFlowCount: 1,
            flows: [
                {
                    flowId: 'tunnel_1',
                    family: 'network',
                    fidelity: 'previewProxy',
                    trusted: true,
                    method: 'GET',
                    path: '/dashboard',
                    statusCode: 200,
                    bytesIn: 128,
                    bytesOut: 256,
                },
            ],
        });
    });

    it('classifies WebSocket preview metadata as network diagnostics rather than tunnel-only telemetry', async () => {
        const mod = await loadPreviewProxyModule();

        expect(mod?.selectBrowserPreviewProxyDiagnostics).toBeTypeOf('function');
        if (!mod?.selectBrowserPreviewProxyDiagnostics) return;

        const state = applyPeerMediationObservabilitySnapshot(
            createPeerMediationObservabilityUiStore(),
            {
                source: 'server',
                snapshot: snapshot([webSocketFlow()]),
            },
        );

        const projection = mod.selectBrowserPreviewProxyDiagnostics(state, {
            scope,
            previewId: 'preview_1',
        });

        expect(projection.flows).toEqual([
            expect.objectContaining({
                flowId: 'websocket_1',
                family: 'network',
                websocketSubprotocol: 'vite-hmr',
            }),
        ]);
    });

    it('keeps unsupported browser diagnostic families explicit instead of faking CDP parity', async () => {
        const mod = await loadPreviewProxyModule();

        expect(mod?.selectBrowserPreviewProxyDiagnostics).toBeTypeOf('function');
        if (!mod?.selectBrowserPreviewProxyDiagnostics) return;

        const projection = mod.selectBrowserPreviewProxyDiagnostics(
            createPeerMediationObservabilityUiStore(),
            {
                scope,
                previewId: 'preview_1',
            },
        );

        expect(projection).toMatchObject({
            status: 'unavailable',
            sourceKind: 'previewProxy',
            fidelity: 'unavailable',
            activeFlowCount: 0,
        });
        expect(projection.families).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'console',
                status: 'unavailable',
                fidelity: 'unavailable',
                trusted: false,
                reasonCode: 'unsupported_fidelity',
            }),
            expect.objectContaining({
                family: 'elements',
                status: 'unavailable',
                fidelity: 'unavailable',
                trusted: false,
                reasonCode: 'unsupported_fidelity',
            }),
            expect.objectContaining({
                family: 'network',
                status: 'unavailable',
                fidelity: 'unavailable',
                trusted: true,
            }),
        ]));
    });
});
