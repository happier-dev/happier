import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { mintPeerTcpTunnelRelayAuthorizationV2 } from "@/app/machines/peer/mediation/tunnel";
import { registerPeerTcpTunnelRelaySocketHandler } from "./registerRelay";
import { createPeerTcpTunnelRelayBridge } from "./relayBridge";

type EmitCall = Readonly<{ room: string; event: string; payload: unknown }>;

function createRecordingIo(): Readonly<{
    io: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
    calls: EmitCall[];
}> {
    const calls: EmitCall[] = [];
    return {
        calls,
        io: {
            to: (room: string) => ({
                emit: (event: string, payload: unknown) => {
                    calls.push({ room, event, payload });
                },
            }),
        },
    };
}

function tunnelOpenFrame() {
    return {
        kind: "open" as const,
        direction: "client_to_daemon" as const,
        open: {
            kind: "open" as const,
            tunnelId: "tunnel-1",
            substreamId: 1,
            routeKind: "loopback_direct" as const,
            targetMachineId: "machine-1",
            destination: { host: "127.0.0.1", port: 5173 },
        },
    };
}

describe("createPeerTcpTunnelRelayBridge.createTransport.send", () => {
    it("does not bypass exact relay attachment ownership for machine-recipient frames", () => {
        const { io, calls } = createRecordingIo();
        const bridge = createPeerTcpTunnelRelayBridge(io);
        const transport = bridge.createTransport({ accountId: "user-1" });

        const envelope = {
            v: 1,
            scopeUserId: "user-1",
            sender: { kind: "user", socketId: "viewer-socket-1" },
            recipient: { kind: "machine", machineId: "machine-1" },
            frame: tunnelOpenFrame(),
        } as unknown as PeerTcpTunnelRelayEnvelope;

        transport.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);

        expect(calls.filter((c) => c.event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT)).toEqual([]);
    });

    it("delivers user-recipient frames to the targeted viewer socket, not the whole-user room", () => {
        const { io, calls } = createRecordingIo();
        const bridge = createPeerTcpTunnelRelayBridge(io);
        const transport = bridge.createTransport({ accountId: "user-1" });

        const envelope = {
            v: 1,
            scopeUserId: "user-1",
            sender: { kind: "machine", machineId: "machine-1" },
            recipient: { kind: "user", socketId: "viewer-socket-1" },
            frame: { ...tunnelOpenFrame(), direction: "daemon_to_client" },
        } as unknown as PeerTcpTunnelRelayEnvelope;

        transport.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);

        const rooms = calls.filter((c) => c.event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT).map((c) => c.room);
        expect(rooms).toEqual(["viewer-socket-1"]);
        expect(rooms).not.toContain("user:user-1");
    });

    it("subscribed local listeners receive only frames targeted to their pseudo socket id", () => {
        const { io } = createRecordingIo();
        const bridge = createPeerTcpTunnelRelayBridge(io);
        const transport = bridge.createTransport({ accountId: "user-1" });
        const received = vi.fn();
        const unsubscribe = transport.subscribe(received);

        bridge.io.to(transport.relaySocketId).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, { hello: "world" });
        expect(received).toHaveBeenCalledTimes(1);

        unsubscribe();
        transport.close();
    });

    it("routes a signed pseudo-socket tunnel response back to only that preview transport", async () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
        const { io } = createRecordingIo();
        const bridge = createPeerTcpTunnelRelayBridge(io);
        const transport = bridge.createTransport({ accountId: "user-1" });
        const otherAccountTransport = bridge.createTransport({ accountId: "user-2" });
        const received = vi.fn();
        const otherAccountReceived = vi.fn();
        transport.subscribe(received);
        otherAccountTransport.subscribe(otherAccountReceived);

        const pseudoHandlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
        registerPeerTcpTunnelRelaySocketHandler("user-1", {
            id: transport.relaySocketId,
            data: { clientType: "user-scoped" },
            on: (event, handler) => pseudoHandlers.set(event, handler),
            emit: () => undefined,
        }, {
            io: bridge.io,
            nowMs: () => 1_000,
            serverRoutedEnabled: true,
            allowedPorts: [5173],
            relayAuthorizationTrustRoots: [{
                keyId: "relay-key-1",
                publicKeyBase64Url: Buffer.from(keyPair.publicKey).toString("base64url"),
            }],
        });

        const machineHandlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
        registerPeerTcpTunnelRelaySocketHandler("user-1", {
            id: "machine-socket-1",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            on: (event, handler) => machineHandlers.set(event, handler),
            emit: () => undefined,
        }, {
            io: bridge.io,
            nowMs: () => 1_000,
            serverRoutedEnabled: true,
            allowedPorts: [5173],
            relayAuthorizationTrustRoots: [],
        });

        const minted = mintPeerTcpTunnelRelayAuthorizationV2({
            accountId: "user-1",
            targetMachineId: "machine-1",
            relaySocketId: transport.relaySocketId,
            destination: { host: "127.0.0.1", port: 5173 },
            scope: {
                kind: "tcp_tunnel",
                tunnelId: "preview-tunnel-1",
                allowedPorts: [5173],
                maxIdleMs: 30_000,
                maxDurationMs: 60_000,
            },
            nowMs: 1_000,
            ttlMs: 60_000,
            serverGateEnabled: true,
            serverCaps: {
                allowedPorts: [5173],
                maxBytes: 64 * 1024,
                maxFrameBytes: 64 * 1024,
                maxIdleMs: 30_000,
                maxDurationMs: 60_000,
            },
            signingKey: { keyId: "relay-key-1", secretKey: keyPair.secretKey },
        });
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        await pseudoHandlers.get(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT)?.({
            v: 1,
            scopeUserId: "user-1",
            sender: { kind: "user", socketId: transport.relaySocketId },
            recipient: { kind: "machine", machineId: "machine-1" },
            frame: {
                v: 1,
                kind: "open",
                open: {
                    v: 1,
                    kind: "open",
                    tunnelId: "preview-tunnel-1",
                    targetMachineId: "machine-1",
                    routeKind: "server_relay",
                    destination: { host: "127.0.0.1", port: 5173 },
                    relayAuthorization: minted.relayAuthorization,
                },
            },
        });
        await machineHandlers.get(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT)?.({
            v: 1,
            scopeUserId: "user-1",
            sender: { kind: "machine", machineId: "machine-1" },
            recipient: { kind: "user", socketId: transport.relaySocketId },
            frame: {
                v: 1,
                kind: "data",
                tunnelId: "preview-tunnel-1",
                direction: "daemon_to_client",
                sequence: 0,
                payloadBase64: Buffer.from("preview response").toString("base64"),
            },
        });

        expect(received).toHaveBeenCalledWith(expect.objectContaining({
            recipient: { kind: "user", socketId: transport.relaySocketId },
            frame: expect.objectContaining({ kind: "data", tunnelId: "preview-tunnel-1" }),
        }));
        expect(otherAccountReceived).not.toHaveBeenCalled();

        transport.close();
        bridge.io.to(transport.relaySocketId).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, { afterClose: true });
        expect(received).toHaveBeenCalledTimes(1);
        await pseudoHandlers.get("disconnect")?.();
        await machineHandlers.get("disconnect")?.();
        otherAccountTransport.close();
    });
});
