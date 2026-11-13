import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT,
    PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT,
} from "@happier-dev/protocol";

import { createPeerMediationFlowEvent } from "./events";
import { createPeerMediationObservabilityEmitter, createPeerMediationObservabilityStore } from "./store";
import { registerPeerMediationObservabilitySocketRoutes } from "./routes";

type HomeRow = Readonly<{ revision: number; values: Record<string, unknown>; encryptedSecrets: null }>;
const homeDb = vi.hoisted(() => ({
    // Prisma is the genuine persistent Home boundary; overlay and feature decisions stay real.
    readSettings: vi.fn<() => Promise<HomeRow | null>>(),
    readPolicy: vi.fn(async () => null),
    log: vi.fn(),
}));
vi.mock("@/utils/logging/log", () => ({ log: homeDb.log }));
vi.mock("@/storage/db", async () => ({
    db: {
        ...(await import("@/app/home/settings/homeConfigSnapshot.testkit")).homeConfigSnapshotPostgresQueryMock,
        homeSettings: { findUnique: homeDb.readSettings },
        homeGovernancePolicy: { findUnique: homeDb.readPolicy },
    },
    isPrismaErrorCode: () => false,
}));

const SETTING = "HAPPIER_FEATURE_MACHINES_PEER_MEDIATION_OBSERVABILITY__ENABLED";
const scope = { kind: "machine", accountId: "account_1", machineId: "machine_1" } as const;
let homeValues: Record<string, unknown>;
const row = (): HomeRow => ({ revision: 1, values: { ...homeValues }, encryptedSecrets: null });
const event = (flowId: string, kind: "flow.started" | "flow.closed") => createPeerMediationFlowEvent({
    accountId: scope.accountId, machineId: scope.machineId, flowKind: "tcp_tunnel", flowId,
    kind, nowMs: 1_000,
});

function socketBoundary() {
    const handlers = new Map<string, (payload?: unknown, callback?: (response: unknown) => void) => unknown>();
    const emitted: unknown[] = [];
    return {
        emitted,
        socket: {
            on(name: string, handler: (payload?: unknown, callback?: (response: unknown) => void) => unknown) { handlers.set(name, handler); },
            emit(_name: string, payload: unknown) { emitted.push(payload); },
        },
        async call(name: string, payload?: unknown) {
            let response: unknown;
            await handlers.get(name)?.(payload, (value) => { response = value; });
            return response;
        },
    };
}

beforeEach(() => {
    homeValues = { [SETTING]: false };
    homeDb.readSettings.mockReset().mockImplementation(async () => row());
    homeDb.readPolicy.mockReset().mockResolvedValue(null);
    homeDb.log.mockReset();
    vi.stubEnv(SETTING, undefined);
    vi.stubEnv("HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID", "route-grant-key");
    vi.stubEnv("HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY", Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"));
    vi.stubEnv("HAPPIER_PUBLIC_SERVER_URL", "https://home.example.test");
});
afterEach(() => vi.unstubAllEnvs());

describe("server peer-mediation collection", () => {
    it("uses the live Home setting to admit scoped subscriptions", async () => {
        const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const boundary = socketBoundary();
        registerPeerMediationObservabilitySocketRoutes(boundary.socket, {
            store,
            principal: { kind: "machineOwner", accountId: scope.accountId, machineId: scope.machineId },
        });
        expect(await boundary.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope }))
            .toEqual({ ok: false, reasonCode: "observability_unavailable" });
        homeValues[SETTING] = true;
        const malformed = socketBoundary();
        registerPeerMediationObservabilitySocketRoutes(malformed.socket, {
            store,
            featurePayload: null,
            principal: { kind: "machineOwner", accountId: scope.accountId, machineId: scope.machineId },
        });
        expect(await malformed.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope }))
            .toEqual({ ok: false, reasonCode: "observability_unavailable" });
        expect(malformed.emitted).toEqual([]);
        expect(await boundary.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope }))
            .toEqual({ ok: true, sequence: 0 });
        const emitter = createPeerMediationObservabilityEmitter(store);
        emitter.emit(event("subscribed", "flow.started"));
        await vi.waitFor(() => expect(boundary.emitted).toHaveLength(2));
    });

    it.each(["disconnect", PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT])(
        "cancels delayed Home admission on %s", async (cancelEvent) => {
            homeValues[SETTING] = true;
            let releaseRead: (value: HomeRow) => void = () => { throw new Error("Home read not initialized"); };
            homeDb.readSettings.mockReturnValueOnce(new Promise<HomeRow>((resolve) => { releaseRead = resolve; }));
            const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
            const boundary = socketBoundary();
            registerPeerMediationObservabilitySocketRoutes(boundary.socket, {
                store,
                principal: { kind: "machineOwner", accountId: scope.accountId, machineId: scope.machineId },
            });
            const admission = boundary.call(PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT, { scope });
            await vi.waitFor(() => expect(homeDb.readSettings).toHaveBeenCalled());
            await boundary.call(cancelEvent, { scope });
            releaseRead(row());
            await admission;
            const emitter = createPeerMediationObservabilityEmitter(store);
            emitter.emit(event("after_cancel", "flow.started"));
            await vi.waitFor(() => expect(store.snapshot(scope).flows).toHaveLength(1));
            expect(boundary.emitted).toEqual([]);
        },
    );

    it("does not retain events while the persisted Home observability setting is off", async () => {
        const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const emitter = createPeerMediationObservabilityEmitter(store);
        emitter.emit(event("disabled", "flow.started"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(store.snapshot(scope).flows).toEqual([]);
    });

    it("follows live Home setting changes without replacing the shared store", async () => {
        const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const emitter = createPeerMediationObservabilityEmitter(store);
        homeValues[SETTING] = true;
        emitter.emit(event("enabled_1", "flow.started"));
        await vi.waitFor(() => expect(store.snapshot(scope).flows).toHaveLength(1));
        homeValues[SETTING] = false;
        emitter.emit(event("disabled", "flow.started"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        homeValues[SETTING] = true;
        emitter.emit(event("enabled_2", "flow.started"));
        await vi.waitFor(() => expect(store.snapshot(scope).flows).toHaveLength(2));
        expect(store.snapshot(scope).flows.map((entry) => entry.flow.flowId)).toEqual(["enabled_1", "enabled_2"]);
    });

    it("does not let a Home setting override the deployment deny", async () => {
        homeValues[SETTING] = true;
        vi.stubEnv(SETTING, "0");
        const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const emitter = createPeerMediationObservabilityEmitter(store);
        emitter.emit(event("deployment_denied", "flow.started"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(store.snapshot(scope).flows).toEqual([]);
    });

    it("keeps a delayed Home decision from publishing start after the terminal event", async () => {
        homeValues[SETTING] = true;
        let releaseRead: (value: HomeRow) => void = () => { throw new Error("Home read not initialized"); };
        const firstRead = new Promise<HomeRow>((resolve) => { releaseRead = resolve; });
        homeDb.readSettings.mockReturnValueOnce(firstRead);
        const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const emitter = createPeerMediationObservabilityEmitter(store);
        emitter.emit(event("ordered", "flow.started"));
        emitter.emit(event("ordered", "flow.closed"));
        await vi.waitFor(() => expect(homeDb.readSettings).toHaveBeenCalled());
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseRead(row());
        await vi.waitFor(() => expect(store.snapshot(scope).sequence).toBe(2));
        expect(store.snapshot(scope).flows[0].lifecycleState).toBe("closed");
    });

    it("drops an observation on Home read failure and lets the next event recover", async () => {
        homeValues[SETTING] = true;
        homeDb.readSettings.mockRejectedValueOnce(new Error("Home DB unavailable"));
        const store = createPeerMediationObservabilityStore({ nowMs: () => 1_000 });
        const emitter = createPeerMediationObservabilityEmitter(store);
        emitter.emit(event("unavailable", "flow.started"));
        await vi.waitFor(() => expect(homeDb.log.mock.calls.some(([context]) =>
            context?.module === "peer-mediation-observability")).toBe(true));
        expect(store.snapshot(scope).flows).toEqual([]);
        emitter.emit(event("recovered", "flow.started"));
        await vi.waitFor(() => expect(store.snapshot(scope).flows.map((entry) => entry.flow.flowId)).toEqual(["recovered"]));
    });
});
