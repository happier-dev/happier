import type { Socket } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import { transcriptInterestRoom } from "../socketRooms";
import { registerTranscriptInterestSocketEvent } from "./registerTranscriptInterestSocketEvent";

type InterestSetHandler = (input: unknown, ack?: (response: unknown) => void) => Promise<void>;

function createInterestSocket(data: Record<string, unknown>) {
    const roomCalls: string[] = [];
    // Boundary fixture: Socket.IO's socket surface used by the event (registration + room membership).
    const socket = {
        data,
        on: vi.fn(),
        join: vi.fn(async (room: string) => { roomCalls.push(`join:${room}`); }),
        leave: vi.fn(async (room: string) => { roomCalls.push(`leave:${room}`); }),
    };
    registerTranscriptInterestSocketEvent(socket as unknown as Socket);
    const registration = socket.on.mock.calls.find(([event]) => event === 'transcript-interest:set') as
        | [string, InterestSetHandler]
        | undefined;
    if (!registration) throw new Error('transcript-interest:set was not registered');
    const set = async (input: unknown) => {
        const ack = vi.fn();
        await registration[1](input, ack);
        return ack.mock.calls[0]?.[0] as unknown;
    };
    return { roomCalls, set };
}

/** Fresh per socket: the event keeps the current set on the socket's own data bag. */
const declaredData = () => ({ userId: 'u1', clientType: 'user-scoped', clientPurpose: 'sync', transcriptInterestDeclared: true });

describe("registerTranscriptInterestSocketEvent", () => {
    it("replaces the whole room set and joins new sessions before leaving dropped ones", async () => {
        const { roomCalls, set } = createInterestSocket(declaredData());

        expect(await set({ sessionIds: ['a'] })).toEqual({ ok: true });
        // A session kept in both sets is neither re-joined nor left.
        expect(await set({ sessionIds: ['a', 'b'] })).toEqual({ ok: true });
        expect(await set({ sessionIds: ['c', 'b'] })).toEqual({ ok: true });

        expect(roomCalls).toEqual([
            `join:${transcriptInterestRoom('u1', 'a')}`,
            `join:${transcriptInterestRoom('u1', 'b')}`,
            `join:${transcriptInterestRoom('u1', 'c')}`,
            `leave:${transcriptInterestRoom('u1', 'a')}`,
        ]);
    });

    it("refuses malformed sets and undeclared sockets without touching room membership", async () => {
        const undeclared = createInterestSocket({ userId: 'u1', clientType: 'user-scoped', clientPurpose: 'sync' });
        expect(await undeclared.set({ sessionIds: ['a'] })).toEqual({ ok: false, error: 'not-allowed' });
        expect(undeclared.roomCalls).toEqual([]);

        const { roomCalls, set } = createInterestSocket(declaredData());
        expect(await set({ sessionIds: ['a'] })).toEqual({ ok: true });
        for (const input of [{ sessionIds: ['a', 7] }, { sessionIds: 'a' }, { sessionIds: ['a'], extra: true }, null]) {
            expect(await set(input)).toEqual({ ok: false, error: 'invalid-payload' });
        }
        expect(roomCalls).toEqual([`join:${transcriptInterestRoom('u1', 'a')}`]);

        // A refused update did not replace the remembered set: the next valid set still leaves only what it dropped.
        expect(await set({ sessionIds: ['b'] })).toEqual({ ok: true });
        expect(roomCalls.slice(1)).toEqual([
            `join:${transcriptInterestRoom('u1', 'b')}`,
            `leave:${transcriptInterestRoom('u1', 'a')}`,
        ]);
    });
});
