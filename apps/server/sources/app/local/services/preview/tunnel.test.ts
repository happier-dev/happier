import type { LocalServicePreviewResourceV1, PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";
import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
} from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { createServer } from "node:http";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import { createLocalServicePreviewUpgradeClient } from "./upgradeClient";
import { proxyLocalServicePreviewWebSocketUpgrade } from "./websocketAdapter";

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
    originMode: "host",
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
    it("survives repeated Machine close frames for an unresolved preview during a real socket upgrade", async () => {
        const relay = createRelayHarness();
        const { createLocalServicePreviewTunnelOpener } = await import("./tunnel");
        const { peerMediationGrantSigningEnv } = await import("@/testkit/env");
        const openTunnel = createLocalServicePreviewTunnelOpener({
            env: { ...peerMediationGrantSigningEnv(), [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173" },
            resolvePreviewAccountId: () => "account_1", createRelayTransport: relay.createTransport,
        });
        const socketErrors: Error[] = [];
        const server = createServer((_request, response) => response.end("healthy"));
        const upgraded = new Promise<Readonly<{
            pending: ReturnType<typeof proxyLocalServicePreviewWebSocketUpgrade>;
            closed: Promise<void>;
        }>>(resolve => server.once("upgrade", (request, socket) => {
            // Observe an event that would otherwise terminate the server after HTTP removes its handler.
            socket.on("error", error => socketErrors.push(error));
            const closed = new Promise<void>(done => socket.once("close", () => done()));
            const pending = proxyLocalServicePreviewWebSocketUpgrade({
                preview,
                request: { path: request.url ?? "/socket", search: "", headers: request.headers,
                    rawHeaders: request.rawHeaders, client: createLocalServicePreviewUpgradeClient(socket) },
                openTunnel,
            });
            resolve({ pending, closed });
        }));
        let client: Socket | undefined;
        try {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Expected TCP server address");
            client = connect(address.port, "127.0.0.1");
            await once(client, "connect");
            client.write("GET /socket HTTP/1.1\r\nHost: preview.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: client-key\r\nSec-WebSocket-Version: 13\r\n\r\n");
            const { pending, closed } = await upgraded;
            await flushAsyncIteratorResume();
            const opening = relay.sent[0];
            if (!opening || opening.v !== 1 || opening.frame.kind !== "open") throw new Error("Expected parent relay open");
            const refusal: PeerTcpTunnelRelayEnvelope = {
                v: 2, scopeUserId: "account_1", sender: { kind: "machine", machineId: preview.machineId },
                recipient: { kind: "user", socketId: "server_preview_relay_test" },
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                    version: 2, kind: "close", tunnelId: opening.frame.open.tunnelId,
                    halfClose: false, reasonCode: "preview_target_unresolved", payloadLength: 0,
                } }),
            };
            expect(() => { relay.receive(refusal); relay.receive(refusal); }).not.toThrow();
            await expect(pending).resolves.toEqual({ ok: false, reasonCode: "upstream_stream_failed" });
            await closed;
            expect(socketErrors).toEqual([]);
            expect(relay.close).toHaveBeenCalledTimes(1);
            const health = await fetch(`http://127.0.0.1:${address.port}/health`);
            expect(health.status).toBe(200);
            expect(await health.text()).toBe("healthy");
            const recovered = await openTunnel({ preview });
            expect(recovered.tunnelId).not.toBe(opening.frame.open.tunnelId);
            await recovered.close();
        } finally {
            client?.destroy();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it("settles a server relay admission refusal instead of waiting for Machine bytes", async () => {
        const relay = createRelayHarness();
        const { createLocalServicePreviewTunnelOpener } = await import('./tunnel');
        const { peerMediationGrantSigningEnv } = await import('@/testkit/env');
        const openTunnel = createLocalServicePreviewTunnelOpener({
            env: { ...peerMediationGrantSigningEnv(), [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' },
            resolvePreviewAccountId: () => 'account_1', createRelayTransport: relay.createTransport,
        });
        const stream = await openTunnel({ preview });
        const opening = relay.sent[0];
        if (!opening || opening.v !== 1) throw new Error('Expected parent relay open');
        const reading = stream.read()[Symbol.asyncIterator]().next();
        // The real relay addresses its rejection to both participants but preserves
        // the original sender/recipient in the envelope (registerRelay emitAbort).
        relay.receive({ ...opening, frame: { v: 1, kind: 'abort', tunnelId: stream.tunnelId, reasonCode: 'route_unavailable' } });
        try {
            // Scheduling one turn distinguishes a settled refusal from an immortal read,
            // without imposing a duration budget on product work.
            expect(await Promise.race([reading.then(() => 'eof', error => error.message),
                new Promise(resolve => setImmediate(() => resolve('pending')))] )).toBe('route_unavailable');
        } finally { await stream.abort('test_cleanup'); await reading.catch(() => undefined); }
    });

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
            expect(relay.close).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects regressive client credit ACKs through the shared duplex session", async () => {
        const mod = await loadPreviewTunnelModule();
        if (!mod?.createLocalServicePreviewTunnelOpener) throw new Error("preview tunnel module unavailable");
        const keyPair = tweetnacl.sign.keyPair();
        const relay = createRelayHarness();
        const stream = await mod.createLocalServicePreviewTunnelOpener({
            env: {
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            resolvePreviewAccountId: () => "account_1",
            createRelayTransport: relay.createTransport,
        })({ preview });
        const open = relay.sent[1];
        if (!open || open.v !== 2) throw new Error("substream open missing");
        const decodedOpen = decodePeerTcpTunnelBinaryFrameV2({
            frame: open.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        if (!decodedOpen.ok || !decodedOpen.header.substreamId) throw new Error("substream open invalid");

        await stream.write(new Uint8Array([1, 2, 3]));
        const ack = (nextSequence: number) => relay.receive({
            v: 2,
            scopeUserId: "account_1",
            sender: { kind: "machine", machineId: "machine_1" },
            recipient: { kind: "user" },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "ack",
                    tunnelId: decodedOpen.header.tunnelId,
                    substreamId: decodedOpen.header.substreamId,
                    direction: "client_to_daemon",
                    ack: nextSequence,
                    window: 16,
                    payloadLength: 0,
                },
            }),
        });
        ack(3);
        ack(2);
        await flushAsyncIteratorResume();

        const abort = relay.sent
            .filter((envelope): envelope is Extract<PeerTcpTunnelRelayEnvelope, { v: 2 }> => envelope.v === 2)
            .map((envelope) => decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: 64 * 1024,
                maxPayloadBytes: 64 * 1024,
            }))
            .find((decoded) => decoded.ok && decoded.header.kind === "abort");
        expect(abort?.ok ? abort.header.reasonCode : null).toBe("ack_sequence_invalid");
    });

    it("keeps read and write half-closes independent and rejects writes after endWrite", async () => {
        const mod = await loadPreviewTunnelModule();
        if (!mod?.createLocalServicePreviewTunnelOpener) throw new Error("preview tunnel module unavailable");
        const keyPair = tweetnacl.sign.keyPair();
        const relay = createRelayHarness();
        const stream = await mod.createLocalServicePreviewTunnelOpener({
            env: {
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            resolvePreviewAccountId: () => "account_1",
            createRelayTransport: relay.createTransport,
        })({ preview });
        const open = relay.sent[1];
        if (!open || open.v !== 2) throw new Error("substream open missing");
        const decodedOpen = decodePeerTcpTunnelBinaryFrameV2({
            frame: open.frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        });
        if (!decodedOpen.ok || !decodedOpen.header.substreamId) throw new Error("substream open invalid");

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
                    tunnelId: decodedOpen.header.tunnelId,
                    substreamId: decodedOpen.header.substreamId,
                    direction: "daemon_to_client",
                    halfClose: true,
                    reasonCode: "response_complete",
                    payloadLength: 0,
                },
            }),
        });

        await expect(stream.read()[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined });
        await stream.write(new Uint8Array([7]));
        expect(clientToDaemonDataPayloads(relay.sent, decodedOpen.header.substreamId)).toHaveLength(1);

        await stream.endWrite();
        await expect(stream.write(new Uint8Array([8]))).rejects.toMatchObject({
            reasonCode: "tunnel_closed",
        });
    });
});
