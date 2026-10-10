import { beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MachineLiveStreamRelayAuthorizationV1Schema,
    createMachineLiveStreamRelayAuthorizationSigningInputV1,
    type MachineLiveStreamWireFrameV1 as MachineLiveStreamFrameV1,
} from "@happier-dev/protocol";
import { machineLiveStreamRelayHandler } from "../../../../socket/machineLiveStreamRelayHandler";
import { createFakeSocket as createSocketFixture, getSocketHandler } from "../../../../testkit/socketHarness";
import { TEST_MACHINE_INSTALLATION_ID } from "../../../../testkit/machineAdmissionPersistenceBoundary";
import { createRouteTestBuilder } from "../../../../testkit/routeTestBuilder";

import { registerPeerMediationGrantRoutes } from "./registerPeerMediationGrantRoutes";

const machineAvailabilityFixture = vi.hoisted(() => ({
    custodianAccountId: 'account_1',
    read: async (_machineId: string): Promise<'available' | 'revoked' | 'replaced' | 'missing'> => 'available',
}));
vi.mock('@/storage/db', async () => {
    const { createMachineAdmissionPersistenceBoundary } = await import('../../../../testkit/machineAdmissionPersistenceBoundary');
    const boundary = createMachineAdmissionPersistenceBoundary(() => machineAvailabilityFixture.custodianAccountId);
    boundary.setAvailabilityReader((machineId) => machineAvailabilityFixture.read(machineId));
    return { db: boundary.db };
});
beforeEach(() => {
    machineAvailabilityFixture.read = async () => 'available';
    machineAvailabilityFixture.custodianAccountId = 'account_1';
});

function createFakeSocket(...args: Parameters<typeof createSocketFixture>) {
    const socket = createSocketFixture(...args);
    if (socket.data?.clientType === 'machine-scoped') socket.data.verifiedMachineInstallationId ??= TEST_MACHINE_INSTALLATION_ID;
    return socket;
}

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

function createRelayRoute(
    keyPair: ReturnType<typeof tweetnacl.sign.keyPair>,
    readPersistedAvailability: (params: Readonly<{ accountId: string; machineId: string }>) => Promise<
        "available" | "revoked" | "replaced" | "missing"
    > = async () => "available",
    verifyViewerSocketOwnership?: (params: Readonly<{ accountId: string; socketId: string }>) => boolean | Promise<boolean>,
    envOverrides: NodeJS.ProcessEnv = {},
) {
    machineAvailabilityFixture.read = (machineId) => readPersistedAvailability({ accountId: 'account_1', machineId });
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
                ...envOverrides,
            },
            nowMs: () => 1_000,
            verifyViewerSocketOwnership,
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
        payload: { t: "plain", v: payloadBase64 },
        payloadSizeBytes: 3,
    };
}

describe("live-stream peer mediation grant route", () => {
    it('signs explicit Home limits when the viewer does not impose quality or lifetime ceilings', async () => {
        const route = createRelayRoute(tweetnacl.sign.keyPair());
        const { response } = await route.invoke({ userId: 'account_1', body: {
            machineId: 'machine-source', targetMachineId: 'machine-target', flowKind: 'live_stream',
            routeKind: 'server_relay', ttlMs: 60_000,
            scope: { kind: 'live_stream', streamId: 'stream_1', streamFamily: 'screen' },
        } });
        expect(response).toMatchObject({ ok: true, relayAuthorization: { payload: {
            maxBitrateBps: 64_000, maxFramesPerSecond: 12, maxFrameBytes: 32_000,
            maxDurationMs: 60_000, maxTotalBytes: 128_000,
        } } });
    });

    it('mints a relay grant without requiring viewer quality ceilings or eight Home caps', async () => {
        const route = createRelayRoute(tweetnacl.sign.keyPair(), undefined, undefined, {
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxBitrateBps]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFramesPerSecond]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxFrameBytes]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxDurationMs]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxTotalBytes]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerAccount]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerSocket]: undefined,
            [FEATURE_ENV_KEYS.machinesLiveStreamServerRoutedMaxConcurrentStreamsPerMachine]: undefined,
        });
        const { response } = await route.invoke({ userId: 'account_1', body: {
            machineId: 'machine-source', targetMachineId: 'machine-target', flowKind: 'live_stream',
            routeKind: 'server_relay', ttlMs: 60_000, codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
            scope: { kind: 'live_stream', streamId: 'stream_1', streamFamily: 'screen' },
        } });
        expect(response).toMatchObject({ ok: true, relayAuthorization: { payload: {
            sourceMachineId: 'machine-source', streamId: 'stream_1', exp: 61_000,
            codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
        } } });
    });

    it("issues exact browser-source authorization that the socket relay accepts", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRelayRoute(keyPair);

        const { response } = await route.invoke({ userId: "account_1", body: {
            machineId: "machine-source", targetMachineId: "machine-target", flowKind: "live_stream",
            routeKind: "server_relay", ttlMs: 900_000, maxFramesPerSecond: 12, maxFrameBytes: 32_000,
            scope: { kind: "live_stream", streamId: "stream_1", streamFamily: "browser.streamed",
                sourceId: "browser-view-a", maxBitrateBps: 64_000, maxDurationMs: 60_000, maxTotalBytes: 128_000 },
        } });

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
                    streamFamily: "browser.streamed",
                    sourceId: "browser-view-a",
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
        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1({
                ...parsedAuthorization.data.payload, sourceId: "browser-view-b",
            }), "utf8"), signature, keyPair.publicKey,
        )).toBe(false);

        const emittedToTarget = vi.fn();
        const socket = createFakeSocket({
            data: {
                clientType: "machine-scoped",
                machineId: "machine-source",
            },
        });
        machineLiveStreamRelayHandler("account_1", socket as never, {
            io: { to: vi.fn(() => ({ emit: emittedToTarget })) },
            resolveAccountEncryptionMode: async (): Promise<"plain"> => "plain",
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
                    streamFamily: "browser.streamed",
                    sourceId: "browser-view-a",
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

    it("mints a viewer-bound grant the relay delivers to the exact tab via io.to(viewerSocketId) (C1)", async () => {
        machineAvailabilityFixture.custodianAccountId = 'account_view';
        // Distinct account / machine / stream ids so this stream does not collide with the
        // module-level relay state another test in this file leaves behind (per-machine cap).
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRelayRoute(
            keyPair,
            async () => "available",
            async ({ accountId, socketId }) => accountId === "account_view" && socketId === "viewer-tab-1",
        );

        const { response } = await route.invoke({
            userId: "account_view",
            body: {
                machineId: "machine-vsrc",
                targetMachineId: "machine-vtgt",
                flowKind: "live_stream",
                routeKind: "server_relay",
                ttlMs: 900_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                viewerSocketId: "viewer-tab-1",
                scope: {
                    kind: "live_stream",
                    streamId: "stream_view",
                    streamFamily: "screen",
                    maxBitrateBps: 64_000,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 128_000,
                },
            },
        });

        // The minted payload must carry the viewer socket id so the signed grant binds the tab.
        expect(response).toMatchObject({
            ok: true,
            relayAuthorization: { payload: { viewerSocketId: "viewer-tab-1" } },
        });
        const parsedAuthorization = MachineLiveStreamRelayAuthorizationV1Schema.safeParse(
            (response as { relayAuthorization?: unknown }).relayAuthorization,
        );
        expect(parsedAuthorization.success).toBe(true);
        if (!parsedAuthorization.success) return;

        // The signature must cover the viewerSocketId-bearing payload (canonical-JSON signing input).
        const signature = Buffer.from(parsedAuthorization.data.signature.valueBase64Url, "base64url");
        expect(tweetnacl.sign.detached.verify(
            Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(parsedAuthorization.data.payload), "utf8"),
            signature,
            keyPair.publicKey,
        )).toBe(true);

        const target = vi.fn();
        const io = { to: vi.fn(() => ({ emit: target })) };
        const socket = createFakeSocket({
            data: { clientType: "machine-scoped", machineId: "machine-vsrc" },
        });
        machineLiveStreamRelayHandler("account_view", socket as never, {
            io,
            resolveAccountEncryptionMode: async (): Promise<"plain"> => "plain",
            serverRoutedLiveStreamEnabled: true,
            relayCaps: liveStreamRelayCaps,
            relayAuthorizationTrustRoots: [{
                keyId: "grant-key-1",
                publicKeyBase64Url: toBase64Url(keyPair.publicKey),
            }],
            verifyViewerSocketOwnership: async ({ accountId, socketId }) => (
                accountId === "account_view" && socketId === "viewer-tab-1"
            ),
            nowMs: () => 2_000,
        });
        const relay = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);

        // The source daemon echoes the minted viewerSocketId in its start request; a mismatch would
        // be rejected by the protocol superRefine — proving mint and start agree on the tab binding.
        await relay({
            v: 1,
            sourceMachineId: "machine-vsrc",
            targetMachineId: "machine-vtgt",
            viewerSocketId: "viewer-tab-1",
            message: {
                kind: "start",
                startRequest: {
                    v: 1,
                    streamId: "stream_view",
                    streamFamily: "screen",
                    routeKind: "server_relay",
                    sourceMachineId: "machine-vsrc",
                    targetMachineId: "machine-vtgt",
                    viewerSocketId: "viewer-tab-1",
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
            sourceMachineId: "machine-vsrc",
            targetMachineId: "machine-vtgt",
            viewerSocketId: "viewer-tab-1",
            message: { kind: "frame", frame: { ...liveStreamFrame(1), streamId: "stream_view" } },
        });

        // Frames are delivered to the per-tab socket room, never broadcast to a machine room the
        // user-scoped viewer never joined.
        expect(io.to).toHaveBeenCalledWith("viewer-tab-1");
        expect(target).toHaveBeenCalledWith(
            MACHINE_LIVE_STREAM_SOCKET_EVENT,
            expect.objectContaining({
                message: expect.objectContaining({ kind: "frame" }),
            }),
        );
    });

    it("rejects a viewer-bound mint when the viewer socket is not proven to belong to the account", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRelayRoute(keyPair);

        const { response } = await route.invoke({
            userId: "account_view",
            body: {
                machineId: "machine-vsrc-reject",
                targetMachineId: "machine-vtgt-reject",
                flowKind: "live_stream",
                routeKind: "server_relay",
                ttlMs: 900_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                viewerSocketId: "stolen-viewer-socket",
                scope: {
                    kind: "live_stream",
                    streamId: "stream_view_reject",
                    streamFamily: "screen",
                    maxBitrateBps: 64_000,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 128_000,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "viewer_socket_not_owned",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("rejects the live-stream mint when the source machine is not owned (C2)", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRelayRoute(keyPair, async ({ machineId }) => (
            machineId === "machine-source" ? "missing" : "available"
        ));

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "access_denied",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("rejects the live-stream mint when the TARGET machine is not owned (C2 — both branches checked)", async () => {
        const keyPair = tweetnacl.sign.keyPair();
        const route = createRelayRoute(keyPair, async ({ machineId }) => (
            machineId === "machine-target" ? "missing" : "available"
        ));

        const { response } = await route.invoke({ userId: "account_1" });

        expect(response).toMatchObject({
            ok: false,
            reasonCode: "access_denied",
            receipt: "peer.route_grant.rejected",
        });
    });

    it("does not mint another Account's available source and target", async () => {
        const route = createRelayRoute(tweetnacl.sign.keyPair());
        expect((await route.invoke({ userId: 'account_2' })).response).toMatchObject({
            ok: false, reasonCode: 'access_denied',
        });
    });
});
