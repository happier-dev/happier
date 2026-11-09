import type { Server, Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT } from "@happier-dev/protocol/sessions";
import { createSessionHumanPresenceService } from "./sessionHumanPresenceService";
import {
    registerSessionHumanPresenceSocketHandlers,
    releaseSessionHumanPresenceHoldAfterFinalCurrentness,
} from "./registerSessionHumanPresenceSocketHandlers";

const visibleEvent = "session-human-presence:visible-replace";
const typingEvent = "session-human-presence:typing-set";
const presenceRoomPrefix = "session-human-presence:";

/**
 * Minimal fixture of the genuine Socket.IO transport boundary. All presence
 * admission, access resolution, room and projection logic below runs for real
 * against the sqlite harness; only the engine's socket registry is simulated.
 */
type PresenceSocketFixture = {
    id: string;
    connected: boolean;
    data: Socket["data"];
    rooms: Set<string>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    join(rooms: string | readonly string[]): Promise<void>;
    leave(room: string): Promise<void>;
    dispatch(event: string, ...args: unknown[]): void;
};

function createPresenceSocketFixture(params: Readonly<{ id: string; accountId: string }>): PresenceSocketFixture {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
        id: params.id,
        connected: true,
        data: { clientType: "user-scoped", userId: params.accountId, authAuthority: "present_user" },
        rooms: new Set<string>(),
        on(event, listener) {
            const existing = listeners.get(event) ?? [];
            existing.push(listener);
            listeners.set(event, existing);
        },
        dispatch(event, ...args) {
            for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
        },
        async join(rooms) {
            for (const room of Array.isArray(rooms) ? rooms : [rooms]) this.rooms.add(room);
        },
        async leave(room) {
            this.rooms.delete(room);
        },
    };
}

function createFixtureIo(allSockets: readonly PresenceSocketFixture[]): {
    io: Server;
    emissions: Array<{ event: string; payload: unknown; socketIds: readonly string[] }>;
} {
    const emissions: Array<{ event: string; payload: unknown; socketIds: readonly string[] }> = [];
    const io = {
        in(room: string) {
            return {
                fetchSockets: async () => allSockets.filter(socket => socket.rooms.has(room)),
            };
        },
        to(socketIds: string | readonly string[]) {
            const ids = Array.isArray(socketIds) ? [...socketIds] : [socketIds];
            return {
                emit: (event: string, payload: unknown) => {
                    emissions.push({ event, payload, socketIds: ids });
                },
            };
        },
        sockets: {
            sockets: new Map<string, Socket>(allSockets.map(socket => [socket.id, socket as unknown as Socket])),
            adapter: undefined,
        },
    };
    return { io: io as unknown as Server, emissions };
}

function registerAdmittedSocket(params: Readonly<{
    presence: ReturnType<typeof createSessionHumanPresenceService>;
    sockets: PresenceSocketFixture[];
    id: string;
    accountId: string;
}>): PresenceSocketFixture {
    const socket = createPresenceSocketFixture({ id: params.id, accountId: params.accountId });
    params.sockets.push(socket);
    registerSessionHumanPresenceSocketHandlers({
        presence: params.presence,
        socket: socket as unknown as Socket,
        accountId: params.accountId,
    });
    return socket;
}

describe("human presence final socket-currentness gate", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-human-presence-currentness-", initAuth: true, initEncrypt: true,
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("withholds the held declaration until final currentness, then admits only the latest one", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), name: "Gate Owner" } });
        const [sessionA, sessionB] = await Promise.all([1, 2].map(() => db.session.create({
            data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}" },
        })));
        const sockets: PresenceSocketFixture[] = [];
        const { io, emissions } = createFixtureIo(sockets);
        const presence = createSessionHumanPresenceService({ io });
        try {
            const socket = registerAdmittedSocket({ presence, sockets, id: "gate-socket", accountId: owner.id });

            // The handler is installed before the handshake completes, so the first
            // replacement may arrive while the connection callback's final currentness
            // check is still in flight. Nothing may be acknowledged, admitted, typed,
            // or projected during that hold.
            const firstAck = vi.fn();
            const secondAck = vi.fn();
            socket.dispatch(visibleEvent, { v: 1, sessionIds: [sessionA.id], pendingMessageEdits: [{ sessionId: sessionA.id, holdId: "superseded" }] }, firstAck);
            socket.dispatch(visibleEvent, { v: 1, sessionIds: [sessionB.id], pendingMessageEdits: [{ sessionId: sessionB.id, holdId: "current" }] }, secondAck);
            socket.dispatch(typingEvent, { v: 1, sessionId: sessionB.id, typing: true });
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(firstAck).not.toHaveBeenCalled();
            expect(secondAck).not.toHaveBeenCalled();
            expect([...socket.rooms].filter(room => room.startsWith(presenceRoomPrefix))).toEqual([]);
            expect(emissions).toEqual([]);
            expect(socket.data.humanPresenceTypingSessionId).toBeUndefined();
            expect(socket.data.humanPresencePendingMessageEdits).toBeUndefined();

            // Final currentness succeeded: only the latest held declaration is
            // processed through the ordinary admitted path, exactly once.
            releaseSessionHumanPresenceHoldAfterFinalCurrentness(socket as unknown as Socket);
            await expect.poll(() => secondAck).toHaveBeenCalledTimes(1);
            expect(secondAck).toHaveBeenCalledWith({ v: 1, ok: true, admittedSessionIds: [sessionB.id],
                admittedPendingMessageEdits: [{ sessionId: sessionB.id, holdId: "current" }] });
            expect(firstAck).not.toHaveBeenCalled();
            expect(socket.rooms.has(presenceRoomPrefix + sessionB.id)).toBe(true);
            expect(socket.rooms.has(presenceRoomPrefix + sessionA.id)).toBe(false);
            expect(socket.data.humanPresenceTypingSessionId).toBeUndefined();
            await expect.poll(() => emissions.filter(entry => entry.event === SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT && (entry.payload as { sessionId: string }).sessionId === sessionB.id)).toHaveLength(1);
            expect(emissions.some(entry => (entry.payload as { sessionId?: string }).sessionId === sessionA.id)).toBe(false);
            const snapshot = emissions.map(entry => entry.payload as { sessionId?: string; viewers?: Array<{ account: { accountId: string }; typing: boolean }> })
                .find(value => value.sessionId === sessionB.id);
            expect(snapshot?.viewers).toEqual([
                { account: expect.objectContaining({ accountId: owner.id }), typing: false },
            ]);
        } finally {
            presence.close();
        }
    }, 30_000);

    it("discards a held declaration when final currentness fails and the socket disconnects", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), name: "Revoked Owner" } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}" },
        });
        const sockets: PresenceSocketFixture[] = [];
        const { io, emissions } = createFixtureIo(sockets);
        const presence = createSessionHumanPresenceService({ io });
        try {
            const socket = registerAdmittedSocket({ presence, sockets, id: "failing-socket", accountId: owner.id });
            const ack = vi.fn();
            socket.dispatch(visibleEvent, { v: 1, sessionIds: [session.id] }, ack);
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(ack).not.toHaveBeenCalled();

            // The connection callback's final currentness check fails and disconnects
            // the socket before the hold is ever released.
            socket.dispatch("disconnecting");
            socket.connected = false;
            socket.dispatch("disconnect");
            releaseSessionHumanPresenceHoldAfterFinalCurrentness(socket as unknown as Socket);
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(ack).not.toHaveBeenCalled();
            expect([...socket.rooms].filter(room => room.startsWith(presenceRoomPrefix))).toEqual([]);
            expect(emissions).toEqual([]);
        } finally {
            presence.close();
        }
    }, 30_000);
});
