import type { Server, Socket } from "socket.io";
import { z } from "zod/mini";
import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, type SessionHumanPresenceLocationV1, type SessionHumanPresencePendingMessageEditV1, type SessionHumanPresenceSnapshotV1, type SessionHumanPresenceTypingSetV1 } from '@happier-dev/protocol/sessions';
import { type SessionAccessAccountSummaryV1 } from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { DiscussionIdSchema } from '@happier-dev/protocol/discussions/content';
import { db } from "@/storage/db";
import { inReadSnapshot } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, projectAccountDisplayProfileV1, resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import { resolveDiscussionContextInTx, filterDiscussionsWithCurrentReadAccessInTx } from "@/app/discussions/access";
import { projectDiscussionCapabilitiesV1 } from "@/app/discussions/projection";
import { readDiscussionRowInTx } from "@/app/discussions/queries";
import {
    sessionHumanPresenceLocationFromRoom,
    sessionHumanPresenceLocationRoom,
    sessionHumanPresenceLocationsFromRooms,
    type HumanPresenceLocation,
} from "./sessionHumanPresenceRooms";

export const SESSION_HUMAN_PRESENCE_TYPING_LEASE_MS = 6_000;
const PROJECTION_RETRY_MS = 5_000;
// Each query stays below the conservative SQLite 999-bind boundary, including
// the canonical access owner's repeated Account filters. This never truncates a set.
const QUERY_BATCH_SIZE = 100;
type PresenceLocation = HumanPresenceLocation;

function sameLocation(left: PresenceLocation, right: PresenceLocation): boolean {
    return left.sessionId === right.sessionId && left.discussionId === right.discussionId;
}

type PresenceTypingSocketData = Pick<
    Socket['data'],
    'humanPresenceTypingSessionId' | 'humanPresenceTypingDiscussionId'
>;

function readTypingLocation(socket: Readonly<{ data: PresenceTypingSocketData }>): PresenceLocation | null {
    const sessionId = socket.data.humanPresenceTypingSessionId;
    const discussionId = socket.data.humanPresenceTypingDiscussionId;
    return discussionId ? { discussionId } : sessionId ? { sessionId } : null;
}

export const SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT =
    "session-human-presence:access-changed:v1";

const SessionHumanPresenceAccessChangedServerEnvelopeSchema = z.union([
    z.strictObject({ v: z.literal(1), sessionId: z.unknown() }),
    z.strictObject({ v: z.literal(1), discussionId: z.unknown() }),
]);

function parseSessionHumanPresenceAccessChangedServerPayload(raw: unknown): PresenceLocation | null {
    const envelope = SessionHumanPresenceAccessChangedServerEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return null;
    if ("discussionId" in envelope.data) {
        const discussionId = DiscussionIdSchema.safeParse(envelope.data.discussionId);
        return discussionId.success ? { discussionId: discussionId.data } : null;
    }
    const sessionId = SessionIdSchema.safeParse(envelope.data.sessionId);
    return sessionId.success ? { sessionId: sessionId.data } : null;
}

interface AccessChangeListener {
    locationChanged(location: PresenceLocation): void;
    publishLocationChanged?(location: PresenceLocation): void;
}
const accessChangeListeners = new Set<AccessChangeListener>();

/** Anything that can reach the other API nodes' server-side event handlers. */
export interface SessionHumanPresenceClusterPublisher {
    serverSideEmit(eventName: string, payload: unknown): unknown;
}

function publishSessionHumanPresenceAccessChanged(
    publisher: SessionHumanPresenceClusterPublisher,
    location: PresenceLocation,
): void {
    publisher.serverSideEmit(SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT, { v: 1, ...location });
}

/**
 * Publication-only registration for a process that owns no Socket.IO server —
 * the worker role, whose directory reconciliation commits real access
 * transitions. It publishes the same location transition an API node's
 * presence service publishes, and the API nodes' presence owners recheck their
 * rooms on receipt. The `all` and `api` roles publish through their presence
 * service instead, so a process never registers both.
 */
export function registerSessionHumanPresenceAccessChangePublisher(
    publisher: SessionHumanPresenceClusterPublisher,
): () => void {
    const listener: AccessChangeListener = {
        locationChanged: () => {},
        publishLocationChanged: (location) => publishSessionHumanPresenceAccessChanged(publisher, location),
    };
    accessChangeListeners.add(listener);
    return () => { accessChangeListeners.delete(listener); };
}

/**
 * Synchronous afterTx seam. Each live local Socket.IO owner queues its own
 * projection, and one cluster-enabled owner publishes the resource-location
 * transition to peer API nodes.
 *
 * Grant, Team, Group and Account-lifecycle transitions all reach this one entry
 * point through the shared resource access transition owners. The receiving service
 * re-resolves the capability of every live socket in that location's room itself,
 * so no affected Account list is trusted across the seam. Account lifecycle also
 * disconnects a restricted Account's sockets after commit; that is credential
 * revocation, while this transition is the canonical room-wide access recheck.
 */
export function notifySessionHumanPresenceAccessChanged(input: Readonly<{
    sessionId: string;
}>): void {
    notifyHumanPresenceAccessChanged(input);
}

/** Discussion grants schedule the same credential-qualified projection owner. */
export function notifyDiscussionHumanPresenceAccessChanged(input: Readonly<{ discussionId: string }>): void {
    notifyHumanPresenceAccessChanged(input);
}

function notifyHumanPresenceAccessChanged(input: PresenceLocation): void {
    let publishedAcrossCluster = false;
    for (const listener of accessChangeListeners) {
        try {
            listener.locationChanged(input);
            // A production process has one Socket.IO owner, while integration
            // tests can host several. Schedule every local owner, but publish
            // the process transition only once to avoid duplicate cluster work.
            if (!publishedAcrossCluster && listener.publishLocationChanged) {
                listener.publishLocationChanged(input);
                publishedAcrossCluster = true;
            }
        }
        catch (error) { log({ module: "session-human-presence", error }, "Human presence access cleanup unavailable"); }
    }
}

export function createSessionHumanPresenceService(input: Readonly<{
    io: Server;
    clusterAccessChangePublicationEnabled?: boolean;
    /** This node's other live-access owner for the same committed Session transition. */
    onSessionAccessChanged?: (sessionId: string) => void;
}>) {
    const { io } = input;
    let closed = false;
    // Each location owns one coalescing projection drain. A slow adapter/database
    // read for one room must not stall unrelated rooms, while repeated transitions
    // for the same location still collapse into a present-tense replacement.
    const pendingRooms = new Set<string>();
    const activeRooms = new Set<string>();
    const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function clearTyping(socket: Socket, onlyLocation?: PresenceLocation): void {
        const previous = readTypingLocation(socket);
        if (onlyLocation !== undefined && (!previous || !sameLocation(previous, onlyLocation))) return;
        const timer = typingTimers.get(socket.id);
        if (timer) clearTimeout(timer);
        typingTimers.delete(socket.id);
        delete socket.data.humanPresenceTypingSessionId;
        delete socket.data.humanPresenceTypingDiscussionId;
        delete socket.data.humanPresenceTypingExpiresAt;
        if (previous) schedule([previous]);
    }

    async function project(location: PresenceLocation): Promise<void> {
        const { sessionId, discussionId } = location;
        const room = sessionHumanPresenceLocationRoom(location);
        const sockets = (await io.in(room).fetchSockets()).filter(socket =>
            (socket.data.clientType === "user-scoped"
                || (sessionId !== undefined && socket.data.clientType === "session-scoped"
                    && socket.data.humanPresencePendingMessageEdits !== undefined))
            && typeof socket.data.userId === "string" && socket.data.userId.length > 0);
        if (closed || sockets.length === 0) return;
        const accountIds = [...new Set(sockets.map(socket => socket.data.userId!))];
        // Presence is a best-effort, present-tense projection with no writes or
        // after-commit effects. Use the canonical access owner directly against
        // the database client instead of holding one interactive transaction per
        // visible Session. A multi-Session declaration can otherwise exhaust the
        // SQLite transaction acquisition boundary and prevent every snapshot (and
        // shutdown) even though the Sessions have independent projection drains.
        // A committed access transition still schedules another replacement, so
        // this does not introduce a competing access or currentness decision.
        const canReadBySocketId = new Map<string, boolean>();
        const canTypeBySocketId = new Map<string, boolean>();
        const discussion = discussionId === undefined
            ? null
            : await readDiscussionRowInTx(db, { discussionId });
        for (const socket of sockets) {
            const authentication = readSessionAccessAuthenticationFromSocket(socket);
            if (discussionId !== undefined) {
                const context = discussion ? await resolveDiscussionContextInTx(db, {
                    accountId: socket.data.userId!, discussionId, authentication,
                }) : null;
                canReadBySocketId.set(socket.id, context !== null);
                canTypeBySocketId.set(socket.id, !!context && !!discussion && projectDiscussionCapabilitiesV1({
                    access: context.access,
                    keyReadiness: context.keyReadiness,
                    discussionArchived: discussion.archivedAt !== null,
                }).postMessages);
            } else {
                const decision = await resolveSessionAccessForOperation(db, {
                    accountId: socket.data.userId!, sessionId: sessionId!, authentication,
                });
                canReadBySocketId.set(socket.id, decision.status === "allowed" && decision.access.capabilities.readTranscript);
                canTypeBySocketId.set(socket.id, decision.status === "allowed"
                    && decision.access.capabilities.submitAgentInput);
            }
        }
        const profiles = new Map<string, SessionAccessAccountSummaryV1>();
        for (let offset = 0; offset < accountIds.length; offset += QUERY_BATCH_SIZE) {
            const rows = await db.account.findMany({
                where: { id: { in: accountIds.slice(offset, offset + QUERY_BATCH_SIZE) } },
                select: ACCOUNT_DISPLAY_PROFILE_SELECT,
            });
            for (const row of rows) profiles.set(row.id, {
                kind: "account", accountId: row.id, ...projectAccountDisplayProfileV1(row),
            });
        }
        if (closed) return;
        const now = Date.now();
        const viewers = new Map<string, SessionHumanPresenceSnapshotV1["viewers"][number]>();
        const recipients: string[] = [];
        const editRecipients: string[] = [];
        const pendingMessageEditHoldIds = new Set<string>();
        for (const socket of sockets) {
            const accountId = socket.data.userId!;
            const account = profiles.get(accountId);
            if (!canReadBySocketId.get(socket.id) || !account) {
                await socket.leave(room);
                const localSocket = io.sockets.sockets.get(socket.id);
                if (localSocket) clearTyping(localSocket, location);
                continue;
            }
            const canType = canTypeBySocketId.get(socket.id) === true;
            if (!canType) {
                const localSocket = io.sockets.sockets.get(socket.id);
                if (localSocket) clearTyping(localSocket, location);
            }
            if (sessionId !== undefined && canType) {
                for (const edit of socket.data.humanPresencePendingMessageEdits ?? []) {
                    if (edit.sessionId === sessionId) pendingMessageEditHoldIds.add(edit.holdId);
                }
            }
            if (sessionId !== undefined && socket.data.clientType === "session-scoped") {
                editRecipients.push(socket.id);
            } else {
                recipients.push(socket.id);
            }
            const visible = socket.data.clientType === "user-scoped" && (sessionId === undefined
                || socket.data.humanPresenceVisibleSessionIds === undefined
                || socket.data.humanPresenceVisibleSessionIds.includes(sessionId));
            if (!visible) continue;
            const target = readTypingLocation(socket);
            const typing = canType
                && target !== null
                && sameLocation(target, location)
                && (socket.data.humanPresenceTypingExpiresAt ?? 0) > now;
            const previous = viewers.get(accountId);
            viewers.set(accountId, { account, typing: typing || previous?.typing === true });
        }
        if (closed || (recipients.length === 0 && editRecipients.length === 0)) return;
        const name = (account: SessionAccessAccountSummaryV1) =>
            resolveAccountDisplayLabelV1(account)?.toLowerCase() ?? "";
        const snapshot: SessionHumanPresenceSnapshotV1 = {
            v: 1, ...(discussionId === undefined ? { sessionId: sessionId! } : { discussionId }), observedAt: now,
            viewers: [...viewers.values()].sort((a, b) => name(a.account).localeCompare(name(b.account))
                || a.account.accountId.localeCompare(b.account.accountId)),
        };
        // Discussion deletion can commit while access/profile projection is in
        // flight. Reuse the canonical resource reader at the last asynchronous
        // boundary so an earlier live row cannot authorize a post-delete snapshot.
        // The deletion transition's queued projection performs ordinary room and
        // typing cleanup; this check owns only the outbound currentness decision.
        if (discussionId !== undefined && !await readDiscussionRowInTx(db, { discussionId })) return;
        if (closed) return;
        // The complete current authorized observation always leaves the process as
        // one replacement. Socket.IO's inbound maxHttpBufferSize is not an outbound
        // presence ceiling: rejecting, truncating, paginating, or retrying a valid
        // snapshot would trade a truthful awareness view for an unrelated framing
        // threshold.
        if (recipients.length > 0) io.to(recipients).emit(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, snapshot);
        if (editRecipients.length > 0) io.to(editRecipients).emit(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, {
            ...snapshot, pendingMessageEditHoldIds: [...pendingMessageEditHoldIds].sort(),
        });
    }

    async function drainProjection(room: string): Promise<void> {
        if (closed || activeRooms.has(room)) return;
        const location = sessionHumanPresenceLocationFromRoom(room);
        if (!location) return;
        activeRooms.add(room);
        try {
            while (!closed && pendingRooms.has(room)) {
                pendingRooms.delete(room);
                try {
                    await project(location);
                } catch (error) {
                    if (closed) return;
                    log({ module: "session-human-presence", error }, "Human presence projection unavailable");
                    // Repair a present-tense observation after a transient outage without
                    // holding up other Sessions. A transition queued while this attempt
                    // was in flight is represented by the same eventual current snapshot,
                    // so coalesce it behind the new fence instead of retrying immediately.
                    pendingRooms.delete(room);
                    if (!retryTimers.has(room)) {
                        const retry = setTimeout(() => {
                            retryTimers.delete(room);
                            schedule([location]);
                        }, PROJECTION_RETRY_MS);
                        retry.unref();
                        retryTimers.set(room, retry);
                    }
                    return;
                }
            }
        } finally {
            activeRooms.delete(room);
            if (!closed && pendingRooms.has(room) && !retryTimers.has(room)) {
                void Promise.resolve().then(() => drainProjection(room));
            }
        }
    }

    function schedule(locations: readonly (string | PresenceLocation)[]): void {
        if (closed) return;
        for (const value of locations) {
            const location = typeof value === "string" ? { sessionId: value } : value;
            const room = sessionHumanPresenceLocationRoom(location);
            // A failed projection owns this Session's next attempt until its
            // backoff fires. Access and room transitions during the outage are
            // already represented by the eventual present-tense replacement;
            // letting each notification cancel the timer would turn the
            // no-throw transition seam into an unbounded Redis/database retry
            // loop.
            if (retryTimers.has(room)) continue;
            pendingRooms.add(room);
            if (!activeRooms.has(room)) {
                void Promise.resolve().then(() => drainProjection(room));
            }
        }
    }

    async function replaceVisible(
        socket: Socket,
        accountId: string,
        requestedSessionIds: readonly string[],
        requestedLocations: readonly SessionHumanPresenceLocationV1[] = [],
        requestedPendingMessageEdits?: readonly SessionHumanPresencePendingMessageEditV1[],
    ) {
        if (closed || !socket.connected) throw new Error("Human presence socket unavailable");
        // The socket handler constrains observers to their handshake-admitted
        // Session and releases them only after final socket currentness. Joining
        // that room needs no second database admission: project() authorizes the
        // outbound snapshot and owns recovery if its reads are unavailable.
        const replacement = socket.data.clientType === "session-scoped" ? {
            admittedSessionIds: [...requestedSessionIds],
            admittedLocations: [],
            admittedPendingMessageEdits: [],
        } : await inReadSnapshot(async tx => {
            const where = await buildSessionAccessWhere({
                tx,
                accountId,
                capability: "readTranscript",
                mode: "effective_access_v1",
                authentication: readSessionAccessAuthenticationFromSocket(socket),
            });
            const ids: string[] = [];
            for (let offset = 0; offset < requestedSessionIds.length; offset += QUERY_BATCH_SIZE) {
                const rows = await tx.session.findMany({
                    where: { AND: [{ id: { in: requestedSessionIds.slice(offset, offset + QUERY_BATCH_SIZE) } }, where] },
                    select: { id: true },
                });
                ids.push(...rows.map(row => row.id));
            }
            const admittedSessionIds = ids.sort();
            const discussionIds = [...new Set(requestedLocations.map(location => location.discussionId))];
            const admittedLocations: SessionHumanPresenceLocationV1[] = [];
            for (let offset = 0; offset < discussionIds.length; offset += QUERY_BATCH_SIZE) {
                const readable = (await filterDiscussionsWithCurrentReadAccessInTx(tx, {
                    discussionIds: discussionIds.slice(offset, offset + QUERY_BATCH_SIZE),
                    accountIds: [accountId], authentication: readSessionAccessAuthenticationFromSocket(socket),
                })).get(accountId);
                for (const discussionId of readable ?? []) admittedLocations.push({ discussionId });
            }
            admittedLocations.sort((left, right) => left.discussionId.localeCompare(right.discussionId));
            // An edit is admitted once through the existing input capability
            // owner. Its later liveness comes only from this socket, with no
            // metadata renewal or per-projection permission re-admission.
            const admittedPendingMessageEdits: SessionHumanPresencePendingMessageEditV1[] = [];
            const admittedHoldIdsBySession = new Map<string, Set<string>>();
            for (const edit of socket.data.humanPresencePendingMessageEdits ?? []) {
                const holdIds = admittedHoldIdsBySession.get(edit.sessionId) ?? new Set<string>();
                holdIds.add(edit.holdId);
                admittedHoldIdsBySession.set(edit.sessionId, holdIds);
            }
            const editsBySession = new Map<string, SessionHumanPresencePendingMessageEditV1[]>();
            for (const edit of requestedPendingMessageEdits ?? []) {
                const edits = editsBySession.get(edit.sessionId) ?? [];
                edits.push(edit);
                editsBySession.set(edit.sessionId, edits);
            }
            for (const [sessionId, edits] of editsBySession) {
                const admittedHoldIds = admittedHoldIdsBySession.get(sessionId);
                let admitNewEdits = false;
                if (edits.some(edit => !admittedHoldIds?.has(edit.holdId))) {
                    const decision = await resolveSessionAccessForOperation(tx, {
                        accountId, sessionId, authentication: readSessionAccessAuthenticationFromSocket(socket),
                        capability: "submitAgentInput",
                    });
                    admitNewEdits = decision.status === "allowed" && decision.access.capabilities.submitAgentInput;
                }
                admittedPendingMessageEdits.push(...edits.filter(edit => admittedHoldIds?.has(edit.holdId) || admitNewEdits));
            }
            return { admittedSessionIds, admittedLocations, admittedPendingMessageEdits };
        });
        if (closed || !socket.connected) throw new Error("Human presence socket unavailable");
        const previous = sessionHumanPresenceLocationsFromRooms(socket.rooms);
        const visible = [
            ...replacement.admittedSessionIds.map(sessionId => ({ sessionId })),
            ...replacement.admittedLocations,
        ];
        const next = [
            ...visible,
            ...replacement.admittedPendingMessageEdits.map(edit => ({ sessionId: edit.sessionId })),
        ];
        socket.data.humanPresenceVisibleSessionIds = socket.data.clientType === "user-scoped"
            ? replacement.admittedSessionIds : [];
        socket.data.humanPresencePendingMessageEdits = requestedPendingMessageEdits === undefined
            ? undefined : replacement.admittedPendingMessageEdits;
        const nextRooms = new Set(next.map(sessionHumanPresenceLocationRoom));
        for (const location of previous) {
            const room = sessionHumanPresenceLocationRoom(location);
            if (!nextRooms.has(room)) await socket.leave(room);
        }
        await socket.join([...nextRooms]);
        const typingLocation = readTypingLocation(socket);
        if (typingLocation && !visible.some(location => sameLocation(location, typingLocation))) clearTyping(socket);
        return { ...replacement, affectedLocations: [...previous, ...next] };
    }

    async function setTyping(socket: Socket, accountId: string, value: SessionHumanPresenceTypingSetV1): Promise<void> {
        if (!value.typing) {
            clearTyping(socket, value);
            return;
        }
        const location: PresenceLocation = value.discussionId === undefined
            ? { sessionId: value.sessionId! }
            : { discussionId: value.discussionId };
        const room = sessionHumanPresenceLocationRoom(location);
        if (closed || !socket.connected || !socket.rooms.has(room)) return;
        if (socket.data.clientType !== "user-scoped" || (value.sessionId !== undefined
            && socket.data.humanPresenceVisibleSessionIds !== undefined
            && !socket.data.humanPresenceVisibleSessionIds.includes(value.sessionId))) return;
        const authentication = readSessionAccessAuthenticationFromSocket(socket);
        let allowed = false;
        if (value.discussionId === undefined) {
            const decision = await resolveSessionAccessForOperation(db, {
                accountId,
                sessionId: value.sessionId!,
                authentication,
                capability: "submitAgentInput",
            });
            allowed = decision.status === "allowed" && decision.access.capabilities.submitAgentInput;
        } else {
            const [context, discussion] = await Promise.all([
                resolveDiscussionContextInTx(db, { accountId, discussionId: value.discussionId, authentication }),
                readDiscussionRowInTx(db, { discussionId: value.discussionId }),
            ]);
            allowed = !!context && !!discussion && projectDiscussionCapabilitiesV1({
                access: context.access,
                keyReadiness: context.keyReadiness,
                discussionArchived: discussion.archivedAt !== null,
            }).postMessages;
        }
        if (closed || !socket.connected || !socket.rooms.has(room)) return;
        if (!allowed) {
            clearTyping(socket, location);
            schedule([location]);
            return;
        }
        const previousTypingLocation = readTypingLocation(socket);
        const unchanged = previousTypingLocation !== null && sameLocation(previousTypingLocation, location)
            && (socket.data.humanPresenceTypingExpiresAt ?? 0) > Date.now();
        if (previousTypingLocation === null || !sameLocation(previousTypingLocation, location)) clearTyping(socket);
        const timer = typingTimers.get(socket.id);
        if (timer) clearTimeout(timer);
        socket.data.humanPresenceTypingSessionId = value.sessionId;
        socket.data.humanPresenceTypingDiscussionId = value.discussionId;
        socket.data.humanPresenceTypingExpiresAt = Date.now() + SESSION_HUMAN_PRESENCE_TYPING_LEASE_MS;
        const expiry = setTimeout(() => clearTyping(socket), SESSION_HUMAN_PRESENCE_TYPING_LEASE_MS);
        expiry.unref();
        typingTimers.set(socket.id, expiry);
        if (!unchanged) schedule([location]);
    }

    function scheduleSessionAccessChanged(sessionId: string): void {
        input.onSessionAccessChanged?.(sessionId);
        const locations = new Map<string, PresenceLocation>();
        locations.set(sessionHumanPresenceLocationRoom({ sessionId }), { sessionId });
        for (const socket of io.sockets.sockets.values()) {
            for (const location of sessionHumanPresenceLocationsFromRooms(socket.rooms)) {
                if (location.sessionId === sessionId) {
                    locations.set(sessionHumanPresenceLocationRoom(location), location);
                }
            }
        }
        schedule([...locations.values()]);
    }

    const onClusterAccessChanged = (raw: unknown): void => {
        const location = parseSessionHumanPresenceAccessChangedServerPayload(raw);
        if (location === null) {
            log(
                { module: "session-human-presence" },
                "Ignored invalid clustered human presence access transition",
            );
            return;
        }
        // Receiving nodes reuse the ordinary projection owner. It fetches the
        // current room and rechecks every socket's exact credential before any
        // Account-level dedupe; the cluster message carries no trusted actors.
        if (location.discussionId !== undefined) schedule([location]);
        else scheduleSessionAccessChanged(location.sessionId);
    };
    if (input.clusterAccessChangePublicationEnabled === true) {
        io.on(SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT, onClusterAccessChanged);
    }

    const listener: AccessChangeListener = {
        locationChanged: location => {
            if (location.discussionId !== undefined) schedule([location]);
            else scheduleSessionAccessChanged(location.sessionId);
        },
        ...(input.clusterAccessChangePublicationEnabled === true ? {
            publishLocationChanged: (location: PresenceLocation) => {
                // Socket.IO server-side emission targets the other API nodes.
                // Local owners were scheduled above, and receivers schedule
                // directly rather than calling this listener, preventing echoes.
                publishSessionHumanPresenceAccessChanged(io, location);
            },
        } : {}),
    };
    accessChangeListeners.add(listener);

    // Remote socketsLeave and ordinary disconnect both reach this adapter event
    // on the socket's actual node, which owns its local typing timer/data.
    const onLeaveRoom = (room: string, socketId: string) => {
        const location = sessionHumanPresenceLocationFromRoom(room);
        const socket = io.sockets.sockets.get(socketId);
        if (socket && location) clearTyping(socket, location);
    };
    // Some owner-level socket tests provide only the namespace methods needed
    // for their assertion. The real Socket.IO Server always has this adapter;
    // keep the lifecycle hook optional so presence does not make those callers
    // construct an unrelated transport fixture.
    const socketAdapter = io.sockets?.adapter;
    socketAdapter?.on("leave-room", onLeaveRoom);

    return {
        replaceVisible, setTyping, schedule,
        disconnected(socket: Socket, previousLocations: readonly PresenceLocation[]): void {
            clearTyping(socket);
            schedule(previousLocations);
        },
        close(): void {
            closed = true;
            accessChangeListeners.delete(listener);
            if (input.clusterAccessChangePublicationEnabled === true) {
                io.off(SESSION_HUMAN_PRESENCE_ACCESS_CHANGED_SERVER_EVENT, onClusterAccessChanged);
            }
            socketAdapter?.off("leave-room", onLeaveRoom);
            for (const timer of typingTimers.values()) clearTimeout(timer);
            typingTimers.clear();
            for (const timer of retryTimers.values()) clearTimeout(timer);
            retryTimers.clear();
            pendingRooms.clear();
            activeRooms.clear();
        },
    };
}

export type SessionHumanPresenceService = ReturnType<typeof createSessionHumanPresenceService>;
