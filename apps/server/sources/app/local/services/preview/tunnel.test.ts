import type { LocalServicePreviewResourceV1, PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";
import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
} from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";

type PreviewTunnelModule = typeof import("./tunnel");

async function loadPreviewTunnelModule(): Promise<PreviewTunnelModule | null> {
    return import("./tunnel.js").catch(() => null) as Promise<PreviewTunnelModule | null>;
}

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

const preview: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/", search: "" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "path",
};

function createRelayHarness() {
    const sent: PeerTcpTunnelRelayEnvelope[] = [];
    const handlers = new Set<(envelope: PeerTcpTunnelRelayEnvelope) => void>();
    const close = vi.fn();
    return {
        sent,
        close,
        createTransport: vi.fn(() => ({
            relaySocketId: "server_preview_relay_test",
            send: (event: typeof PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope: PeerTcpTunnelRelayEnvelope) => {
                expect(event).toBe(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT);
                sent.push(envelope);
            },
            subscribe: (handler: (envelope: PeerTcpTunnelRelayEnvelope) => void) => {
                handlers.add(handler);
                return () => {
                    handlers.delete(handler);
                };
            },
            close,
        })),
        receive: (envelope: PeerTcpTunnelRelayEnvelope) => {
            for (const handler of handlers) handler(envelope);
        },
    };
}

function daemonToClientAckCount(
    envelopes: readonly PeerTcpTunnelRelayEnvelope[],
    substreamId: string,
): number {
    return envelopes.filter((envelope) => {
        if (envelope.v !== 2) return false;
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: envelope.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        return decoded.ok
            && decoded.header.kind === "ack"
            && decoded.header.substreamId === substreamId
            && decoded.header.direction === "daemon_to_client";
    }).length;
}

function clientToDaemonDataPayloads(
    envelopes: readonly PeerTcpTunnelRelayEnvelope[],
    substreamId: string,
): string[] {
    return envelopes.flatMap((envelope) => {
        if (envelope.v !== 2) return [];
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: envelope.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        if (
            !decoded.ok
            || decoded.header.kind !== "data"
            || decoded.header.substreamId !== substreamId
            || decoded.header.direction !== "client_to_daemon"
        ) {
            return [];
        }
        return [new TextDecoder().decode(decoded.payload)];
    });
}

async function flushAsyncIteratorResume(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

describe("local service preview PMS tunnel opener", () => {
    it("opens a signed binary server-relay tunnel and carries preview bytes over a PMS substream", async () => {
        const mod = await loadPreviewTunnelModule();
        expect(mod?.createLocalServicePreviewTunnelOpener).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewTunnelOpener) return;

        const keyPair = tweetnacl.sign.keyPair();
        const relay = createRelayHarness();
        const openTunnel = mod.createLocalServicePreviewTunnelOpener({
            env: {
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelMaxIdleMs]: "25",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            nowMs: () => 1_000,
            resolvePreviewAccountId: () => "account_1",
            createRelayTransport: relay.createTransport,
        });

        const stream = await openTunnel({ preview });

        expect(relay.createTransport).toHaveBeenCalledWith({ accountId: "account_1" });
        expect(relay.sent[0]).toMatchObject({
            v: 1,
            scopeUserId: "account_1",
            sender: { kind: "user", socketId: "server_preview_relay_test" },
            recipient: { kind: "machine", machineId: "machine_1" },
            frame: {
                kind: "open",
                open: {
                    targetMachineId: "machine_1",
                    routeKind: "server_relay",
                    destination: { host: "127.0.0.1", port: 5173 },
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    allowV1Fallback: false,
                    relayAuthorization: {
                        payload: {
                            v: 2,
                            accountId: "account_1",
                            targetMachineId: "machine_1",
                            relaySocketId: "server_preview_relay_test",
                            destination: { host: "127.0.0.1", port: 5173 },
                        },
                    },
                },
            },
        });

        const substreamOpen = relay.sent[1];
        expect(substreamOpen).toMatchObject({
            v: 2,
            scopeUserId: "account_1",
            recipient: { kind: "machine", machineId: "machine_1" },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        });
        expect(substreamOpen?.v).toBe(2);
        if (!substreamOpen || substreamOpen.v !== 2) return;

        const decodedSubstreamOpen = decodePeerTcpTunnelBinaryFrameV2({
            frame: substreamOpen.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        expect(decodedSubstreamOpen).toMatchObject({
            ok: true,
            header: {
                kind: "open",
                substreamId: expect.any(String),
            },
        });
        if (!decodedSubstreamOpen.ok) return;
        const tunnelId = decodedSubstreamOpen.header.tunnelId;
        const substreamId = decodedSubstreamOpen.header.substreamId!;
        expect(stream.tunnelId).toBe(tunnelId);
        expect(stream.substreamId).toBe(substreamId);

        await stream.write(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"));
        const dataEnvelope = relay.sent[2];
        expect(dataEnvelope?.v).toBe(2);
        if (!dataEnvelope || dataEnvelope.v !== 2) return;
        const decodedData = decodePeerTcpTunnelBinaryFrameV2({
            frame: dataEnvelope.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        expect(decodedData).toMatchObject({
            ok: true,
            header: {
                kind: "data",
                tunnelId,
                substreamId,
                direction: "client_to_daemon",
            },
        });
        expect(decodedData.ok ? new TextDecoder().decode(decodedData.payload) : "").toBe("GET / HTTP/1.1\r\n\r\n");

        const read = stream.read()[Symbol.asyncIterator]();
        const responseBytes = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n<html>preview</html>");
        relay.receive({
            v: 2,
            scopeUserId: "account_1",
            sender: { kind: "machine", machineId: "machine_1" },
            recipient: { kind: "user" },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "data",
                    tunnelId,
                    substreamId,
                    direction: "daemon_to_client",
                    sequence: 0,
                    payloadLength: responseBytes.byteLength,
                },
                payload: responseBytes,
            }),
        });

        await expect(read.next()).resolves.toEqual({
            done: false,
            value: responseBytes,
        });
        expect(daemonToClientAckCount(relay.sent, substreamId)).toBe(0);

        const pendingDone = read.next();
        await flushAsyncIteratorResume();
        expect(daemonToClientAckCount(relay.sent, substreamId)).toBe(1);

        relay.receive({
            v: 2,
            scopeUserId: "account_1",
            sender: { kind: "machine", machineId: "machine_1" },
            recipient: { kind: "user" },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "close",
                    tunnelId,
                    substreamId,
                    halfClose: false,
                    reasonCode: "upstream_closed",
                    payloadLength: 0,
                },
            }),
        });
        await expect(pendingDone).resolves.toEqual({
            done: true,
            value: undefined,
        });
    });

    it("opens parallel preview requests as distinct V2 substreams on one authorized relay tunnel", async () => {
        const mod = await loadPreviewTunnelModule();
        expect(mod?.createLocalServicePreviewTunnelOpener).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewTunnelOpener) return;

        const keyPair = tweetnacl.sign.keyPair();
        const relay = createRelayHarness();
        const generatedIds = ["tunnel_1", "sub_a", "sub_b"];
        const openTunnel = mod.createLocalServicePreviewTunnelOpener({
            env: {
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            nowMs: () => 1_000,
            resolvePreviewAccountId: () => "account_1",
            createRelayTransport: relay.createTransport,
            generateId: () => generatedIds.shift() ?? "extra",
        });

        const firstOpen = openTunnel({ preview });
        const secondOpen = openTunnel({ preview });
        const [firstStream, secondStream] = await Promise.all([firstOpen, secondOpen]);

        expect(relay.createTransport).toHaveBeenCalledTimes(1);
        expect(firstStream.tunnelId).toBe("preview_tunnel_tunnel_1");
        expect(secondStream.tunnelId).toBe(firstStream.tunnelId);
        expect(firstStream.substreamId).toBe("preview_substream_sub_a");
        expect(secondStream.substreamId).toBe("preview_substream_sub_b");

        const decodedOpens = relay.sent
            .filter((envelope): envelope is Extract<PeerTcpTunnelRelayEnvelope, { v: 2 }> => envelope.v === 2)
            .map((envelope) => decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: 64 * 1024,
                maxPayloadBytes: 64 * 1024,
            }))
            .filter((decoded) => decoded.ok && decoded.header.kind === "open");

        expect(decodedOpens.map((decoded) => decoded.ok ? decoded.header.substreamId : null)).toEqual([
            "preview_substream_sub_a",
            "preview_substream_sub_b",
        ]);

        await firstStream.write(new TextEncoder().encode("GET /first HTTP/1.1\r\n\r\n"));
        await secondStream.write(new TextEncoder().encode("GET /second HTTP/1.1\r\n\r\n"));

        const decodedData = relay.sent
            .filter((envelope): envelope is Extract<PeerTcpTunnelRelayEnvelope, { v: 2 }> => envelope.v === 2)
            .map((envelope) => decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: 64 * 1024,
                maxPayloadBytes: 64 * 1024,
            }))
            .filter((decoded) => decoded.ok && decoded.header.kind === "data");

        expect(decodedData.map((decoded) => decoded.ok ? [
            decoded.header.substreamId,
            new TextDecoder().decode(decoded.payload),
        ] : null)).toEqual([
            ["preview_substream_sub_a", "GET /first HTTP/1.1\r\n\r\n"],
            ["preview_substream_sub_b", "GET /second HTTP/1.1\r\n\r\n"],
        ]);

        await firstStream.close();
        await secondStream.close();
    });

    it("does not send client data until a positive client window is advertised after zero-credit ACK wakeups", async () => {
        const mod = await loadPreviewTunnelModule();
        expect(mod?.createLocalServicePreviewTunnelOpener).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewTunnelOpener) return;

        const keyPair = tweetnacl.sign.keyPair();
        const relay = createRelayHarness();
        const openTunnel = mod.createLocalServicePreviewTunnelOpener({
            env: {
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            nowMs: () => 1_000,
            resolvePreviewAccountId: () => "account_1",
            createRelayTransport: relay.createTransport,
        });

        const stream = await openTunnel({ preview });
        const substreamOpen = relay.sent[1];
        expect(substreamOpen?.v).toBe(2);
        if (!substreamOpen || substreamOpen.v !== 2) return;

        const decodedSubstreamOpen = decodePeerTcpTunnelBinaryFrameV2({
            frame: substreamOpen.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        expect(decodedSubstreamOpen.ok).toBe(true);
        if (!decodedSubstreamOpen.ok) return;

        const tunnelId = decodedSubstreamOpen.header.tunnelId;
        const substreamId = decodedSubstreamOpen.header.substreamId!;
        const zeroWindowAck = {
            v: 2 as const,
            scopeUserId: "account_1",
            sender: { kind: "machine" as const, machineId: "machine_1" },
            recipient: { kind: "user" as const },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "ack",
                    tunnelId,
                    substreamId,
                    direction: "client_to_daemon",
                    ack: 0,
                    window: 0,
                    payloadLength: 0,
                },
            }),
        };
        relay.receive(zeroWindowAck);

        const payload = new TextEncoder().encode("PING");
        let writeSettled = false;
        const writePromise = Promise.resolve(stream.write(payload)).then(() => {
            writeSettled = true;
        });

        await flushAsyncIteratorResume();
        expect(clientToDaemonDataPayloads(relay.sent, substreamId)).toEqual([]);
        expect(writeSettled).toBe(false);

        relay.receive(zeroWindowAck);
        await flushAsyncIteratorResume();
        expect(clientToDaemonDataPayloads(relay.sent, substreamId)).toEqual([]);
        expect(writeSettled).toBe(false);

        relay.receive({
            ...zeroWindowAck,
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "ack",
                    tunnelId,
                    substreamId,
                    direction: "client_to_daemon",
                    ack: 0,
                    window: payload.byteLength,
                    payloadLength: 0,
                },
            }),
        });

        await writePromise;
        expect(clientToDaemonDataPayloads(relay.sent, substreamId)).toEqual(["PING"]);
    });

    it("keeps the relay transport alive until queued response bytes drain after upstream close", async () => {
        const mod = await loadPreviewTunnelModule();
        expect(mod?.createLocalServicePreviewTunnelOpener).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewTunnelOpener) return;

        const keyPair = tweetnacl.sign.keyPair();
        const relay = createRelayHarness();
        const openTunnel = mod.createLocalServicePreviewTunnelOpener({
            env: {
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            nowMs: () => 1_000,
            resolvePreviewAccountId: () => "account_1",
            createRelayTransport: relay.createTransport,
        });

        const stream = await openTunnel({ preview });
        const substreamOpen = relay.sent[1];
        expect(substreamOpen?.v).toBe(2);
        if (!substreamOpen || substreamOpen.v !== 2) return;

        const decodedSubstreamOpen = decodePeerTcpTunnelBinaryFrameV2({
            frame: substreamOpen.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        expect(decodedSubstreamOpen).toMatchObject({
            ok: true,
            header: {
                kind: "open",
                substreamId: expect.any(String),
            },
        });
        if (!decodedSubstreamOpen.ok) return;

        const tunnelId = decodedSubstreamOpen.header.tunnelId;
        const substreamId = decodedSubstreamOpen.header.substreamId!;
        const responseBytes = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nok");
        const read = stream.read()[Symbol.asyncIterator]();

        vi.useFakeTimers();
        try {
            relay.receive({
                v: 2,
                scopeUserId: "account_1",
                sender: { kind: "machine", machineId: "machine_1" },
                recipient: { kind: "user" },
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                frame: encodePeerTcpTunnelBinaryFrameV2({
                    header: {
                        version: 2,
                        kind: "data",
                        tunnelId,
                        substreamId,
                        direction: "daemon_to_client",
                        sequence: 0,
                        payloadLength: responseBytes.byteLength,
                    },
                    payload: responseBytes,
                }),
            });
            relay.receive({
                v: 2,
                scopeUserId: "account_1",
                sender: { kind: "machine", machineId: "machine_1" },
                recipient: { kind: "user" },
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                frame: encodePeerTcpTunnelBinaryFrameV2({
                    header: {
                        version: 2,
                        kind: "close",
                        tunnelId,
                        substreamId,
                        halfClose: false,
                        reasonCode: "upstream_closed",
                        payloadLength: 0,
                    },
                }),
            });

            expect(relay.close).not.toHaveBeenCalled();
            await expect(read.next()).resolves.toEqual({
                done: false,
                value: responseBytes,
            });
            expect(relay.close).not.toHaveBeenCalled();
            await vi.runOnlyPendingTimersAsync();
            expect(relay.close).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
