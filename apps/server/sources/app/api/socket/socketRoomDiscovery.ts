import { randomUUID } from 'node:crypto';
import { Server, type BroadcastOperator, type Socket } from 'socket.io';
import { ClusterAdapter } from 'socket.io-adapter';
import { z } from 'zod';

const QUERY_EVENT = 'happier:socket-room:query:v1';
const RESPONSE_PREFIX = 'happier:socket-room:response:';
const JOIN_EVENT = 'happier:socket-room:joined:v1';
const joinedSchema = z.object({ room: z.string().startsWith('rpc:') }).strict();
const roomJoinSubscribers = new WeakMap<Server, Map<string, Set<() => void>>>();

/** Hints only: subscribers still discover and authorize targets through the census owner. */
export function subscribeToSocketRoomJoins(io: Server, room: string, listener: () => void): () => void {
    let rooms = roomJoinSubscribers.get(io);
    if (!rooms) { rooms = new Map(); roomJoinSubscribers.set(io, rooms); }
    let listeners = rooms.get(room);
    if (!listeners) { listeners = new Set(); rooms.set(room, listeners); }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) rooms.delete(room);
    };
}
const roomSelectionSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const querySchema = z.object({
    room: roomSelectionSchema,
    responseEvent: z.string().regex(/^happier:socket-room:response:[0-9a-f-]{36}$/),
}).strict();
const answerSchema = z.object({
    room: roomSelectionSchema,
    sockets: z.array(z.object({ id: z.string().min(1), data: z.record(z.string(), z.unknown()) }).strict()),
}).strict();

export interface SocketRoomCarrier {
    readonly data?: unknown;
}

interface SocketRoomOperator {
    fetchSockets(): Promise<readonly SocketRoomCarrier[]>;
    timeout?(ms: number): SocketRoomOperator;
}

export interface SocketRoomDiscoveryServer {
    in(room: string | string[]): SocketRoomOperator;
}

export interface SocketRoomSnapshot {
    readonly sockets: readonly SocketRoomCarrier[];
    readonly complete: boolean;
    readonly error?: unknown;
}

export function readLocalSocketRoom(io: Server, room: string | string[]): Socket[] {
    const ids = typeof room === 'string' ? io.sockets.adapter.rooms.get(room) ?? []
        : new Set(room.flatMap(selected => [...(io.sockets.adapter.rooms.get(selected) ?? [])]));
    return [...ids].flatMap(id => {
        const socket = io.sockets.sockets.get(id);
        return socket?.connected ? [socket] : [];
    });
}

/** Positive replies supplement the adapter census; they never establish absence or uniqueness. */
export function registerSocketRoomDiscovery(io: Server): void {
    const notify = (room: string) => {
        for (const listener of roomJoinSubscribers.get(io)?.get(room) ?? []) listener();
    };
    io.sockets.adapter.on('join-room', (room: string) => {
        // Only RPC method rooms have a waiting consumer. Socket ids/Account rooms
        // and Machine availability projections do not create another hint stream.
        if (!room.startsWith('rpc:')) return;
        notify(room);
        if (io.sockets.adapter instanceof ClusterAdapter) io.serverSideEmit(JOIN_EVENT, { room });
    });
    io.on(JOIN_EVENT, (raw: unknown) => {
        const joined = joinedSchema.safeParse(raw);
        if (joined.success) notify(joined.data.room);
    });
    io.on(QUERY_EVENT, (raw: unknown) => {
        const query = querySchema.safeParse(raw);
        if (!query.success) return;
        const { room, responseEvent } = query.data;
        const sockets = readLocalSocketRoom(io, room).map(socket => ({ id: socket.id, data: socket.data }));
        // Empty peers add no positive evidence; the original census owns negative facts.
        if (sockets.length > 0) io.serverSideEmit(responseEvent, { room, sockets });
    });
}

function remoteCarrier(io: Server, details: z.infer<typeof answerSchema>['sockets'][number]) {
    // Socket.IO declares BroadcastOperator publicly but does not export its constructor
    // at runtime. Obtain that same constructor from its public room operator, keeping
    // exact-socket ACK/cancellation semantics in Socket.IO rather than reimplementing them.
    const Operator = io.to(details.id).constructor as typeof BroadcastOperator;
    const operator = new Operator(io.sockets.adapter, new Set([details.id]), new Set(), { expectSingleResponse: true });
    return { ...details, timeout: operator.timeout.bind(operator) };
}

/**
 * The original fetch owns completion and its unchanged deadline, including replies from older
 * servers. Current peers additionally stream their room members, since ClusterAdapter discards
 * accumulated fetchSockets replies on timeout. No failed census can prove a negative fact.
 */
export async function readSocketRoomSnapshot(params: Readonly<{
    io: SocketRoomDiscoveryServer;
    room: string | string[];
    timeoutMs?: number;
    acceptPartial?: (sockets: readonly SocketRoomCarrier[]) => Promise<boolean>;
}>): Promise<SocketRoomSnapshot> {
    const { io, room } = params;
    const query = io.in(room);
    const fetch = () => typeof params.timeoutMs === 'number' && params.timeoutMs > 0 && query.timeout
        ? query.timeout(params.timeoutMs).fetchSockets() : query.fetchSockets();
    // Minimal adapter consumers can still use the existing fetch contract. The product
    // Socket.IO Server installs the streaming responder at its composition root.
    if (!(io instanceof Server) || !(io.sockets.adapter instanceof ClusterAdapter)) {
        return { sockets: await fetch(), complete: true };
    }

    const sockets = new Map<string, SocketRoomCarrier>(readLocalSocketRoom(io, room).map(socket => [socket.id, socket]));
    if (params.acceptPartial && await params.acceptPartial([...sockets.values()])) {
        return { sockets: [...sockets.values()], complete: false };
    }
    const responseEvent = `${RESPONSE_PREFIX}${randomUUID()}`;
    let pending = Promise.resolve();
    let onAnswer: ((raw: unknown) => void) | undefined;
    try {
        return await new Promise<SocketRoomSnapshot>((resolve, reject) => {
            let settled = false;
            const finish = (snapshot: SocketRoomSnapshot) => {
                if (settled) return;
                settled = true;
                resolve(snapshot);
            };
            onAnswer = raw => {
                if (settled) return;
                const answer = answerSchema.safeParse(raw);
                if (!answer.success) return;
                const sameRooms = typeof room === 'string' ? answer.data.room === room
                    : Array.isArray(answer.data.room) && answer.data.room.length === room.length
                        && room.every((selected, index) => answer.data.room[index] === selected);
                if (!sameRooms) return;
                for (const details of answer.data.sockets) sockets.set(details.id, remoteCarrier(io, details));
                pending = pending.then(async () => {
                    if (!settled && params.acceptPartial && await params.acceptPartial([...sockets.values()])) {
                        finish({ sockets: [...sockets.values()], complete: false });
                    }
                }).catch(reject);
            };
            io.on(responseEvent, onAnswer);
            void fetch().then(
                result => pending.then(() => finish({ sockets: result, complete: true })),
                error => pending.then(() => finish({ sockets: [...sockets.values()], complete: false, error })),
            ).catch(reject);
            io.serverSideEmit(QUERY_EVENT, { room, responseEvent });
        });
    } finally {
        if (onAnswer) io.off(responseEvent, onAnswer);
    }
}
