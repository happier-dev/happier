import { describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import { createRouteTestBuilder } from "../../../../testkit/routeTestBuilder";
import { RPC_METHODS } from "@happier-dev/protocol/rpc";

import { registerPeerMediationGrantRoutes } from "./registerPeerMediationGrantRoutes";

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

const baseBody = {
    machineId: "machine_1",
    flowKind: "bounded_transfer",
    routeKind: "loopback_direct",
    endpointFingerprint: "loopback_endpoint_1",
    ttlMs: 600_000,
    scope: {
        kind: "bounded_transfer",
        mode: "single",
        transferId: "transfer_1",
        maxBytes: 1024,
    },
} as const;

function createRoute() {
    const keyPair = tweetnacl.sign.keyPair();
    return createRouteTestBuilder({
        method: "POST",
        path: "/v1/machines/peer/mediation/route-grants",
        defaultRequest: { body: baseBody },
        registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
            env: {
                [FEATURE_ENV_KEYS.machinesTransferDirectPeerEnabled]: "true",
                HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED: "true",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            },
            nowMs: () => 1_000,
        }),
    });
}

describe("registerPeerMediationGrantRoutes", () => {
    it("mints a loopback route grant for the authenticated account", async () => {
        const route = createRoute();

        const { response } = await route.invoke({
            userId: "account_1",
        });

        expect(route.routeExists).toBe(true);
        expect(route.app.authenticate).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({
            ok: true,
            receipt: "peer.route_grant.minted",
            grant: {
                payload: {
                    accountId: "account_1",
                    machineId: "machine_1",
                    flowKind: "bounded_transfer",
                    routeKind: "loopback_direct",
                    endpointFingerprint: "loopback_endpoint_1",
                },
            },
        });
    });

    it("mints machine RPC grants only for direct-eligible methods", async () => {
        const route = createRoute();

        const { response } = await route.invoke({
            userId: "account_1",
            body: {
                ...baseBody,
                flowKind: "machine_rpc",
                scope: {
                    kind: "machine_rpc",
                    rpcScopeId: "rpc_scope_1",
                    allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                    maxCalls: 1,
                    maxIdleMs: 1_000,
                },
            },
        });

        expect(response).toMatchObject({
            ok: true,
            receipt: "peer.route_grant.minted",
            grant: {
                payload: {
                    flowKind: "machine_rpc",
                    scope: {
                        kind: "machine_rpc",
                        allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                    },
                },
            },
        });
    });

    it("rejects machine RPC grants for server-required methods", async () => {
        const route = createRoute();

        const { response } = await route.invoke({
            userId: "account_1",
            body: {
                ...baseBody,
                flowKind: "machine_rpc",
                scope: {
                    kind: "machine_rpc",
                    rpcScopeId: "rpc_scope_1",
                    allowedMethods: [RPC_METHODS.SPAWN_HAPPY_SESSION],
                    maxCalls: 1,
                    maxIdleMs: 1_000,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "machine_rpc_method_server_required",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("returns the canonical feature-gated 404 when direct peer RPC is disabled", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: {
                body: {
                    ...baseBody,
                    flowKind: "machine_rpc",
                    scope: {
                        kind: "machine_rpc",
                        rpcScopeId: "rpc_scope_1",
                        allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                        maxCalls: 1,
                        maxIdleMs: 1_000,
                    },
                },
            },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTransferDirectPeerEnabled]: "true",
                    HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED: "false",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
            }),
        });

        const { response, reply } = await route.invoke({
            userId: "account_1",
        });

        expect(response).toBeUndefined();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });

    it("clamps request TTLs to the bounded-transfer single-grant TTL", async () => {
        const route = createRoute();

        const { response } = await route.invoke({
            userId: "account_1",
            body: {
                ...baseBody,
                ttlMs: 24 * 60 * 60_000,
            },
        });

        expect(response).toMatchObject({
            ok: true,
            grant: {
                payload: {
                    iat: 1_000,
                    exp: 601_000,
                },
            },
        });
    });

    it("returns the canonical feature-gated 404 when direct peer transfer is disabled", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: { body: baseBody },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTransferDirectPeerEnabled]: "false",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
            }),
        });

        const { response, reply } = await route.invoke({
            userId: "account_1",
        });

        expect(response).toBeUndefined();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });

    it("returns the canonical feature-gated 404 when grant signing capability is unavailable", async () => {
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: { body: baseBody },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTransferDirectPeerEnabled]: "true",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: `${"A".repeat(43)}$`,
                },
                nowMs: () => 1_000,
            }),
        });

        const { response, reply } = await route.invoke({
            userId: "account_1",
        });

        expect(response).toBeUndefined();
        expect(route.app.authenticate).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });
});
