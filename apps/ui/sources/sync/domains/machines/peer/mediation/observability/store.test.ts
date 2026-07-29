import { describe, expect, it } from 'vitest';
import {
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityEventV1,
    type PeerMediationObservabilityFlowSnapshotV1,
    type PeerMediationObservabilityScopeV1,
    type PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

type StoreModuleShape = Readonly<{
    createPeerMediationObservabilityUiStore: () => unknown;
    applyPeerMediationObservabilitySnapshot: (
        state: unknown,
        input: Readonly<{
            source: 'server' | 'daemon';
            snapshot: PeerMediationObservabilitySnapshotV1;
        }>,
    ) => unknown;
    applyPeerMediationObservabilityDelta: (
        state: unknown,
        input: Readonly<{
            source: 'server' | 'daemon';
            delta: PeerMediationObservabilityDeltaV1;
        }>,
    ) => unknown;
}>;

type SelectorsModuleShape = Readonly<{
    selectPeerMediationObservabilityScopeState: (
        state: unknown,
        scope: PeerMediationObservabilityScopeV1,
    ) => unknown;
    selectPeerMediationObservabilityActiveFlows: (
        state: unknown,
        scope: PeerMediationObservabilityScopeV1,
    ) => readonly unknown[];
    selectPeerMediationObservabilityFlowSummaries: (
        state: unknown,
        scope: PeerMediationObservabilityScopeV1,
    ) => readonly unknown[];
    selectPeerMediationObservabilityHttpMetadata: (
        state: unknown,
        input: Readonly<{
            scope: PeerMediationObservabilityScopeV1;
            flowId: string;
        }>,
    ) => Record<string, unknown> | null;
    selectPeerMediationObservabilityWebSocketMetadata: (
        state: unknown,
        input: Readonly<{
            scope: PeerMediationObservabilityScopeV1;
            flowId: string;
        }>,
    ) => Record<string, unknown> | null;
    selectPeerMediationPreviewProxyDiagnostics: (
        state: unknown,
        input: Readonly<{
            scope: PeerMediationObservabilityScopeV1;
            previewId: string;
        }>,
    ) => unknown;
}>;

async function loadStoreModule(): Promise<Partial<StoreModuleShape>> {
    const modulePath = './store';
    return import(modulePath).catch(() => ({})) as Promise<Partial<StoreModuleShape>>;
}

async function loadSelectorsModule(): Promise<Partial<SelectorsModuleShape>> {
    const modulePath = './selectors';
    return import(modulePath).catch(() => ({})) as Promise<Partial<SelectorsModuleShape>>;
}

const machineScope: PeerMediationObservabilityScopeV1 = {
    kind: 'machine',
    accountId: 'acct_1',
    machineId: 'machine_1',
};

function tunnelFlow(overrides: Partial<PeerMediationObservabilityFlowSnapshotV1> = {}): PeerMediationObservabilityFlowSnapshotV1 {
    const base: PeerMediationObservabilityFlowSnapshotV1 = {
        flow: {
            flowId: 'flow_1',
            flowKind: 'tcp_tunnel',
            routeKind: 'server_relay',
            tunnelId: 'tun_1',
            productRef: { kind: 'preview', id: 'preview_1', redacted: false },
        },
        lifecycleState: 'active',
        startedAtMs: 1_000,
        lastActivityAtMs: 1_250,
        bytesIn: 10,
        bytesOut: 20,
        framesIn: 0,
        framesOut: 0,
        messagesIn: 0,
        messagesOut: 0,
        activeSubstreams: 1,
        http: {
            method: 'GET',
            path: '/assets/app.js',
            statusCode: 200,
        },
    };
    return {
        ...base,
        ...overrides,
        bytesIn: overrides.bytesIn ?? base.bytesIn,
        bytesOut: overrides.bytesOut ?? base.bytesOut,
        framesIn: overrides.framesIn ?? base.framesIn,
        framesOut: overrides.framesOut ?? base.framesOut,
        messagesIn: overrides.messagesIn ?? base.messagesIn,
        messagesOut: overrides.messagesOut ?? base.messagesOut,
        activeSubstreams: overrides.activeSubstreams ?? base.activeSubstreams,
    };
}

function snapshot(sequence: number, flows: readonly PeerMediationObservabilityFlowSnapshotV1[]): PeerMediationObservabilitySnapshotV1 {
    return {
        v: 1,
        scope: machineScope,
        sequence,
        capturedAtMs: 2_000 + sequence,
        flows: [...flows],
    };
}

function event(
    sequence: number,
    overrides: Partial<PeerMediationObservabilityEventV1> = {},
): PeerMediationObservabilityEventV1 {
    return {
        v: 1,
        eventId: `event_${sequence}`,
        sequence,
        emittedAtMs: 3_000 + sequence,
        scope: machineScope,
        flow: {
            flowId: 'flow_1',
            flowKind: 'tcp_tunnel',
            routeKind: 'server_relay',
            tunnelId: 'tun_1',
            productRef: { kind: 'preview', id: 'preview_1', redacted: false },
        },
        kind: 'tunnel.bytes',
        data: {
            bytesIn: 30,
            bytesOut: 40,
            activeSubstreams: 2,
        },
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
        ...overrides,
    };
}

function delta(sequence: number, events: readonly PeerMediationObservabilityEventV1[]): PeerMediationObservabilityDeltaV1 {
    return {
        v: 1,
        scope: machineScope,
        sequence,
        events: [...events],
    };
}

describe('peer mediation observability UI store', () => {
    it('applying a snapshot initializes state and sequence for a scope', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityScopeState).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !selectors.selectPeerMediationObservabilityScopeState) return;

        const next = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            { source: 'server', snapshot: snapshot(4, [tunnelFlow()]) },
        );

        expect(selectors.selectPeerMediationObservabilityScopeState(next, machineScope)).toMatchObject({
            status: 'ready',
            lastAppliedSequenceBySource: {
                server: 4,
            },
            stale: false,
        });
    });

    it('applying an ordered delta updates flows while preserving previous flows', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilityDelta).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityFlowSummaries).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !mod.applyPeerMediationObservabilityDelta || !selectors.selectPeerMediationObservabilityFlowSummaries) return;

        const initial = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            { source: 'server', snapshot: snapshot(1, [tunnelFlow(), tunnelFlow({
                flow: {
                    flowId: 'flow_2',
                    flowKind: 'tcp_tunnel',
                    routeKind: 'server_relay',
                    tunnelId: 'tun_2',
                },
            })]) },
        );
        const next = mod.applyPeerMediationObservabilityDelta(initial, {
            source: 'server',
            delta: delta(2, [event(2)]),
        });

        expect(selectors.selectPeerMediationObservabilityFlowSummaries(next, machineScope)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ flowId: 'flow_1', bytesIn: 30, bytesOut: 40, activeSubstreams: 2 }),
                expect.objectContaining({ flowId: 'flow_2', bytesIn: 10, bytesOut: 20 }),
            ]),
        );
    });

    it('marks a scope stale on sequence gap without applying the bad delta', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilityDelta).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityScopeState).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityFlowSummaries).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !mod.applyPeerMediationObservabilityDelta || !selectors.selectPeerMediationObservabilityScopeState || !selectors.selectPeerMediationObservabilityFlowSummaries) return;

        const initial = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            { source: 'server', snapshot: snapshot(1, [tunnelFlow()]) },
        );
        const next = mod.applyPeerMediationObservabilityDelta(initial, {
            source: 'server',
            delta: delta(3, [event(3, { data: { bytesIn: 999, bytesOut: 999 } })]),
        });

        expect(selectors.selectPeerMediationObservabilityScopeState(next, machineScope)).toMatchObject({
            status: 'stale',
            stale: true,
            resubscribeRequired: true,
            lastAppliedSequenceBySource: {
                server: 1,
            },
        });
        expect(selectors.selectPeerMediationObservabilityFlowSummaries(next, machineScope)).toEqual([
            expect.objectContaining({ flowId: 'flow_1', bytesIn: 10, bytesOut: 20 }),
        ]);
    });

    it('marks a scope stale without applying delta events for a different scope', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilityDelta).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityScopeState).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityFlowSummaries).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !mod.applyPeerMediationObservabilityDelta || !selectors.selectPeerMediationObservabilityScopeState || !selectors.selectPeerMediationObservabilityFlowSummaries) return;

        const initial = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            { source: 'server', snapshot: snapshot(1, []) },
        );
        const next = mod.applyPeerMediationObservabilityDelta(initial, {
            source: 'server',
            delta: delta(2, [event(2, {
                scope: {
                    kind: 'machine',
                    accountId: 'acct_1',
                    machineId: 'machine_other',
                },
            })]),
        });

        expect(selectors.selectPeerMediationObservabilityScopeState(next, machineScope)).toMatchObject({
            status: 'stale',
            stale: true,
            resubscribeRequired: true,
            lastAppliedSequenceBySource: {
                server: 1,
            },
        });
        expect(selectors.selectPeerMediationObservabilityFlowSummaries(next, machineScope)).toEqual([]);
    });

    it('ignores stale snapshots from the same source without regressing newer data', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityScopeState).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityFlowSummaries).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !selectors.selectPeerMediationObservabilityScopeState || !selectors.selectPeerMediationObservabilityFlowSummaries) return;

        const current = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            { source: 'server', snapshot: snapshot(5, [tunnelFlow({ bytesIn: 500, bytesOut: 600 })]) },
        );
        const next = mod.applyPeerMediationObservabilitySnapshot(current, {
            source: 'server',
            snapshot: snapshot(4, [tunnelFlow({ bytesIn: 1, bytesOut: 2 })]),
        });

        expect(selectors.selectPeerMediationObservabilityScopeState(next, machineScope)).toMatchObject({
            status: 'ready',
            lastAppliedSequenceBySource: {
                server: 5,
            },
        });
        expect(selectors.selectPeerMediationObservabilityFlowSummaries(next, machineScope)).toEqual([
            expect.objectContaining({ flowId: 'flow_1', bytesIn: 500, bytesOut: 600 }),
        ]);
    });

    it('keeps a scope stale when an ordered delta from another source arrives after a gap', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilityDelta).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityScopeState).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !mod.applyPeerMediationObservabilityDelta || !selectors.selectPeerMediationObservabilityScopeState) return;

        const serverSnapshot = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            { source: 'server', snapshot: snapshot(1, [tunnelFlow()]) },
        );
        const bothSources = mod.applyPeerMediationObservabilitySnapshot(serverSnapshot, {
            source: 'daemon',
            snapshot: snapshot(1, [tunnelFlow({ bytesIn: 100, bytesOut: 200 })]),
        });
        const daemonGap = mod.applyPeerMediationObservabilityDelta(bothSources, {
            source: 'daemon',
            delta: delta(3, [event(3, { data: { bytesIn: 999, bytesOut: 999 } })]),
        });
        const next = mod.applyPeerMediationObservabilityDelta(daemonGap, {
            source: 'server',
            delta: delta(2, [event(2, { data: { bytesIn: 30, bytesOut: 40 } })]),
        });

        expect(selectors.selectPeerMediationObservabilityScopeState(next, machineScope)).toMatchObject({
            status: 'stale',
            stale: true,
            resubscribeRequired: true,
            staleSourceBySource: {
                server: false,
                daemon: true,
            },
        });
    });

    it('merges server and daemon facts by flow id without overwriting source families', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityFlowSummaries).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !selectors.selectPeerMediationObservabilityFlowSummaries) return;

        const serverState = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            {
                source: 'server',
                snapshot: snapshot(1, [tunnelFlow({
                    http: { method: 'POST', path: '/api/save', statusCode: 201 },
                    bytesIn: 100,
                    bytesOut: 200,
                })]),
            },
        );
        const merged = mod.applyPeerMediationObservabilitySnapshot(serverState, {
            source: 'daemon',
            snapshot: snapshot(1, [tunnelFlow({
                http: { method: 'GET', path: '/daemon-local', statusCode: 200 },
                bytesIn: 1_000,
                bytesOut: 2_000,
                movingThroughputBps: 900,
            })]),
        });

        expect(selectors.selectPeerMediationObservabilityFlowSummaries(merged, machineScope)).toEqual([
            expect.objectContaining({
                flowId: 'flow_1',
                bytesIn: 1_000,
                bytesOut: 2_000,
                movingThroughputBps: 900,
                http: { method: 'POST', path: '/api/save', statusCode: 201 },
                sourceFamilies: {
                    server: expect.objectContaining({ sequence: 1 }),
                    daemon: expect.objectContaining({ sequence: 1 }),
                },
            }),
        ]);
    });

    it('selectors expose redacted HTTP and WebSocket metadata without raw body/header/token fields', async () => {
        const mod = await loadStoreModule();
        const selectors = await loadSelectorsModule();

        expect(mod.createPeerMediationObservabilityUiStore).toBeTypeOf('function');
        expect(mod.applyPeerMediationObservabilitySnapshot).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityHttpMetadata).toBeTypeOf('function');
        expect(selectors.selectPeerMediationObservabilityWebSocketMetadata).toBeTypeOf('function');
        expect(selectors.selectPeerMediationPreviewProxyDiagnostics).toBeTypeOf('function');
        if (!mod.createPeerMediationObservabilityUiStore || !mod.applyPeerMediationObservabilitySnapshot || !selectors.selectPeerMediationObservabilityHttpMetadata || !selectors.selectPeerMediationObservabilityWebSocketMetadata || !selectors.selectPeerMediationPreviewProxyDiagnostics) return;

        const next = mod.applyPeerMediationObservabilitySnapshot(
            mod.createPeerMediationObservabilityUiStore(),
            {
                source: 'server',
                snapshot: snapshot(1, [tunnelFlow({
                    http: {
                        method: 'GET',
                        path: '/safe',
                        statusCode: 200,
                        body: 'must-not-surface',
                        authorization: 'must-not-surface',
                        previewToken: 'must-not-surface',
                        headers: { cookie: 'must-not-surface' },
                    },
                    websocket: {
                        subprotocol: 'vite-hmr',
                        messagesIn: 2,
                        payload: 'must-not-surface',
                        token: 'must-not-surface',
                    },
                })]),
            },
        );

        expect(selectors.selectPeerMediationObservabilityHttpMetadata(next, {
            scope: machineScope,
            flowId: 'flow_1',
        })).toEqual({
            method: 'GET',
            path: '/safe',
            statusCode: 200,
        });
        expect(selectors.selectPeerMediationObservabilityWebSocketMetadata(next, {
            scope: machineScope,
            flowId: 'flow_1',
        })).toEqual({
            subprotocol: 'vite-hmr',
            messagesIn: 2,
        });
        expect(selectors.selectPeerMediationPreviewProxyDiagnostics(next, {
            scope: machineScope,
            previewId: 'preview_1',
        })).toMatchObject({
            status: 'available',
            attribution: 'traffic_for_preview_all_views',
            activeFlowCount: 1,
        });
    });
});
