import type { Socket } from "socket.io";
import { SessionConsumptionReplaceV1Schema, type SessionConsumptionReplaceAckV1 } from "@happier-dev/protocol";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import type { SessionTranscriptPublicationFields } from "@/app/session/sessionTranscriptPublicationPolicy";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import type { Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { retireSessionBrowserLiveStreamsAfterAccessChange } from './machineLiveStreamRelayHandler';

interface SessionSocketConsumption {
    liveSessionIds: ReadonlySet<string>;
    durableSessionIds: ReadonlySet<string>;
}

/** UI consumers receive live segments only through demand this owner admitted. */
export function isUiConsumptionSocket(data: Socket["data"]): boolean {
    return data.clientType === "user-scoped"
        && (data.clientPurpose === "sync" || data.clientPurpose === "concurrent-server-cache");
}

/**
 * The app's sync socket applies a durable message revision as an append against the revision it
 * holds (and reads the full message when it does not). Other consumers receive full rows.
 */
export function appliesDurableMessageAppends(data: Socket["data"]): boolean {
    return data.clientType === "user-scoped" && data.clientPurpose === "sync";
}

// One ordered lane per socket: declarations and access-change retirement never
// interleave, so a declaration admitted before a revocation cannot outlive it.
const consumptionLanes = new WeakMap<Socket, Promise<void>>();

function enqueueConsumptionWork(socket: Socket, work: () => Promise<void>): Promise<void> {
    const next = (consumptionLanes.get(socket) ?? Promise.resolve()).then(work);
    consumptionLanes.set(socket, next.catch(() => {}));
    return next;
}

export type SessionPublicationAudience = Readonly<{
    publication: SessionTranscriptPublicationFields;
    recipientAccountIds: readonly string[];
}>;

// A held read stays the pending promise from its start, so a push that lands while
// it is in flight retires it and the next event reads the committed change.
const heldPublicationAudiences = new WeakMap<Socket, Readonly<{ sessionId: string; audience: Promise<SessionPublicationAudience> }>>();
// Keyed by socket data, the one object a Socket and its fetched projection share.
const heldLiveDeliveryDecisions = new WeakMap<object, Map<string, Promise<boolean>>>();

/**
 * One publisher socket's audience, read once and held until the committed access
 * change retires it or a new segment opens. The push is at-most-once across API
 * nodes, so `opensSegment` bounds a lost push to the rest of the current segment.
 * A failed read is not held, so that event delivers nothing.
 */
export function holdSessionPublicationAudience(
    socket: Socket,
    sessionId: string,
    opensSegment: boolean,
    read: () => Promise<SessionPublicationAudience>,
): Promise<SessionPublicationAudience> {
    const current = heldPublicationAudiences.get(socket);
    if (!opensSegment && current?.sessionId === sessionId) return current.audience;
    const held = { sessionId, audience: read() };
    heldPublicationAudiences.set(socket, held);
    held.audience.catch(() => {
        if (heldPublicationAudiences.get(socket) === held) heldPublicationAudiences.delete(socket);
    });
    return held.audience;
}

/**
 * Whether one socket may receive a publisher's live event. Declared UI demand already
 * decides live segments. Every other case decides the credential once per Session and
 * holds the answer until the access change retires it; a decision that could not be
 * made is not held, so that event is not delivered.
 */
export async function admitLiveSessionDelivery(
    socket: Pick<Socket, "data">,
    accountId: string,
    sessionId: string,
    delivery: "segment" | "execution-run",
): Promise<boolean> {
    if (delivery === "segment") {
        if (isUiConsumptionSocket(socket.data)) return true;
        if (!readSessionSocketConsumption(socket.data, sessionId).liveSegments) return false;
    }
    const decisions = heldLiveDeliveryDecisions.get(socket.data) ?? new Map<string, Promise<boolean>>();
    heldLiveDeliveryDecisions.set(socket.data, decisions);
    const held = decisions.get(sessionId);
    if (held) return held;
    let authentication: ReturnType<typeof readSessionAccessAuthenticationFromSocket>;
    try {
        authentication = readSessionAccessAuthenticationFromSocket(socket);
    } catch {
        // One malformed credential cannot suppress another socket's delivery.
        return false;
    }
    const decision = captureReadSnapshot(async tx => (await resolveSessionAccessForOperation(tx, {
        accountId, sessionId, capability: "readTranscript", authentication,
    })).status === "allowed");
    decisions.set(sessionId, decision);
    try {
        return await decision;
    } catch {
        if (decisions.get(sessionId) === decision) decisions.delete(sessionId);
        return false;
    }
}

/**
 * A refused socket stops consuming this Session: its declared demand and held live
 * answer go together, so the next live event cannot reach it. Reads nothing, because
 * the caller has already decided. Credential-only withdrawals have no Session push;
 * the durable delivery that refuses the credential is their natural boundary.
 */
export function withdrawSessionConsumption(socket: Pick<Socket, "data">, sessionId: string): void {
    heldLiveDeliveryDecisions.get(socket.data)?.delete(sessionId);
    const current: SessionSocketConsumption | undefined = socket.data.sessionConsumption;
    if (!current) return;
    socket.data.sessionConsumption = {
        liveSessionIds: new Set([...current.liveSessionIds].filter(id => id !== sessionId)),
        durableSessionIds: new Set([...current.durableSessionIds].filter(id => id !== sessionId)),
    } satisfies SessionSocketConsumption;
}

/** Audience admission is separate: this only selects delivery for an admitted socket. */
export function readSessionSocketConsumption(data: Socket["data"], sessionId: string): {
    durableBodies: boolean;
    liveSegments: boolean;
} {
    // The pooled UI RPC carrier has no transcript consumer or declaration.
    if (data.clientType === "user-scoped" && data.clientPurpose === "scoped-rpc") {
        return { durableBodies: false, liveSegments: false };
    }
    if (!isUiConsumptionSocket(data)) return { durableBodies: true, liveSegments: true };
    const consumption: SessionSocketConsumption | undefined = data.sessionConsumption;
    const liveSegments = consumption?.liveSessionIds.has(sessionId) === true;
    return { liveSegments, durableBodies: liveSegments || consumption?.durableSessionIds.has(sessionId) === true };
}

/** A replace belongs to this authenticated socket and expires with its transport. */
export function registerSessionConsumptionSocketEvent(socket: Socket, admission: Promise<boolean>): void {
    socket.on("session-consumption-replace", (input: unknown, acknowledge: unknown) => {
        const reply = (result: SessionConsumptionReplaceAckV1) => {
            if (typeof acknowledge === "function") acknowledge(result);
        };
        const parsed = SessionConsumptionReplaceV1Schema.safeParse(input);
        if (!parsed.success) { reply({ ok: false, error: "invalid_request" }); return; }
        // Preserve the socket's packet order across asynchronous access reads.
        void enqueueConsumptionWork(socket, async () => {
            if (!(await admission) || !socket.connected || !isUiConsumptionSocket(socket.data)) {
                reply({ ok: false, error: "not_allowed" });
                return;
            }
            const accountId = socket.data.userId;
            const requested = [...new Set([...parsed.data.liveSessionIds, ...parsed.data.durableSessionIds])];
            const authorize = async (tx: Tx, ids: readonly string[]) => {
                const admitted: string[] = [];
                for (const sessionId of ids) {
                    const decision = await resolveSessionAccessForOperation(tx, {
                        accountId, sessionId, capability: "readTranscript",
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                    });
                    if (decision.status === "allowed") admitted.push(sessionId);
                }
                return admitted;
            };
            const admitted = new Set(await captureReadSnapshot(
                tx => authorize(tx, requested),
            ));
            if (!socket.connected || !isUiConsumptionSocket(socket.data) || socket.data.userId !== accountId) {
                reply({ ok: false, error: "not_allowed" });
                return;
            }
            const liveSessionIds = [...new Set(parsed.data.liveSessionIds)].filter(id => admitted.has(id));
            const durableSessionIds = [...new Set(parsed.data.durableSessionIds)].filter(id => admitted.has(id));
            socket.data.sessionConsumption = {
                liveSessionIds: new Set(liveSessionIds), durableSessionIds: new Set(durableSessionIds),
            } satisfies SessionSocketConsumption;
            reply({ ok: true, v: 1, liveSessionIds, durableSessionIds });
        }).catch(error => {
            log({ module: "session-consumption", error }, "Session consumption declaration unavailable");
            reply({ ok: false, error: "unavailable" });
        });
    });
}

/**
 * A live stream is open-ended access, so the committed Session access-change
 * push closes it: publishers re-read their audience and undeclared sockets are
 * decided again on their next event, and each local UI consumer still declaring
 * this Session is re-admitted once, a refused credential losing that demand.
 * Nothing re-checks per delivered event. A consumer that cannot be re-admitted
 * is disconnected, so it cannot outlive a withdrawal and reconnect re-admits it.
 */
export function retireSessionConsumptionAfterAccessChange(sockets: Iterable<Socket>, sessionId: string): void {
    retireSessionBrowserLiveStreamsAfterAccessChange(sessionId);
    for (const socket of sockets) {
        if (heldPublicationAudiences.get(socket)?.sessionId === sessionId) heldPublicationAudiences.delete(socket);
        heldLiveDeliveryDecisions.get(socket.data)?.delete(sessionId);
        if (!isUiConsumptionSocket(socket.data)) continue;
        void enqueueConsumptionWork(socket, async () => {
            const consumption: SessionSocketConsumption | undefined = socket.data.sessionConsumption;
            if (!consumption || !socket.connected
                || (!consumption.liveSessionIds.has(sessionId) && !consumption.durableSessionIds.has(sessionId))) return;
            const decision = await captureReadSnapshot(tx => resolveSessionAccessForOperation(tx, {
                accountId: socket.data.userId, sessionId, capability: "readTranscript",
                authentication: readSessionAccessAuthenticationFromSocket(socket),
            }));
            if (decision.status !== "allowed") withdrawSessionConsumption(socket, sessionId);
        }).catch(error => {
            log({ module: "session-consumption", error }, "Session consumption retirement unavailable");
            socket.disconnect(true);
        });
    }
}
