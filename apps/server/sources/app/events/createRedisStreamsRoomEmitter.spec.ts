import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { RedisStreamsRoomEmitter } from "./createRedisStreamsRoomEmitter";
import { CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, parseCredentialQualifiedSessionDelivery } from "./socketRoomEmitter";

describe("Redis Streams room emitter", () => {
    it("publishes the adapter disconnect contract for all selected rooms", () => {
        // Redis is the external transport. Installed socket.io-adapter uses
        // cluster message type 6 for DISCONNECT_SOCKETS.
        const xadd = vi.fn(async (..._args: Array<string | number>) => "1-0");
        // The fixture implements only the exercised overload of ioredis' external boundary.
        const redis = { xadd } as unknown as Pick<Redis, "xadd">;
        const emitter = new RedisStreamsRoomEmitter(redis, { maxLen: 100, streamName: "test-stream" });
        emitter.to(["user:account", "user-machines:account"]).disconnectSockets(true);
        const args = xadd.mock.calls[0];
        const fields = Object.fromEntries(Array.from({ length: (args.length - 5) / 2 }, (_, index) => [args[5 + index * 2], args[6 + index * 2]]));
        expect(fields.type).toBe("6");
        expect(JSON.parse(String(fields.data))).toEqual({
            opts: { rooms: ["user:account", "user-machines:account"], except: [], flags: {} },
            close: true,
        });
    });

    it("preserves the Session broadcast event through room and credential-qualified forwarding", async () => {
        const xadd = vi.fn(async (..._args: Array<string | number>) => "1-0");
        const redis = { xadd } as unknown as Pick<Redis, "xadd">;
        const emitter = new RedisStreamsRoomEmitter(redis, { maxLen: 100, streamName: "test-stream" });
        const payload = {
            id: "wake-1",
            createdAt: 1,
            body: { t: "session-changed", sessionId: "destination-session" },
        };

        emitter.to("session:destination-session:account").emit("session", payload);
        await emitter.serverSideEmit(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, {
            v: 1,
            accountId: "account",
            sessionId: "destination-session",
            eventName: "session",
            payload,
        });

        const roomFields = Object.fromEntries(xadd.mock.calls[0]!.slice(5).reduce<Array<[unknown, unknown]>>(
            (pairs, value, index, values) => index % 2 === 0 ? [...pairs, [value, values[index + 1]]] : pairs,
            [],
        ));
        expect(JSON.parse(String(roomFields.data)).packet.data).toEqual(["session", payload]);

        const forwardedFields = Object.fromEntries(xadd.mock.calls[1]!.slice(5).reduce<Array<[unknown, unknown]>>(
            (pairs, value, index, values) => index % 2 === 0 ? [...pairs, [value, values[index + 1]]] : pairs,
            [],
        ));
        const forwarded = JSON.parse(String(forwardedFields.data)).packet[1];
        expect(parseCredentialQualifiedSessionDelivery(forwarded)).toEqual({
            v: 1,
            accountId: "account",
            sessionId: "destination-session",
            eventName: "session",
            payload,
        });
    });
});
