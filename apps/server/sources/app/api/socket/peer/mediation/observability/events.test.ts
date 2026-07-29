import { describe, expect, it } from "vitest";
import {
    PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
} from "@happier-dev/protocol";

type EventsModule = typeof import("./events");
type StoreModule = typeof import("./store");
type RoutesModule = typeof import("./routes");

function enabledObservabilityPayload() {
    return {
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled: true },
                },
            },
        },
        capabilities: {
            machines: {
                peerMediation: {
                    observability: { available: true },
                },
            },
        },
    };
}

function enabledObservabilityPayloadWithoutCapability() {
    return {
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled: true },
                },
            },
        },
        capabilities: {
            machines: {
                peerMediation: {
                    observability: { available: false },
                },
            },
        },
    };
}

function createSocketHarness() {
    const handlers = new Map<string, (payload?: unknown, callback?: (response: unknown) => void) => unknown>();
    const emitted: Array<Readonly<{ event: string; payload: unknown }>> = [];
    return {
        socket: {
            on: (event: string, handler: (payload?: unknown, callback?: (response: unknown) => void) => unknown) => {
                handlers.set(event, handler);
            },
            emit: (event: string, payload: unknown) => {
                emitted.push({ event, payload });
            },
        },
        emitted,
        call(event: string, payload?: unknown) {
            const handler = handlers.get(event);
            expect(handler).toBeTypeOf("function");
            let response: unknown;
            handler?.(payload, (value) => {
                response = value;
            });
            return response;
        },
    };
}

async function loadEventsModule(): Promise<EventsModule | null> {
    return import("./events.js").catch(() => null) as Promise<EventsModule | null>;
}

async function loadStoreModule(): Promise<StoreModule | null> {
    return import("./store.js").catch(() => null) as Promise<StoreModule | null>;
}

async function loadRoutesModule(): Promise<RoutesModule | null> {
    return import("./routes.js").catch(() => null) as Promise<RoutesModule | null>;
}

describe("server peer mediation observability", () => {
    it("redacts preview tokens, credentials, and header secrets from HTTP request events", async () => {
        const mod = await loadEventsModule();
        expect(mod?.createPeerMediationHttpRequestStartedEvent).toBeTypeOf("function");
        if (!mod?.createPeerMediationHttpRequestStartedEvent) return;

        const event = mod.createPeerMediationHttpRequestStartedEvent({
            accountId: "account_1",
            machineId: "machine_1",
            previewId: "preview_1",
            tunnelId: "tunnel_1",
            substreamId: "substream_1",
            requestId: "request_1",
            method: "GET",
            url: "https://preview.example.test/app?previewToken=raw-preview-token&api_key=secret&tab=network",
            headers: {
                authorization: "Bearer raw-session-token",
                cookie: "happier_preview_token=raw-preview-token; sid=app-cookie",
                "set-cookie": "sid=raw-response-cookie",
                "content-type": "text/html",
                "x-request-id": "request-header-1",
            },
            nowMs: 1000,
        });

        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain("raw-preview-token");
        expect(serialized).not.toContain("raw-session-token");
        expect(serialized).not.toContain("app-cookie");
        expect(serialized).not.toContain("raw-response-cookie");
        expect(serialized).not.toContain("secret");
        expect(event.v).toBe(1);
        expect(event.kind).toBe("http.request.started");
        expect(event.scope).toEqual({ kind: "machine", accountId: "account_1", machineId: "machine_1" });
        expect(event.flow).toMatchObject({
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            routeKind: "server_relay",
            tunnelId: "tunnel_1",
            substreamId: "substream_1",
            productRef: { kind: "preview", id: "preview_1", redacted: false },
        });
        expect(event.data.requestId).toBe("request_1");
        expect(event.data.path).toBe("/app");
        expect(event.data.queryKeys).toEqual(["tab"]);
        expect(event.data.headers).toEqual({
            "content-type": "text/html",
            "x-request-id": "request-header-1",
        });
    });

    it("keeps per-scope snapshots bounded with monotonic sequences", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createPeerMediationFlowEvent || !storeMod?.createPeerMediationObservabilityStore) return;

        const store = storeMod.createPeerMediationObservabilityStore({
            maxEventsPerScope: 2,
            nowMs: () => 1002,
        });
        for (const flowId of ["flow_1", "flow_2", "flow_3"]) {
            store.publish(events.createPeerMediationFlowEvent({
                accountId: "account_1",
                machineId: "machine_1",
                flowKind: "tcp_tunnel",
                flowId,
                kind: "flow.started",
                nowMs: 1000,
            }));
        }

        const delta = store.delta({
            kind: "machine",
            accountId: "account_1",
            machineId: "machine_1",
        });
        const snapshot = store.snapshot({
            kind: "machine",
            accountId: "account_1",
            machineId: "machine_1",
        });
        expect(delta.sequence).toBe(3);
        expect(delta.events.map((event) => event.flow.flowId)).toEqual(["flow_2", "flow_3"]);
        expect(delta.events.map((event) => event.sequence)).toEqual([2, 3]);
        expect(snapshot.flows.map((flow) => flow.flow.flowId)).toEqual(["flow_2", "flow_3"]);
    });

    it("records WebSocket aborted and errored events as terminal snapshot lifecycle states", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createPeerMediationWebSocketEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createPeerMediationWebSocketEvent || !storeMod?.createPeerMediationObservabilityStore) return;

        const store = storeMod.createPeerMediationObservabilityStore({ nowMs: () => 3_000 });
        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };

        store.publish(events.createPeerMediationWebSocketEvent({
            kind: "websocket.opened",
            accountId: "account_1",
            machineId: "machine_1",
            previewId: "preview_1",
            tunnelId: "tunnel_aborted",
            substreamId: "substream_1",
            socketId: "socket_1",
            url: "/socket",
            headers: {},
            nowMs: 1_000,
        }));
        store.publish(events.createPeerMediationWebSocketEvent({
            kind: "websocket.aborted",
            accountId: "account_1",
            machineId: "machine_1",
            previewId: "preview_1",
            tunnelId: "tunnel_aborted",
            substreamId: "substream_1",
            socketId: "socket_1",
            url: "/socket",
            headers: {},
            reasonCode: "upstream_response_invalid",
            durationMs: 25,
            nowMs: 1_025,
        }));
        store.publish(events.createPeerMediationWebSocketEvent({
            kind: "websocket.errored",
            accountId: "account_1",
            machineId: "machine_1",
            previewId: "preview_1",
            tunnelId: "tunnel_errored",
            substreamId: "substream_2",
            socketId: "socket_2",
            url: "/socket",
            headers: {},
            reasonCode: "preview_websocket_adapter_error",
            durationMs: 31,
            nowMs: 1_031,
        }));

        const flows = store.snapshot(scope).flows;
        expect(flows.find((flow) => flow.flow.flowId === "tunnel_aborted")).toMatchObject({
            lifecycleState: "aborted",
            closedAtMs: 1_025,
            abortReasonCode: "upstream_response_invalid",
            websocket: expect.objectContaining({
                socketId: "socket_1",
                reasonCode: "upstream_response_invalid",
            }),
        });
        expect(flows.find((flow) => flow.flow.flowId === "tunnel_errored")).toMatchObject({
            lifecycleState: "errored",
            closedAtMs: 1_031,
            errorReasonCode: "preview_websocket_adapter_error",
            websocket: expect.objectContaining({
                socketId: "socket_2",
                reasonCode: "preview_websocket_adapter_error",
            }),
        });
    });

    it("prunes observability events outside the retention window", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createPeerMediationFlowEvent || !storeMod?.createPeerMediationObservabilityStore) return;

        let nowMs = 0;
        const store = storeMod.createPeerMediationObservabilityStore({ nowMs: () => nowMs });
        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };

        store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "flow_stale",
            kind: "flow.started",
            nowMs,
        }));

        nowMs = 900_001;
        store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "flow_fresh",
            kind: "flow.started",
            nowMs,
        }));

        expect(store.delta(scope).events.map((event) => event.flow.flowId)).toEqual(["flow_fresh"]);
        expect(store.snapshot(scope).flows.map((flow) => flow.flow.flowId)).toEqual(["flow_fresh"]);
    });

    it("enforces per-flow and aggregate event retention caps independently", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createPeerMediationFlowEvent || !storeMod?.createPeerMediationObservabilityStore) return;

        const retentionOptions = {
            maxEventsPerScope: 2,
            maxEventsPerMachineAggregate: 3,
            nowMs: () => 1005,
        };
        const store = storeMod.createPeerMediationObservabilityStore(retentionOptions);
        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };

        for (const [flowId, timestamp] of [
            ["flow_a", 1000],
            ["flow_a", 1001],
            ["flow_a", 1002],
            ["flow_b", 1003],
            ["flow_b", 1004],
            ["flow_c", 1005],
        ] as const) {
            store.publish(events.createPeerMediationFlowEvent({
                accountId: "account_1",
                machineId: "machine_1",
                flowKind: "tcp_tunnel",
                flowId,
                kind: "flow.started",
                nowMs: timestamp,
            }));
        }

        expect(store.delta(scope).events.map((event) => event.flow.flowId)).toEqual([
            "flow_b",
            "flow_b",
            "flow_c",
        ]);
    });

    it("replaces oversized observability event payloads with truncation metadata", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createPeerMediationFlowEvent || !storeMod?.createPeerMediationObservabilityStore) return;

        const retentionOptions = {
            eventPayloadMaxBytes: 1024,
            nowMs: () => 1000,
        };
        const store = storeMod.createPeerMediationObservabilityStore(retentionOptions);
        const oversizedMetadata = Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [`safeField${index}`, "x".repeat(512)]),
        );

        const published = store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "flow_large",
            kind: "flow.started",
            nowMs: 1000,
            metadata: oversizedMetadata,
        }));

        const stored = store.delta({
            kind: "machine",
            accountId: "account_1",
            machineId: "machine_1",
        }).events[0];
        expect(published.redaction.truncated).toBe(true);
        expect(stored?.redaction.truncated).toBe(true);
        expect(stored?.data).toEqual({
            payloadTruncated: true,
            originalPayloadBytes: expect.any(Number),
            payloadMaxBytes: 1024,
        });
        expect(JSON.stringify(stored)).not.toContain("xxxxxxxxxxxxxxxx");
        expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThanOrEqual(1024);
    });

    it("emits one snapshot immediately then forwards scoped deltas", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        const routes = await loadRoutesModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        expect(routes?.registerPeerMediationObservabilitySocketRoutes).toBeTypeOf("function");
        if (
            !events?.createPeerMediationFlowEvent
            || !storeMod?.createPeerMediationObservabilityStore
            || !routes?.registerPeerMediationObservabilitySocketRoutes
        ) return;

        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };
        const store = storeMod.createPeerMediationObservabilityStore({ nowMs: () => 3_000 });
        store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.started",
            nowMs: 1_000,
        }));
        const harness = createSocketHarness();
        routes.registerPeerMediationObservabilitySocketRoutes(harness.socket, {
            store,
            featurePayload: enabledObservabilityPayload(),
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
        });

        const ack = harness.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope });
        expect(ack).toEqual({ ok: true, sequence: 1 });
        expect(harness.emitted.filter((entry) => entry.event === PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT)).toHaveLength(1);
        expect(harness.emitted[0]?.payload).toMatchObject({
            v: 1,
            scope,
            sequence: 1,
            flows: [{ flow: { flowId: "tunnel_1" } }],
        });

        store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.ready",
            nowMs: 1_001,
        }));

        const deltas = harness.emitted.filter((entry) => entry.event === PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT);
        expect(deltas).toHaveLength(1);
        expect(deltas[0]?.payload).toMatchObject({
            v: 1,
            scope,
            sequence: 2,
            events: [{ kind: "flow.ready", flow: { flowId: "tunnel_1" } }],
        });
    });

    it("stops forwarding after unsubscribe", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        const routes = await loadRoutesModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        expect(routes?.registerPeerMediationObservabilitySocketRoutes).toBeTypeOf("function");
        if (
            !events?.createPeerMediationFlowEvent
            || !storeMod?.createPeerMediationObservabilityStore
            || !routes?.registerPeerMediationObservabilitySocketRoutes
        ) return;

        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };
        const store = storeMod.createPeerMediationObservabilityStore({ nowMs: () => 1000 });
        const harness = createSocketHarness();
        routes.registerPeerMediationObservabilitySocketRoutes(harness.socket, {
            store,
            featurePayload: enabledObservabilityPayload(),
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
        });
        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope })).toEqual({ ok: true, sequence: 0 });
        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT, { scope })).toEqual({ ok: true });

        store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.started",
            nowMs: 1_000,
        }));

        expect(harness.emitted.filter((entry) => entry.event === PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT)).toHaveLength(0);
    });

    it("denies unauthorized scoped unsubscribe without closing the active subscription", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        const routes = await loadRoutesModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        expect(routes?.registerPeerMediationObservabilitySocketRoutes).toBeTypeOf("function");
        if (
            !events?.createPeerMediationFlowEvent
            || !storeMod?.createPeerMediationObservabilityStore
            || !routes?.registerPeerMediationObservabilitySocketRoutes
        ) return;

        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };
        const store = storeMod.createPeerMediationObservabilityStore({ nowMs: () => 1000 });
        const harness = createSocketHarness();
        routes.registerPeerMediationObservabilitySocketRoutes(harness.socket, {
            store,
            featurePayload: enabledObservabilityPayload(),
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
        });
        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope })).toEqual({ ok: true, sequence: 0 });

        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT, {
            scope: { kind: "machine", accountId: "account_2", machineId: "machine_1" },
        })).toEqual({ ok: false, reasonCode: "observability_scope_forbidden" });

        store.publish(events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.started",
            nowMs: 1_000,
        }));

        const deltas = harness.emitted.filter((entry) => entry.event === PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT);
        expect(deltas).toHaveLength(1);
        expect(deltas[0]?.payload).toMatchObject({
            scope,
            sequence: 1,
            events: [{ flow: { flowId: "tunnel_1" } }],
        });
    });

    it("recursively removes unsafe mixed-case telemetry metadata before protocol validation", async () => {
        const events = await loadEventsModule();
        expect(events?.createPeerMediationFlowEvent).toBeTypeOf("function");
        if (!events?.createPeerMediationFlowEvent) return;

        const event = events.createPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.denied",
            nowMs: 1000,
            metadata: {
                nested: {
                    Authorization: "Bearer raw-token",
                    "X-API-Key": "raw-api-key",
                    safeCounter: 3,
                },
            },
        });

        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain("raw-token");
        expect(serialized).not.toContain("raw-api-key");
        expect(event.data.nested).toEqual({ safeCounter: 3 });
    });


    it("fails closed for unrelated readers and scopes public-preview readers to their preview only", async () => {
        const routes = await loadRoutesModule();
        expect(routes?.authorizePeerMediationObservabilityRead).toBeTypeOf("function");
        expect(routes?.isPeerMediationObservabilityReadAvailable).toBeTypeOf("function");
        if (!routes?.authorizePeerMediationObservabilityRead) return;

        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
            scope: { kind: "machine", accountId: "account_1", machineId: "machine_1" },
        })).toEqual({ ok: true });
        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "accountOwner", accountId: "account_1" },
            scope: { kind: "machine", accountId: "account_1", machineId: "machine_1" },
        })).toEqual({ ok: true });
        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "sessionOwner", accountId: "account_1", sessionId: "session_1" },
            scope: { kind: "session", accountId: "account_1", sessionId: "session_1" },
        })).toEqual({ ok: true });
        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "pluginSurface", accountId: "account_1", pluginId: "plugin_1", surfaceId: "surface_1" },
            scope: { kind: "pluginSurface", accountId: "account_1", pluginId: "plugin_1", surfaceId: "surface_1" },
        })).toEqual({ ok: true });
        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
            scope: { kind: "machine", accountId: "account_2", machineId: "machine_1" },
        })).toEqual({ ok: false, reasonCode: "observability_scope_forbidden" });
        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "publicPreview", publicExposureId: "preview_1" },
            scope: { kind: "publicPreview", publicExposureId: "preview_1" },
        })).toEqual({ ok: true });
        expect(routes.authorizePeerMediationObservabilityRead({
            principal: { kind: "publicPreview", publicExposureId: "preview_1" },
            scope: { kind: "machine", accountId: "account_1", machineId: "machine_1" },
        })).toEqual({ ok: false, reasonCode: "observability_scope_forbidden" });
        if (!routes.isPeerMediationObservabilityReadAvailable) return;
        expect(routes.isPeerMediationObservabilityReadAvailable({})).toBe(false);
        expect(routes.isPeerMediationObservabilityReadAvailable({
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: false },
                    },
                },
            },
            capabilities: {
                machines: {
                    peerMediation: {
                        observability: { available: true },
                    },
                },
            },
        })).toBe(false);
        expect(routes.isPeerMediationObservabilityReadAvailable({
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: "true" },
                    },
                },
            },
            capabilities: {
                machines: {
                    peerMediation: {
                        observability: { available: true },
                    },
                },
            },
        })).toBe(false);
        expect(routes.isPeerMediationObservabilityReadAvailable({
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: true },
                    },
                },
            },
            capabilities: {
                machines: {
                    peerMediation: {
                        observability: { available: true },
                    },
                },
            },
        })).toBe(true);
        expect(routes.isPeerMediationObservabilityReadAvailable(enabledObservabilityPayloadWithoutCapability())).toBe(true);
    });

    it("subscribes from canonical feature bits even when observability capability metadata is unavailable", async () => {
        const storeMod = await loadStoreModule();
        const routes = await loadRoutesModule();
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        expect(routes?.registerPeerMediationObservabilitySocketRoutes).toBeTypeOf("function");
        if (!storeMod?.createPeerMediationObservabilityStore || !routes?.registerPeerMediationObservabilitySocketRoutes) return;

        const harness = createSocketHarness();
        const scope = { kind: "machine" as const, accountId: "account_1", machineId: "machine_1" };
        routes.registerPeerMediationObservabilitySocketRoutes(harness.socket, {
            store: storeMod.createPeerMediationObservabilityStore(),
            featurePayload: enabledObservabilityPayloadWithoutCapability(),
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
        });

        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope })).toEqual({
            ok: true,
            sequence: 0,
        });
        expect(harness.emitted).toHaveLength(1);
    });

    it("denies subscribe when scope is unauthorized", async () => {
        const storeMod = await loadStoreModule();
        const routes = await loadRoutesModule();
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        expect(routes?.registerPeerMediationObservabilitySocketRoutes).toBeTypeOf("function");
        if (!storeMod?.createPeerMediationObservabilityStore || !routes?.registerPeerMediationObservabilitySocketRoutes) return;

        const harness = createSocketHarness();
        routes.registerPeerMediationObservabilitySocketRoutes(harness.socket, {
            store: storeMod.createPeerMediationObservabilityStore(),
            featurePayload: enabledObservabilityPayload(),
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
        });

        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, {
            scope: { kind: "machine", accountId: "account_2", machineId: "machine_1" },
        })).toEqual({ ok: false, reasonCode: "observability_scope_forbidden" });
        expect(harness.emitted).toEqual([]);
    });

    it("denies subscribe when feature payload is unavailable", async () => {
        const storeMod = await loadStoreModule();
        const routes = await loadRoutesModule();
        expect(storeMod?.createPeerMediationObservabilityStore).toBeTypeOf("function");
        expect(routes?.registerPeerMediationObservabilitySocketRoutes).toBeTypeOf("function");
        if (!storeMod?.createPeerMediationObservabilityStore || !routes?.registerPeerMediationObservabilitySocketRoutes) return;

        const harness = createSocketHarness();
        routes.registerPeerMediationObservabilitySocketRoutes(harness.socket, {
            store: storeMod.createPeerMediationObservabilityStore(),
            featurePayload: {},
            principal: { kind: "machineOwner", accountId: "account_1", machineId: "machine_1" },
        });

        expect(harness.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, {
            scope: { kind: "machine", accountId: "account_1", machineId: "machine_1" },
        })).toEqual({ ok: false, reasonCode: "observability_unavailable" });
        expect(harness.emitted).toEqual([]);
    });
});
