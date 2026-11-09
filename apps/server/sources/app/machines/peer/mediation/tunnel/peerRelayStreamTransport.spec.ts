import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
} from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";

import { createPeerTcpTunnelRelayStream } from "./peerRelayStreamTransport";

describe("createPeerTcpTunnelRelayStream", () => {
    it("distinguishes remote abort and parent loss from clean directional EOF", async () => {
        for (const terminal of ["abort", "parent"] as const) {
            const substream = createPeerTcpTunnelRelayStream({
                tunnelId: "tunnel-1", substreamId: "substream-1", initialWindowBytes: 1024,
                maxFrameBytes: 64 * 1024, maxDecodedPayloadBytes: 1024, maxSendChunkBytes: 1024,
                sendEncodedBinaryFrame() {}, onRelease() {},
            });
            const read = substream.stream.read()[Symbol.asyncIterator]();
            const pending = read.next();
            const rejection = expect(pending).rejects.toThrow(terminal === "abort" ? "upstream_failed" : "tunnel_closed");
            if (terminal === "parent") substream.closeFromTunnel();
            else substream.acceptEnvelope({
                v: 2, scopeUserId: "account", sender: { kind: "machine", machineId: "machine" }, recipient: { kind: "user" },
                encoding: "binary_frame_v2", frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                    version: 2, kind: "abort", tunnelId: "tunnel-1", substreamId: "substream-1", reasonCode: "upstream_failed", payloadLength: 0,
                } }),
            });
            await rejection;
        }
    });

    it("drains queued bytes before half-close but discards unread bytes on consumer cancellation", async () => {
        for (const terminal of ["half-close", "cancel"] as const) {
            const substream = createPeerTcpTunnelRelayStream({
                tunnelId: "tunnel-1", substreamId: "substream-1", initialWindowBytes: 1024,
                maxFrameBytes: 64 * 1024, maxDecodedPayloadBytes: 1024, maxSendChunkBytes: 1024,
                sendEncodedBinaryFrame() {}, onRelease() {},
            });
            const payload = new Uint8Array([1, 2, 3]);
            substream.acceptEnvelope({ v: 2, scopeUserId: "account", sender: { kind: "machine", machineId: "machine" }, recipient: { kind: "user" },
                encoding: "binary_frame_v2", frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                    version: 2, kind: "data", tunnelId: "tunnel-1", substreamId: "substream-1", direction: "daemon_to_client", sequence: 0, payloadLength: payload.byteLength,
                }, payload }),
            });
            if (terminal === "cancel") await substream.stream.close();
            else substream.acceptEnvelope({ v: 2, scopeUserId: "account", sender: { kind: "machine", machineId: "machine" }, recipient: { kind: "user" },
                encoding: "binary_frame_v2", frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                    version: 2, kind: "close", tunnelId: "tunnel-1", substreamId: "substream-1", direction: "daemon_to_client", halfClose: true, reasonCode: "upstream_eof", payloadLength: 0,
                } }),
            });
            const received: Uint8Array[] = [];
            for await (const chunk of substream.stream.read()) received.push(chunk);
            expect(received).toEqual(terminal === "half-close" ? [payload] : []);
            await substream.stream.close();
        }
    });
    it.each(['tunnel_closed', 'application_ended'])("settles a credit-blocked write and retains parent reason %s", async (reasonCode) => {
        const substream = createPeerTcpTunnelRelayStream({
            tunnelId: "tunnel-1",
            substreamId: "substream-1",
            initialWindowBytes: 1,
            maxFrameBytes: 64 * 1024,
            maxDecodedPayloadBytes: 64 * 1024,
            maxSendChunkBytes: 1,
            sendEncodedBinaryFrame: () => undefined,
            onRelease: () => undefined,
        });

        const write = substream.stream.write(new Uint8Array([1, 2]));
        substream.closeFromTunnel(reasonCode);

        await expect(write).resolves.toEqual({ ok: false, reasonCode: "tunnel_closed" });
        expect(substream.readTerminalReasonCode()).toBe(reasonCode);
    });

    it("provides target-neutral framed byte transport while isolating the exact substream", async () => {
        const sentFrames: Uint8Array[] = [];
        const onReleased = vi.fn();
        const substream = createPeerTcpTunnelRelayStream({
            tunnelId: "tunnel-1",
            substreamId: "substream-1",
            initialWindowBytes: 64 * 1024,
            maxFrameBytes: 64 * 1024,
            maxDecodedPayloadBytes: 64 * 1024,
            maxSendChunkBytes: 64 * 1024,
            sendEncodedBinaryFrame: (frame) => {
                sentFrames.push(frame);
            },
            onRelease: onReleased,
        });

        substream.open();
        await expect(substream.stream.write(new TextEncoder().encode("request"))).resolves.toEqual({ ok: true });

        const decodedSent = sentFrames.map((frame) => decodePeerTcpTunnelBinaryFrameV2({
            frame,
            maxHeaderBytes: 64 * 1024,
            maxPayloadBytes: 64 * 1024,
        }));
        expect(decodedSent.map((decoded) => decoded.ok ? decoded.header.kind : null)).toEqual(["open", "data"]);
        expect(decodedSent[1]).toMatchObject({
            ok: true,
            header: {
                tunnelId: "tunnel-1",
                substreamId: "substream-1",
                direction: "client_to_daemon",
            },
        });

        const read = substream.stream.read()[Symbol.asyncIterator]();
        substream.acceptEnvelope({
            v: 2,
            scopeUserId: "account-1",
            sender: { kind: "machine", machineId: "machine-1" },
            recipient: { kind: "user" },
            encoding: "binary_frame_v2",
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "data",
                    tunnelId: "tunnel-1",
                    substreamId: "another-substream",
                    direction: "daemon_to_client",
                    sequence: 0,
                    payloadLength: 7,
                },
                payload: new TextEncoder().encode("ignored"),
            }),
        });
        const response = new TextEncoder().encode("response");
        substream.acceptEnvelope({
            v: 2,
            scopeUserId: "account-1",
            sender: { kind: "machine", machineId: "machine-1" },
            recipient: { kind: "user" },
            encoding: "binary_frame_v2",
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "data",
                    tunnelId: "tunnel-1",
                    substreamId: "substream-1",
                    direction: "daemon_to_client",
                    sequence: 0,
                    payloadLength: response.byteLength,
                },
                payload: response,
            }),
        });

        await expect(read.next()).resolves.toEqual({ done: false, value: response });
        await substream.stream.close();
        expect(onReleased).toHaveBeenCalledTimes(1);
    });
});
