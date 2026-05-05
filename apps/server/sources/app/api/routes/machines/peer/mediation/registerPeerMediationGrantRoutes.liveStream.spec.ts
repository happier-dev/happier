import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MachineLiveStreamRelayAuthorizationV1Schema,
    createMachineLiveStreamRelayAuthorizationSigningInputV1,
    type MachineLiveStreamFrameV1,
} from "@happier-dev/protocol";
import { machineLiveStreamRelayHandler } from "../../../../socket/machineLiveStreamRelayHandler";
import { createFakeSocket, getSocketHandler } from "../../../../testkit/socketHarness";
import { createRouteTestBuilder } from "../../../../testkit/routeTestBuilder";

import { registerPeerMediationGrantRoutes } from "./registerPeerMediationGrantRoutes";

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

const liveStreamRelayCaps = {
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 12,
    maxFrameBytes: 32_000,
    maxDurationMs: 60_000,
    maxTotalBytes: 128_000,
    maxConcurrentStreamsPerAccount: 2,
    maxConcurrentStreamsPerSocket: 1,
    maxConcurrentStreamsPerMachine: 1,
} as const;

function createRelayRoute(keyPair: ReturnType<typeof tweetnacl.sign.keyPair>) {
    return createRouteTestBuilder({
        method: "POST",
        path: "/v1/machines/peer/mediation/route-grants",
        defaultRequest: {
            body: {
                machineId: "machine-source",
                targetMachineId: "machine-target",
                flowKind: "live_stream",
                routeKind: "server_relay",
                ttlMs: 900_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                scope: {
                    kind: "live_stream",
                    streamId: "stream_1",
                    streamFamily: "screen",
                    maxBitrateBps: 64_000,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 128_000,
                },
            },
        },
        registerRoutes: (app) => registerPeerMediationGrantRoutes(app, {
            env: {
                [FEATURE_ENV_KEYS.machinesLiveStreamDirectPeerEnabled]: "true",
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
        }),
    });
}

function liveStreamFrame(sequence: number): MachineLiveStreamFrameV1 {
    const payloadBase64 = Buffer.from(new Uint8Array(3)).toString("base64");
    return {
        v: 1,
        streamId: "stream_1",
        sequence,
        timestampMs: 2_000 + sequence,
        payloadKind: sequence === 1 ? "image_keyframe" : "image_delta",
        payloadEncoding: "binary_base64",
        payloadBase64,
        payloadSizeBytes: 3,
    };
}

describe("live-stream peer mediation grant route", () => {
    it("issues signed relay authorization that the socket relay accepts", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRelayRoute(keyPair);

        const { response } = await route.invoke({ userId: "account_1" });

        expect(route.app.authenticate).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({
            ok: true,
            receipt: "peer.route_grant.minted",
            relayAuthorization: {
                payload: {
                    accountId: "account_1",
                    sourceMachineId: "machine-source",
                    targetMachineId: "machine-target",
                    flowKind: "live_stream",
                    routeKind: "server_relay",
                    streamId: "stream_1",
                    streamFamily: "screen",
                    maxBitrateBps: 64_000,
                    maxFramesPerSecond: 12,
                    maxFrameBytes: 32_000,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 128_000,
                    iat: 1_000,
                    exp: 301_000,
                },
            },
        });

        const parsedAuthorization = MachineLiveStreamRelayAuthorizationV1Schema.safeParse(
            (response as { relayAuthorization?: unknown }).relayAuthorization,
        );
        expect(parsedAuthorization.success).toBe(true);
        if (!parsedAuthorization.success) return;

        const signature = Buffer.from(parsedAuthorization.data.signature.valueBase64Url, "base64url");
        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(parsedAuthorization.data.payload), "utf8"),
            signature,
            keyPair.publicKey,
        )).toBe(true);

        const emittedToTarget = vi.fn();
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "machine-source",
            },
        });
        machineLiveStreamRelayHandler("account_1", socket as never, {
            io: { to: vi.fn(() => ({ emit: emittedToTarget })) },
            serverRoutedLiveStreamEnabled: true,
            relayCaps: liveStreamRelayCaps,
            relayAuthorizationTrustRoots: [{
                keyId: "grant-key-1",
                publicKeyBase64Url: toBase64Url(keyPair.publicKey),
            }],
            nowMs: () => 2_000,
        });
        const relay = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);

        await relay({
            v: 1,
            sourceMachineId: "machine-source",
            targetMachineId: "machine-target",
            message: {
                kind: "start",
                startRequest: {
                    v: 1,
                    streamId: "stream_1",
                    streamFamily: "screen",
                    routeKind: "server_relay",
                    sourceMachineId: "machine-source",
                    targetMachineId: "machine-target",
                    maxBitrateBps: 64_000,
                    maxFramesPerSecond: 12,
                    maxFrameBytes: 32_000,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 128_000,
                    authorization: parsedAuthorization.data,
                },
            },
        });
        await relay({
            v: 1,
            sourceMachineId: "machine-source",
            targetMachineId: "machine-target",
            message: { kind: "frame", frame: liveStreamFrame(1) },
        });

        expect(emittedToTarget).toHaveBeenCalledWith(
            MACHINE_LIVE_STREAM_SOCKET_EVENT,
            expect.objectContaining({
                message: expect.objectContaining({
                    kind: "frame",
                    frame: expect.objectContaining({ streamId: "stream_1", sequence: 1 }),
                }),
            }),
        );
    });
});
