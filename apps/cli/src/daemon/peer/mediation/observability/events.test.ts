import { describe, expect, it } from "vitest";
import type { PeerMediationObservabilityEventV1 } from "@happier-dev/protocol";

type EventsModule = typeof import("./events");
type StoreModule = typeof import("./store");
type AccessModule = typeof import("./access");

async function loadEventsModule(): Promise<EventsModule> {
    return import("./events.js") as Promise<EventsModule>;
}

async function loadStoreModule(): Promise<StoreModule> {
    return import("./store.js") as Promise<StoreModule>;
}

async function loadAccessModule(): Promise<AccessModule> {
    return import("./access.js") as Promise<AccessModule>;
}

describe("daemon peer mediation observability", () => {
    it("redacts route authorization and loopback request secrets from daemon events", async () => {
        const mod = await loadEventsModule();
        expect(mod?.createDaemonPeerMediationFlowEvent).toBeTypeOf("function");
        if (!mod?.createDaemonPeerMediationFlowEvent) return;

        const event = mod.createDaemonPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.denied",
            reasonCode: "relay_authorization_invalid",
            routeGrantId: "grant-secret-raw-id",
            nowMs: 1000,
            metadata: {
                authorization: "Bearer raw-token",
                cookie: "happier_preview_token=raw-preview-token",
                url: "http://127.0.0.1:5173/?previewToken=raw-preview-token&ok=1",
                headers: {
                    "sec-websocket-protocol": "vite-hmr, bearer.raw-subprotocol-secret",
                    "x-request-id": "request-1",
                },
                nested: {
                    Authorization: "Bearer nested-token",
                    "X-API-Key": "nested-api-key",
                    safeCounter: 7,
                },
            },
        });

        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain("raw-token");
        expect(serialized).not.toContain("nested-token");
        expect(serialized).not.toContain("nested-api-key");
        expect(serialized).not.toContain("raw-preview-token");
        expect(serialized).not.toContain("raw-subprotocol-secret");
        expect(serialized).not.toContain("vite-hmr");
        expect(serialized).not.toContain("grant-secret-raw-id");
        expect(serialized).toContain("grant_");
        expect(event.v).toBe(1);
        expect(event.kind).toBe("flow.denied");
        expect(event.scope).toEqual({ kind: "machine", accountId: "account_1", machineId: "machine_1" });
        expect(event.flow).toMatchObject({
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            tunnelId: "tunnel_1",
            routeKind: "server_relay",
        });
        expect(event.data.url).toEqual({ path: "/", queryKeys: ["ok"] });
        expect(event.data.headers).toEqual({ "x-request-id": "request-1" });
        expect(event.data.nested).toEqual({ safeCounter: 7 });
    });

    it("evicts oldest daemon events per machine scope", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createDaemonPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createDaemonPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createDaemonPeerMediationFlowEvent || !storeMod?.createDaemonPeerMediationObservabilityStore) return;

        const store = storeMod.createDaemonPeerMediationObservabilityStore({
            maxEventsPerMachine: 1,
            nowMs: () => 1001,
        });
        store.publish(events.createDaemonPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_1",
            kind: "flow.started",
            nowMs: 1000,
        }));
        store.publish(events.createDaemonPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "tunnel_2",
            kind: "flow.started",
            nowMs: 1001,
        }));

        expect(store.delta("machine_1", "account_1").events.map((event) => event.flow.flowId)).toEqual(["tunnel_2"]);
        expect(store.snapshot("machine_1", "account_1").flows.map((flow) => flow.flow.flowId)).toEqual(["tunnel_2"]);
    });

    it("prunes daemon observability events outside the retention window", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createDaemonPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createDaemonPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createDaemonPeerMediationFlowEvent || !storeMod?.createDaemonPeerMediationObservabilityStore) return;

        let nowMs = 0;
        const store = storeMod.createDaemonPeerMediationObservabilityStore({ nowMs: () => nowMs });

        store.publish(events.createDaemonPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "flow_stale",
            kind: "flow.started",
            nowMs,
        }));

        nowMs = 900_001;
        store.publish(events.createDaemonPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "flow_fresh",
            kind: "flow.started",
            nowMs,
        }));

        expect(store.delta("machine_1", "account_1").events.map((event) => event.flow.flowId)).toEqual(["flow_fresh"]);
        expect(store.snapshot("machine_1", "account_1").flows.map((flow) => flow.flow.flowId)).toEqual(["flow_fresh"]);
    });

    it("records shared WebSocket terminal events as daemon terminal snapshot lifecycle states", async () => {
        const storeMod = await loadStoreModule();
        expect(storeMod?.createDaemonPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!storeMod?.createDaemonPeerMediationObservabilityStore) return;

        function websocketEvent(input: Readonly<{
            kind: "websocket.aborted" | "websocket.errored";
            flowId: string;
            socketId: string;
            reasonCode: string;
            emittedAtMs: number;
        }>): PeerMediationObservabilityEventV1 {
            return {
                v: 1,
                eventId: `obs_${input.flowId}_${input.kind.replace(".", "_")}`,
                sequence: 0,
                emittedAtMs: input.emittedAtMs,
                scope: { kind: "machine", accountId: "account_1", machineId: "machine_1" },
                flow: {
                    flowKind: "tcp_tunnel",
                    flowId: input.flowId,
                    routeKind: "server_relay",
                    tunnelId: input.flowId,
                },
                kind: input.kind,
                data: {
                    socketId: input.socketId,
                    reasonCode: input.reasonCode,
                },
                redaction: {
                    level: "metadataOnly",
                    queryRedacted: true,
                    headersRedacted: true,
                    truncated: false,
                },
            };
        }

        const store = storeMod.createDaemonPeerMediationObservabilityStore({ nowMs: () => 3_000 });
        store.publish(websocketEvent({
            kind: "websocket.aborted",
            flowId: "tunnel_aborted",
            socketId: "socket_1",
            reasonCode: "upstream_response_invalid",
            emittedAtMs: 1_025,
        }));
        store.publish(websocketEvent({
            kind: "websocket.errored",
            flowId: "tunnel_errored",
            socketId: "socket_2",
            reasonCode: "preview_websocket_adapter_error",
            emittedAtMs: 1_031,
        }));

        const flows = store.snapshot("machine_1", "account_1").flows;
        expect(flows.find((flow) => flow.flow.flowId === "tunnel_aborted")).toMatchObject({
            lifecycleState: "aborted",
            closedAtMs: 1_025,
            abortReasonCode: "upstream_response_invalid",
        });
        expect(flows.find((flow) => flow.flow.flowId === "tunnel_errored")).toMatchObject({
            lifecycleState: "errored",
            closedAtMs: 1_031,
            errorReasonCode: "preview_websocket_adapter_error",
        });
    });

    it("enforces daemon per-flow and aggregate event retention caps independently", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createDaemonPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createDaemonPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createDaemonPeerMediationFlowEvent || !storeMod?.createDaemonPeerMediationObservabilityStore) return;

        const retentionOptions = {
            maxEventsPerFlow: 2,
            maxEventsPerMachine: 3,
            nowMs: () => 1005,
        };
        const store = storeMod.createDaemonPeerMediationObservabilityStore(retentionOptions);

        for (const [flowId, timestamp] of [
            ["flow_a", 1000],
            ["flow_a", 1001],
            ["flow_a", 1002],
            ["flow_b", 1003],
            ["flow_b", 1004],
            ["flow_c", 1005],
        ] as const) {
            store.publish(events.createDaemonPeerMediationFlowEvent({
                accountId: "account_1",
                machineId: "machine_1",
                flowKind: "tcp_tunnel",
                flowId,
                kind: "flow.started",
                nowMs: timestamp,
            }));
        }

        expect(store.delta("machine_1", "account_1").events.map((event) => event.flow.flowId)).toEqual([
            "flow_b",
            "flow_b",
            "flow_c",
        ]);
    });

    it("replaces oversized daemon observability event payloads with truncation metadata", async () => {
        const events = await loadEventsModule();
        const storeMod = await loadStoreModule();
        expect(events?.createDaemonPeerMediationFlowEvent).toBeTypeOf("function");
        expect(storeMod?.createDaemonPeerMediationObservabilityStore).toBeTypeOf("function");
        if (!events?.createDaemonPeerMediationFlowEvent || !storeMod?.createDaemonPeerMediationObservabilityStore) return;

        const retentionOptions = {
            eventPayloadMaxBytes: 1024,
            nowMs: () => 1000,
        };
        const store = storeMod.createDaemonPeerMediationObservabilityStore(retentionOptions);
        const oversizedMetadata = Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [`safeField${index}`, "x".repeat(512)]),
        );

        const published = store.publish(events.createDaemonPeerMediationFlowEvent({
            accountId: "account_1",
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            flowId: "flow_large",
            kind: "flow.started",
            nowMs: 1000,
            metadata: oversizedMetadata,
        }));

        const stored = store.delta("machine_1", "account_1").events[0];
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

    it("fails closed when daemon observability feature bits are missing or malformed", async () => {
        const access = await loadAccessModule();
        expect(access?.isDaemonPeerMediationObservabilityReadAvailable).toBeTypeOf("function");
        if (!access?.isDaemonPeerMediationObservabilityReadAvailable) return;

        expect(access.isDaemonPeerMediationObservabilityReadAvailable({})).toBe(false);
        expect(access.isDaemonPeerMediationObservabilityReadAvailable({
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: true },
                    },
                },
            },
            capabilities: { machines: { peerMediation: { observability: {} } } },
        })).toBe(true);
        expect(access.isDaemonPeerMediationObservabilityReadAvailable({
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: "true" },
                    },
                },
            },
            capabilities: { machines: { peerMediation: { observability: { available: true } } } },
        })).toBe(false);
        expect(access.isDaemonPeerMediationObservabilityReadAvailable({
            features: {
                machines: {
                    enabled: true,
                    peerMediation: {
                        enabled: true,
                        observability: { enabled: true },
                    },
                },
            },
            capabilities: { machines: { peerMediation: { observability: { available: true } } } },
        })).toBe(true);
    });

});
