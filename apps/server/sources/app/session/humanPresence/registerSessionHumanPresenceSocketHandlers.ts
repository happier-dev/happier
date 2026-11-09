import type { Socket } from "socket.io";
import {
    SESSION_HUMAN_PRESENCE_TYPING_SET_EVENT,
    SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT,
    SessionHumanPresenceTypingSetV1Schema,
    SessionHumanPresenceVisibleReplaceV1Schema,
    type SessionHumanPresenceTypingSetV1,
    type SessionHumanPresencePendingMessageEditV1,
    type SessionHumanPresenceVisibleReplaceResultV1,
} from "@happier-dev/protocol/sessions";
import { log } from "@/utils/logging/log";
import type { SessionHumanPresenceService } from "./sessionHumanPresenceService";
import { sessionHumanPresenceLocationsFromRooms } from "./sessionHumanPresenceRooms";

/**
 * Per-socket release handles for the final socket-currentness hold. The handler
 * is installed during handshake middleware so the client's first replacement can
 * never be lost, while the authorizing currentness read happens later in the
 * connection callback; this bridge hands the release decision back to that
 * callback without widening the Socket.IO SocketData contract.
 */
const holdReleaseBySocket = new WeakMap<Socket, () => void>();

/**
 * Releases the bounded early-catch hold after the connection callback's final
 * socket-currentness check has succeeded for this socket. Before that point the
 * hold retains at most the latest valid declaration and produces no
 * acknowledgement, access decision, room membership, typing state, or snapshot.
 */
export function releaseSessionHumanPresenceHoldAfterFinalCurrentness(socket: Socket): void {
    holdReleaseBySocket.get(socket)?.();
}

export function registerSessionHumanPresenceSocketHandlers(input: Readonly<{
    presence: SessionHumanPresenceService;
    socket: Socket;
    accountId: string;
}>): void {
    const { socket, accountId, presence } = input;
    const observer = socket.data.clientType === "session-scoped";
    if ((!observer && socket.data.clientType !== "user-scoped") || socket.data.userId !== accountId) return;
    // Bounded transport catch for the handshake window: the hold validates the
    // strict wire shape and retains at most the latest replacement declaration in
    // socket-local memory. A superseded or discarded hold is dropped silently; the
    // acknowledgement is sent only by the admitted path after final currentness.
    let current = false;
    let held: {
        sessionIds: readonly string[];
        locations: readonly import("@happier-dev/protocol/sessions").SessionHumanPresenceLocationV1[];
        includesLocations: boolean;
        pendingMessageEdits?: readonly SessionHumanPresencePendingMessageEditV1[];
        reply: (result: SessionHumanPresenceVisibleReplaceResultV1) => void;
    } | null = null;
    type Intent =
        | {
            kind: "visible";
            sessionIds: readonly string[];
            locations: readonly import("@happier-dev/protocol/sessions").SessionHumanPresenceLocationV1[];
            includesLocations: boolean;
            pendingMessageEdits?: readonly SessionHumanPresencePendingMessageEditV1[];
            reply: (result: SessionHumanPresenceVisibleReplaceResultV1) => void;
        }
        | { kind: "typing"; value: SessionHumanPresenceTypingSetV1 };
    // One operation runs while at most one replacement and one typing intent
    // wait. Superseded desired state is not an unbounded async packet queue.
    const pending: Intent[] = [];
    let running = false;
    function enqueue(intent: Intent): void {
        const supersededIndex = pending.findIndex(value => value.kind === intent.kind);
        if (supersededIndex !== -1) {
            const superseded = pending.splice(supersededIndex, 1)[0];
            if (superseded.kind === "visible") superseded.reply({ v: 1, ok: false, errorCode: "UNAVAILABLE" });
        }
        pending.push(intent);
        if (running) return;
        running = true;
        void (async () => {
            try {
                while (pending.length > 0) {
                    const next = pending.shift()!;
                    try {
                        if (next.kind === "visible") {
                            const replacement = await presence.replaceVisible(
                                socket, accountId, next.sessionIds, next.locations, next.pendingMessageEdits,
                            );
                            next.reply({
                                v: 1,
                                ok: true,
                                admittedSessionIds: replacement.admittedSessionIds,
                                ...(next.includesLocations
                                    ? { admittedLocations: replacement.admittedLocations }
                                    : {}),
                                ...(next.pendingMessageEdits !== undefined
                                    ? { admittedPendingMessageEdits: replacement.admittedPendingMessageEdits }
                                    : {}),
                            });
                            presence.schedule(replacement.affectedLocations);
                        } else {
                            await presence.setTyping(socket, accountId, next.value);
                        }
                    } catch (error) {
                        if (next.kind === "visible") next.reply({ v: 1, ok: false, errorCode: "UNAVAILABLE" });
                        log({ module: "session-human-presence", error }, "Human presence intent unavailable");
                    }
                }
            } finally { running = false; }
        })();
    }
    socket.on(SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT, (value: unknown, acknowledge: unknown) => {
        const reply = (result: SessionHumanPresenceVisibleReplaceResultV1) => {
            if (typeof acknowledge === "function") acknowledge(result);
        };
        const parsed = SessionHumanPresenceVisibleReplaceV1Schema.safeParse(value);
        if (!parsed.success) {
            // An unqualified socket receives no protocol answer at all.
            if (!current) return;
            const unsupported = typeof value === "object" && value !== null && "v" in value
                && typeof value.v === "number" && value.v !== 1;
            reply({ v: 1, ok: false, errorCode: unsupported ? "UNSUPPORTED_VERSION" : "INVALID_REQUEST" });
            return;
        }
        // Session runtimes observe their exact admitted Session's edit lifetime;
        // they never declare human visibility or edits. Legacy publishers did not
        // participate in this protocol and retain their no-answer behavior.
        if (observer) {
            if (parsed.data.pendingMessageEdits === undefined) return;
            const binding = socket.data.sessionScopedBinding;
            if (!binding
                || parsed.data.sessionIds.some(id => id !== binding.sessionId)
                || (parsed.data.locations?.length ?? 0) > 0 || parsed.data.pendingMessageEdits.length > 0) {
                if (current) reply({ v: 1, ok: false, errorCode: "INVALID_REQUEST" });
                return;
            }
        }
        if (!current) {
            held = {
                sessionIds: parsed.data.sessionIds,
                locations: parsed.data.locations ?? [],
                includesLocations: parsed.data.locations !== undefined,
                pendingMessageEdits: parsed.data.pendingMessageEdits,
                reply,
            };
            return;
        }
        enqueue({
            kind: "visible",
            sessionIds: parsed.data.sessionIds,
            locations: parsed.data.locations ?? [],
            includesLocations: parsed.data.locations !== undefined,
            pendingMessageEdits: parsed.data.pendingMessageEdits,
            reply,
        });
    });
    socket.on(SESSION_HUMAN_PRESENCE_TYPING_SET_EVENT, (value: unknown) => {
        const parsed = SessionHumanPresenceTypingSetV1Schema.safeParse(value);
        // Typing is transient input intent: dropping pre-currentness intents is safe
        // because an actively editing client renews within the lease window.
        if (!parsed.success || !current || observer) return;
        enqueue({ kind: "typing", value: parsed.data });
    });
    let previousLocations: ReturnType<typeof sessionHumanPresenceLocationsFromRooms> = [];
    socket.on("disconnecting", () => {
        previousLocations = sessionHumanPresenceLocationsFromRooms(socket.rooms);
    });
    socket.on("disconnect", () => {
        held = null;
        presence.disconnected(socket, previousLocations);
    });
    holdReleaseBySocket.set(socket, () => {
        if (current) return;
        current = true;
        const heldDeclaration = held;
        held = null;
        if (heldDeclaration) enqueue({ kind: "visible", ...heldDeclaration });
    });
}
