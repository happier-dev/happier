import { describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import { createRouteTestBuilder } from "../../../../testkit/routeTestBuilder";
import { getRouteEntry } from "../../../../testkit/routeHarness";
import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayAuthorizationV2Schema,
    createPeerTcpTunnelRelayAuthorizationSigningInputV2,
} from "@happier-dev/protocol";
import { RPC_METHODS } from "@happier-dev/protocol/rpc";

import { registerPeerMediationGrantRoutes } from "./registerPeerMediationGrantRoutes";
import { registerPeerTcpTunnelRelaySocketHandler } from "@/app/api/socket/peer/mediation/tunnel/registerRelay";
import { createRelayTestCoordinator } from "@/app/api/socket/peer/mediation/tunnel/relayCoordinator.testkit";

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
            readMachineOwnershipState: async () => "available",
        }),
    });
}

function createRouteWithOwnership(
    readMachineOwnershipState: (params: Readonly<{ accountId: string; machineId: string }>) => Promise<
        "available" | "revoked" | "replaced" | "missing"
    >,
) {
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
            readMachineOwnershipState,
        }),
    });
}

describe("registerPeerMediationGrantRoutes", () => {
    it("registers the canonical authenticated request throttle before minting signed grants", () => {
        const route = createRoute();

        expect(getRouteEntry(route.app, "POST", "/v1/machines/peer/mediation/route-grants").opts.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 60,
                timeWindow: "1 minute",
                keyGenerator: expect.any(Function),
            }),
        );
    });

    it("mints V2 only for an explicit strict ephemeral proof request", async () => {
        const route = createRoute();
        const ephemeralKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));

        const { response } = await route.invoke({
            userId: "account_1",
            body: {
                v: 2,
                kind: "ephemeral_ed25519",
                ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
                machineId: "machine_1",
                flowKind: "machine_rpc",
                routeKind: "loopback_direct",
                endpointFingerprint: "loopback_endpoint_1",
                ttlMs: 60_000,
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
            grant: {
                payload: {
                    v: 2,
                    proofKind: "ephemeral_ed25519",
                    ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
                },
            },
        });

        const malformed = await route.invoke({
            userId: "account_1",
            body: {
                ...baseBody,
                v: 2,
                kind: "ephemeral_ed25519",
                ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
                extra: true,
            },
        });
        expect(malformed.response).toMatchObject({ ok: false, reasonCode: "invalid_request" });
    });

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

    it("mints a signed server relay authorization for TCP tunnels without changing direct-route grant semantics", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const seenRelaySocketOwnership: Array<{ accountId: string; socketId: string }> = [];
        const relayRequestBody = {
            v: 2,
            machineId: "machine_1",
            flowKind: "tcp_tunnel",
            routeKind: "server_relay",
            ttlMs: 900_000,
            destination: { host: "127.0.0.1", port: 3000 },
            relaySocketId: "relay_socket_1",
            scope: {
                kind: "tcp_tunnel",
                tunnelId: "tun_1",
                allowedPorts: [3000],
                maxIdleMs: 30_000,
                maxDurationMs: 300_000,
                maxTotalBytes: 64 * 1024 * 1024,
            },
        } as const;
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: { body: relayRequestBody },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "3000,5173",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
                readMachineOwnershipState: async () => "available",
                verifyViewerSocketOwnership: async (input) => {
                    seenRelaySocketOwnership.push(input);
                    return input.socketId === "relay_socket_1";
                },
            }),
        });

        const { response } = await route.invoke({ userId: "account_1" });

        expect(seenRelaySocketOwnership).toEqual([{
            accountId: "account_1",
            socketId: "relay_socket_1",
        }]);

        expect(response).toMatchObject({
            ok: true,
            receipt: "peer.route_grant.minted",
            relayAuthorization: {
                payload: {
                    accountId: "account_1",
                    targetMachineId: "machine_1",
                    flowKind: "tcp_tunnel",
                    routeKind: "server_relay",
                    tunnelId: "tun_1",
                    relaySocketId: "relay_socket_1",
                    destination: { host: "127.0.0.1", port: 3000 },
                    maxFrameBytes: 64 * 1024,
                    maxIdleMs: 30_000,
                    maxDurationMs: 300_000,
                    maxTotalBytes: 64 * 1024 * 1024,
                    iat: 1_000,
                    exp: 301_000,
                },
            },
        });

        const parsedAuthorization = PeerTcpTunnelRelayAuthorizationV2Schema.safeParse(
            (response as { relayAuthorization?: unknown }).relayAuthorization,
        );
        expect(parsedAuthorization.success).toBe(true);
        if (!parsedAuthorization.success) return;

        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createPeerTcpTunnelRelayAuthorizationSigningInputV2(parsedAuthorization.data.payload), "utf8"),
            Buffer.from(parsedAuthorization.data.signature.valueBase64Url, "base64url"),
            keyPair.publicKey,
        )).toBe(true);

        const rejected = await route.invoke({
            userId: "account_1",
            body: { ...relayRequestBody, relaySocketId: "relay_socket_other" },
        });
        expect(rejected.response).toMatchObject({
            ok: false,
            reasonCode: "relay_socket_not_owned",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("blocks daemon voice STT tunnel relay with the live-stream relay gate even when generic tunnel relay is enabled", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: {
                body: {
                    v: 2,
                    machineId: "machine_1",
                    flowKind: "voice_media",
                    routeKind: "server_relay",
                    ttlMs: 900_000,
                    destination: { host: "127.0.0.1", port: 3000 },
                    relaySocketId: "relay_socket_1",
                    scope: {
                        kind: "voice_media",
                        tunnelId: "voice-media:machine_1:request_1",
                        applicationKind: "speech_transcription",
                        applicationAttemptId: "request_1",
                        applicationAuthorityDigest: `sha256:${"ab".repeat(32)}`,
                        maxIdleMs: 30_000,
                        maxDurationMs: 300_000,
                        maxTotalBytes: 64 * 1024,
                    },
                },
            },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "3000",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedEnabled]: "false",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
                readMachineOwnershipState: async () => "available",
                verifyViewerSocketOwnership: async ({ socketId }) => socketId === "relay_socket_1",
            }),
        });

        const { response, reply } = await route.invoke({ userId: "account_1" });

        expect(response).toBeUndefined();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });

    it("caps daemon voice STT tunnel relay with live-stream relay byte caps instead of generic tunnel caps", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: {
                body: {
                    v: 2,
                    machineId: "machine_1",
                    flowKind: "voice_media",
                    routeKind: "server_relay",
                    ttlMs: 900_000,
                    destination: { host: "127.0.0.1", port: 3000 },
                    relaySocketId: "relay_socket_1",
                    scope: {
                        kind: "voice_media",
                        tunnelId: "voice-media:machine_1:request_1",
                        applicationKind: "speech_transcription",
                        applicationAttemptId: "request_1",
                        applicationAuthorityDigest: `sha256:${"ab".repeat(32)}`,
                        maxIdleMs: 30_000,
                        maxDurationMs: 60_000,
                        maxTotalBytes: 129_000,
                    },
                },
            },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "3000",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxBitrateBps]: "64000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFramesPerSecond]: "12",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFrameBytes]: "32000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxDurationMs]: "60000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxTotalBytes]: "128000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount]: "2",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket]: "1",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine]: "1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
                readMachineOwnershipState: async () => "available",
                verifyViewerSocketOwnership: async ({ socketId }) => socketId === "relay_socket_1",
            }),
        });

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "relay_cap_exceeded",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("admits the daemon voice STT authorization minted by the real grant route", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: {
                body: {
                    v: 2,
                    machineId: "machine_1",
                    flowKind: "voice_media",
                    routeKind: "server_relay",
                    ttlMs: 900_000,
                    destination: { host: "127.0.0.1", port: 3000 },
                    relaySocketId: "relay_socket_1",
                    scope: {
                        kind: "voice_media",
                        tunnelId: "voice-media:machine_1:request_1",
                        applicationKind: "speech_transcription",
                        applicationAttemptId: "request_1",
                        applicationAuthorityDigest: `sha256:${"ab".repeat(32)}`,
                        maxIdleMs: 30_000,
                        maxDurationMs: 60_000,
                    },
                },
            },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "3000",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxBitrateBps]: "64000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFramesPerSecond]: "12",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFrameBytes]: "32000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxDurationMs]: "60000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxTotalBytes]: "128000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount]: "2",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket]: "1",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine]: "1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
                readMachineOwnershipState: async () => "available",
                verifyViewerSocketOwnership: async ({ socketId }) => socketId === "relay_socket_1",
            }),
        });

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: true,
            receipt: "peer.route_grant.minted",
            relayAuthorization: {
                payload: {
                    flowKind: "voice_media",
                    capProfileId: "machine_live_stream_relay_caps_v1",
                    maxFrameBytes: 32_000,
                    maxTotalBytes: 128_000,
                    maxIdleMs: 30_000,
                    maxDurationMs: 60_000,
                },
            },
        });

        const relayAuthorization = (response as {
            relayAuthorization?: unknown;
        }).relayAuthorization;
        const handlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
        const forwarded: unknown[] = [];
        const socket = {
            id: "relay_socket_1",
            data: { clientType: "user-scoped" },
            on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => {
                handlers.set(event, handler);
            },
            emit: () => undefined,
        };
        const relayIo = {
            to: () => ({
                emit: (event: string, payload: unknown) => {
                    if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) forwarded.push(payload);
                },
            }),
            local: {
                to: () => ({
                    emit: (event: string, payload: unknown) => {
                        if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) forwarded.push(payload);
                    },
                }),
            },
        };
        registerPeerTcpTunnelRelaySocketHandler("account_1", socket, {
            io: relayIo,
            coordinator: createRelayTestCoordinator(relayIo, "account_1"),
            nowMs: () => 1_000,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots: [{
                keyId: "grant-key-1",
                publicKeyBase64Url: toBase64Url(keyPair.publicKey),
            }],
        });

        await handlers.get(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT)?.({
            v: 1,
            scopeUserId: "account_1",
            sender: { kind: "user", socketId: "relay_socket_1" },
            recipient: { kind: "machine", machineId: "machine_1" },
            frame: {
                v: 1,
                kind: "open",
                open: {
                    v: 1,
                    kind: "open",
                    tunnelId: "voice-media:machine_1:request_1",
                    targetMachineId: "machine_1",
                    routeKind: "server_relay",
                    destination: { host: "127.0.0.1", port: 3000 },
                    relayAuthorization,
                },
            },
        });

        expect(forwarded).toContainEqual(expect.objectContaining({
            frame: expect.objectContaining({
                kind: "open",
                open: expect.objectContaining({
                    tunnelId: "voice-media:machine_1:request_1",
                }),
            }),
        }));
        await handlers.get("disconnect")?.();
    });

    it("authorizes daemon voice STT tunnel relay destinations with server-owned tunnel allowed ports", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: {
                body: {
                    v: 2,
                    machineId: "machine_1",
                    flowKind: "voice_media",
                    routeKind: "server_relay",
                    ttlMs: 900_000,
                    destination: { host: "127.0.0.1", port: 4444 },
                    relaySocketId: "relay_socket_1",
                    scope: {
                        kind: "voice_media",
                        tunnelId: "voice-media:machine_1:request_1",
                        applicationKind: "speech_transcription",
                        applicationAttemptId: "request_1",
                        applicationAuthorityDigest: `sha256:${"ab".repeat(32)}`,
                        maxIdleMs: 30_000,
                        maxDurationMs: 60_000,
                        maxTotalBytes: 64_000,
                    },
                },
            },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "3000",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedEnabled]: "true",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxBitrateBps]: "64000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFramesPerSecond]: "12",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFrameBytes]: "32000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxDurationMs]: "60000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxTotalBytes]: "128000",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount]: "2",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket]: "1",
                    [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine]: "1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
                readMachineOwnershipState: async () => "available",
                verifyViewerSocketOwnership: async ({ socketId }) => socketId === "relay_socket_1",
            }),
        });

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "destination_port_not_allowed",
            receipt: "peer.route_grant.rejected",
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

    it("rejects a loopback grant when the machine is not owned by the account (C2)", async () => {
        // "A profile id is never accepted as a machine id": a non-owned id resolves to `missing`.
        const route = createRouteWithOwnership(async () => "missing");

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "machine_not_owned",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("rejects a loopback grant when the machine is revoked (C2)", async () => {
        const route = createRouteWithOwnership(async () => "revoked");

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "machine_revoked",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("rejects a loopback grant when the machine was replaced (C2)", async () => {
        const route = createRouteWithOwnership(async () => "replaced");

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "machine_replaced",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("checks ownership against the authenticated account, not a client-supplied id (C2)", async () => {
        const seen: Array<{ accountId: string; machineId: string }> = [];
        const route = createRouteWithOwnership(async (params) => {
            seen.push(params);
            return "available";
        });

        await route.invoke({ userId: "account_1" });

        expect(seen).toEqual([{ accountId: "account_1", machineId: "machine_1" }]);
    });
});

describe("direct voice_media peer mediation grant gating", () => {
    const directVoiceMediaBody = {
        machineId: "machine_1",
        flowKind: "voice_media",
        routeKind: "loopback_direct",
        endpointFingerprint: "loopback_endpoint_1",
        ttlMs: 300_000,
        scope: {
            kind: "voice_media",
            tunnelId: "voice-media:machine_1:request_1",
            applicationKind: "speech_transcription",
            applicationAttemptId: "request_1",
            applicationAuthorityDigest: `sha256:${"ab".repeat(32)}`,
            maxIdleMs: 30_000,
            maxDurationMs: 60_000,
        },
    } as const;

    function createDirectVoiceMediaRoute(env: Readonly<Record<string, string>>) {
        const keyPair = tweetnacl.sign.keyPair();
        return createRouteTestBuilder({
            method: "POST",
            path: "/v1/machines/peer/mediation/route-grants",
            defaultRequest: { body: directVoiceMediaBody },
            registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
                env: {
                    ...env,
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                    [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
                },
                nowMs: () => 1_000,
                readMachineOwnershipState: async () => "available",
            }),
        });
    }

    // The daemon only registers the `voice_media` loopback flow when
    // `machines.tunnel.directPeer` is enabled (startLoopback.ts), and the client only attempts
    // the direct route under the same bit. The mint gate must agree with them, otherwise the
    // grant this route signs authorizes a route the daemon will never accept.
    it("mints a direct voice_media grant on the tunnel direct-peer bit with live-stream direct peer disabled", async () => {
        const route = createDirectVoiceMediaRoute({
            [FEATURE_ENV_KEYS.machinesTunnelDirectPeerEnabled]: "true",
            [FEATURE_ENV_KEYS.machinesLiveStreamDirectPeerEnabled]: "false",
        });

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: true,
            receipt: "peer.route_grant.minted",
            grant: { payload: { flowKind: "voice_media", routeKind: "loopback_direct" } },
        });
    });

    it("refuses a direct voice_media grant when the tunnel direct-peer bit is disabled", async () => {
        const route = createDirectVoiceMediaRoute({
            [FEATURE_ENV_KEYS.machinesTunnelDirectPeerEnabled]: "false",
            [FEATURE_ENV_KEYS.machinesLiveStreamDirectPeerEnabled]: "true",
        });

        const { response, reply } = await route.invoke({ userId: "account_1" });

        expect(response).toBeUndefined();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });
});
