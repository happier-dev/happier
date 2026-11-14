import type { ChildProcess } from 'node:child_process';

import { logger } from '@/ui/logger';

import { SessionHolderChild, type SessionHolderRole } from './sessionHolder';

/**
 * The one adopt contract for request/response Agents held by a per-Session holder.
 *
 * A runner that crashes leaves its Agent running in the holder. The next runner
 * attaches to the same Agent (see `resolveAgentSessionHolderLaunch`). Its protocol
 * client is new, so three things would otherwise go wrong:
 *
 * 1. It repeats the startup handshake, which a live Agent may refuse or answer
 *    with a second session.
 * 2. Its request ids start again (0, 1, `claude-sdk-control-1`, ...). The holder
 *    replays the Agent's answer to the old in-flight request, and that answer
 *    would resolve whichever NEW request reuses the same id: a silent wrong result.
 * 3. The old in-flight request (for example the running prompt) has no caller.
 *
 * Each protocol owner routes every frame through this adoption at its message
 * seam, with its frame codec:
 * - the host JSON-RPC client (`createJsonRpcProcessClient`: Codex);
 * - the ACP stream adapter (`createAcpNdJsonStream`, below the third-party ACP SDK,
 *   which is never edited);
 * - the host JSON-stream client (the Claude SDK's stream-json control channel,
 *   Pi's command/response RPC).
 *
 * The adoption keeps its state in the holder (`meta` op), so the next adopter:
 * - answers the handshake from the stored results instead of sending it again;
 * - moves its own request ids away from every id the Agent has seen (numbers
 *   from `nextId` up, strings tagged with this adoption's `generation`);
 * - completes the held in-flight requests (`heldRequests`).
 * The state is written before the request bytes on the same holder socket, so an
 * adopter never reuses an id the Agent may still answer.
 */

export const SESSION_HOLDER_ADOPT_STATE_VERSION = 1;

type Frame = Record<string, unknown>;
type WireId = number | string;
type Answer = Readonly<{ result: unknown } | { error: unknown }>;

export type SessionHolderAdoptStateV1 = Readonly<{
    v: typeof SESSION_HOLDER_ADOPT_STATE_VERSION;
    role: SessionHolderRole;
    /** Handshake results by key, answered locally on adopt. */
    handshake: Readonly<Record<string, unknown>>;
    /** Requests the Agent has not answered yet, by wire id. */
    inFlight: readonly Readonly<{ id: WireId; method: string }>[];
    /** First numeric wire id an adopter may use: above every id the Agent has seen. */
    nextId: number;
    /** Adoptions so far; string ids sent after an adopt carry it. */
    generation: number;
    /** Agent turns started and not yet ended (codecs with `turn`), as the last runner saw them. */
    turnsInFlight?: number;
}>;

export type SessionHolderHeldRequest = Readonly<{
    id: WireId;
    method: string;
    /** Settles with the Agent's answer, which the previous runner never received. */
    response: Promise<Answer>;
}>;

/** How one protocol names requests and answers. Frames the codec does not read pass through. */
export type SessionHolderFrameCodec = Readonly<{
    /** An outgoing request to the Agent (not an answer to an Agent request). */
    readRequest(frame: Frame): Readonly<{ id: WireId; method: string; params: unknown }> | null;
    /** An outgoing notification to the Agent. */
    readNotification(frame: Frame): string | null;
    /** An incoming answer to one of our requests. */
    readResponse(frame: Frame): Readonly<{ id: WireId; answer: Answer }> | null;
    withRequestId(frame: Frame, id: WireId): Frame;
    withResponseId(frame: Frame, id: WireId): Frame;
    /** The incoming frame answering request `id` with `result`. */
    answerFrame(id: WireId, result: unknown): Frame;
    /** Turn boundaries, for protocols whose turns are not requests (stream-json `user` → `result`). */
    turn?: Readonly<{ opens(outgoing: Frame): boolean; closes(incoming: Frame): boolean }>;
}>;

/**
 * What the adopter holds: `none` (a fresh Agent, nothing adopted), `idle` (an
 * adopted Agent with no turn running), `turn` (an adopted Agent still answering
 * a turn the previous runner started), `unknown` (the codec tracks no turns).
 */
export type SessionHolderHeldTurn = 'none' | 'idle' | 'turn' | 'unknown';

export type SessionHolderHandshake = Readonly<{
    codec: SessionHolderFrameCodec;
    /** Request methods whose results are stored, by storage key. */
    requests: Readonly<Record<string, string>>;
    /** Stored value for a handshake answer (defaults to the result). */
    record?: (method: string, params: unknown, result: unknown) => unknown;
    /** Local answer to an adopter's handshake request, or undefined to send it to the Agent. */
    answer?: (method: string, params: unknown, stored: unknown) => unknown;
    /** Notifications that belong to the handshake and are not sent again on adopt. */
    notifications?: readonly string[];
    /**
     * Agent output that arrives on adopt (replay, notifications, Agent requests) is
     * held until the adopter got the answer to one of these methods, so it reaches a
     * client that already knows the Session. Empty: held until `release()`.
     */
    readyAfter: readonly string[];
}>;

export type SessionHolderAdoption = Readonly<{
    /** Settles with whether the holder carried a previous runner's state. */
    readonly adopted: Promise<boolean>;
    /** Settles from the holder's stored state once attached; never from Agent output or time. */
    readonly heldTurn: Promise<SessionHolderHeldTurn>;
    /**
     * The wire frame to write, or null when the stored handshake answered it.
     * Waits for the holder's hello, which carries the stored state.
     */
    outgoing(frame: Frame): Promise<Frame | null>;
    /** The frame for the local client, or null when it is held or belongs to a held request. */
    incoming(frame: Frame): Frame | null;
    heldRequests(): readonly SessionHolderHeldRequest[];
    /** The wire id of a local request id (for protocol messages that name a request). */
    toWireId(id: WireId): WireId;
    /** The adopter knows the Session again: deliver the Agent output held so far. */
    release(): void;
}>;

function readWireId(value: unknown): WireId | null {
    return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export const JSON_RPC_FRAME_CODEC: SessionHolderFrameCodec = Object.freeze({
    readRequest(frame: Frame) {
        const id = readWireId(frame.id);
        return id !== null && typeof frame.method === 'string' ? { id, method: frame.method, params: frame.params } : null;
    },
    readNotification(frame: Frame) {
        return readWireId(frame.id) === null && typeof frame.method === 'string' ? frame.method : null;
    },
    readResponse(frame: Frame) {
        const id = readWireId(frame.id);
        if (id === null || typeof frame.method === 'string' || !('result' in frame || 'error' in frame)) return null;
        return { id, answer: 'error' in frame ? { error: frame.error } : { result: frame.result } };
    },
    withRequestId: (frame: Frame, id: WireId) => ({ ...frame, id }),
    withResponseId: (frame: Frame, id: WireId) => ({ ...frame, id }),
    answerFrame: (id: WireId, result: unknown) => ({ jsonrpc: '2.0', id, result }),
});

/** The stream-json control channel (Claude SDK): `control_request` / `control_response` by `request_id`. */
export const JSON_STREAM_CONTROL_FRAME_CODEC: SessionHolderFrameCodec = Object.freeze({
    readRequest(frame: Frame) {
        const request = asRecord(frame.request);
        return frame.type === 'control_request' && typeof frame.request_id === 'string' && typeof request?.subtype === 'string'
            ? { id: frame.request_id, method: request.subtype, params: request } : null;
    },
    readNotification: () => null,
    readResponse(frame: Frame) {
        const response = asRecord(frame.response);
        if (frame.type !== 'control_response' || typeof response?.request_id !== 'string') return null;
        return { id: response.request_id, answer: response.subtype === 'error' ? { error: response.error } : { result: response.response } };
    },
    withRequestId: (frame: Frame, id: WireId) => ({ ...frame, request_id: id }),
    withResponseId: (frame: Frame, id: WireId) => ({ ...frame, response: { ...asRecord(frame.response), request_id: id } }),
    answerFrame: (id: WireId, result: unknown) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: result } }),
    // Each main-thread user message is answered by one main-thread result.
    turn: Object.freeze({
        opens: (frame: Frame) => frame.type === 'user' && frame.parent_tool_use_id == null,
        closes: (frame: Frame) => frame.type === 'result' && frame.parent_tool_use_id == null,
    }),
});

/**
 * A command/response JSON stream (Pi RPC): `{type, id}` commands answered by
 * `{type: 'response', id, success, data | error}`. A record whose type ends in
 * `_response` answers one of the Agent's own requests and keeps its id.
 */
export const JSON_STREAM_COMMAND_FRAME_CODEC: SessionHolderFrameCodec = Object.freeze({
    readRequest(frame: Frame) {
        return typeof frame.type === 'string' && frame.type !== 'response' && !frame.type.endsWith('_response')
            && typeof frame.id === 'string' ? { id: frame.id, method: frame.type, params: frame } : null;
    },
    readNotification: () => null,
    readResponse(frame: Frame) {
        if (frame.type !== 'response' || typeof frame.id !== 'string') return null;
        return { id: frame.id, answer: frame.success === true ? { result: frame.data ?? null } : { error: frame.error ?? null } };
    },
    withRequestId: (frame: Frame, id: WireId) => ({ ...frame, id }),
    withResponseId: (frame: Frame, id: WireId) => ({ ...frame, id }),
    answerFrame: (id: WireId, result: unknown) => ({ type: 'response', id, success: true, data: result }),
});

export const JSON_RPC_INITIALIZE_HANDSHAKE: SessionHolderHandshake = Object.freeze({
    codec: JSON_RPC_FRAME_CODEC,
    requests: Object.freeze({ initialize: 'initialize' }),
    notifications: Object.freeze(['initialized', 'notifications/initialized']),
    readyAfter: Object.freeze(['initialize']),
});

/** The stream-json `initialize` control request (hook registration) is answered locally on adopt. */
export const JSON_STREAM_CONTROL_HANDSHAKE: SessionHolderHandshake = Object.freeze({
    codec: JSON_STREAM_CONTROL_FRAME_CODEC,
    requests: Object.freeze({ initialize: 'initialize' }),
    readyAfter: Object.freeze(['initialize']),
});

/**
 * A command/response stream has no handshake to skip. Its session-open state
 * read (`get_state`) is re-sent, and the held Agent output reaches the adopter
 * once that answer told it which session it is in.
 */
export const JSON_STREAM_COMMAND_HANDSHAKE: SessionHolderHandshake = Object.freeze({
    codec: JSON_STREAM_COMMAND_FRAME_CODEC,
    requests: Object.freeze({}),
    readyAfter: Object.freeze(['get_state']),
});

/** The JSON-stream handshakes by the request shape a plugin declares (`adoptsHeldAgentTurns`). */
export const JSON_STREAM_ADOPT_HANDSHAKES = Object.freeze({
    streamJsonControl: JSON_STREAM_CONTROL_HANDSHAKE,
    commandResponse: JSON_STREAM_COMMAND_HANDSHAKE,
}) satisfies Readonly<Record<string, SessionHolderHandshake>>;

function isAdoptState(value: unknown): value is SessionHolderAdoptStateV1 {
    const state = asRecord(value);
    return state?.v === SESSION_HOLDER_ADOPT_STATE_VERSION && typeof state.nextId === 'number'
        && typeof state.generation === 'number' && Array.isArray(state.inFlight) && asRecord(state.handshake) !== null;
}

/**
 * Null for an Agent not run by a holder (direct spawn) or not held as the
 * Session's primary Agent: nothing to keep, nothing to adopt.
 */
export function createSessionHolderAdoption(input: Readonly<{
    child: ChildProcess | null | undefined;
    handshake: SessionHolderHandshake;
    /** Delivers an incoming frame the adoption produced (a handshake answer, released output). */
    deliver(frame: Frame): void;
    /**
     * Settles a held request in order with the frames delivered before it. A client that
     * hands frames on asynchronously (the ACP SDK stream) runs `settle` once it took every
     * earlier frame, so a held turn never ends before the output it produced. Default: now.
     */
    settleInOrder?: (settle: () => void) => void;
}>): SessionHolderAdoption | null {
    const child = input.child;
    if (!(child instanceof SessionHolderChild) || child.role !== 'primary') return null;
    const holder = child;
    const codec = input.handshake.codec;
    let previous: SessionHolderAdoptStateV1 | null = null;
    let base = 0;
    let generation = 0;
    let nextId = 0;
    let turnsInFlight = 0;
    const handshake: Record<string, unknown> = {};
    const inFlight = new Map<WireId, Readonly<{ method: string; params: unknown }>>();
    const held = new Map<WireId, { method: string; settle(answer: Answer): void; response: Promise<Answer> }>();
    const readyMethods = new Set(input.handshake.readyAfter);
    let ready = true;
    // Output reaches `incoming` only after the hello, so the state is set first.
    const attached = holder.attached.then(() => {
        const state = isAdoptState(holder.adoptedMeta) ? holder.adoptedMeta : null;
        previous = state;
        if (!state) return false;
        base = nextId = state.nextId;
        generation = state.generation + 1;
        turnsInFlight = state.turnsInFlight ?? 0;
        Object.assign(handshake, state.handshake);
        for (const entry of state.inFlight) {
            let settle!: (answer: Answer) => void;
            const response = new Promise<Answer>(resolve => { settle = resolve; });
            held.set(entry.id, { method: entry.method, settle, response });
        }
        ready = input.handshake.readyAfter.length > 0 && !input.handshake.readyAfter.some(method => {
            const key = input.handshake.requests[method];
            return key !== undefined && key in handshake;
        });
        return true;
    });
    const waiting: Frame[] = [];
    let reportedForeign = false;

    const publish = () => {
        holder.publishAdoptState({
            v: SESSION_HOLDER_ADOPT_STATE_VERSION,
            role: 'primary',
            handshake,
            inFlight: [...[...held.entries()].map(([id, entry]) => ({ id, method: entry.method })),
                ...[...inFlight.entries()].map(([id, entry]) => ({ id, method: entry.method }))],
            nextId,
            generation,
            ...(codec.turn ? { turnsInFlight } : {}),
        } satisfies SessionHolderAdoptStateV1);
    };

    const toWire = (id: WireId): WireId => typeof id === 'number' ? id + base : generation === 0 ? id : `${id}~a${generation}`;
    const fromWire = (id: WireId): WireId | null => {
        if (typeof id === 'number') return id >= base ? id - base : null;
        if (generation === 0) return id;
        const suffix = `~a${generation}`;
        return id.endsWith(suffix) ? id.slice(0, -suffix.length) : null;
    };

    const release = () => {
        if (ready) return;
        ready = true;
        for (const frame of waiting.splice(0)) {
            const routed = route(frame);
            if (routed) input.deliver(routed);
        }
    };

    function route(frame: Frame): Frame | null {
        if (turnsInFlight > 0 && codec.turn?.closes(frame)) {
            // Stored before the client sees it: a crash after delivery never re-counts it.
            turnsInFlight -= 1;
            publish();
        }
        const response = codec.readResponse(frame);
        if (!response) return frame;
        const heldRequest = held.get(response.id);
        if (heldRequest) {
            held.delete(response.id);
            publish();
            const answer = response.answer;
            if (input.settleInOrder) input.settleInOrder(() => heldRequest.settle(answer));
            else heldRequest.settle(answer);
            return null;
        }
        const sent = inFlight.get(response.id);
        const localId = fromWire(response.id);
        if (!sent || localId === null) {
            // An answer to nothing this runner or the held state knows. Delivering
            // it could resolve an unrelated local request with the same id.
            if (!reportedForeign) {
                reportedForeign = true;
                logger.warn('[SessionHolder] Dropped an Agent response to an unknown request id after adopt');
            }
            return null;
        }
        inFlight.delete(response.id);
        const key = input.handshake.requests[sent.method];
        if (key !== undefined && 'result' in response.answer) {
            const result = response.answer.result;
            handshake[key] = input.handshake.record ? input.handshake.record(sent.method, sent.params, result) : result;
        }
        publish();
        return codec.withResponseId(frame, localId);
    }

    const heldTurn = attached.then((adopted): SessionHolderHeldTurn => !adopted ? 'none'
        : !codec.turn ? 'unknown' : turnsInFlight > 0 ? 'turn' : 'idle');
    heldTurn.catch(() => undefined);

    return Object.freeze({
        adopted: attached,
        heldTurn,
        async outgoing(frame: Frame): Promise<Frame | null> {
            await attached;
            if (codec.turn?.opens(frame)) {
                turnsInFlight += 1;
                // The state reaches the holder before the turn's bytes do.
                publish();
                return frame;
            }
            const notification = codec.readNotification(frame);
            if (notification !== null) {
                return previous && input.handshake.notifications?.includes(notification) ? null : frame;
            }
            const request = codec.readRequest(frame);
            if (!request) return frame; // An answer to an Agent request keeps the Agent's id.
            const key = input.handshake.requests[request.method];
            if (previous && key !== undefined && key in handshake) {
                const stored = handshake[key];
                const answer = input.handshake.answer ? input.handshake.answer(request.method, request.params, stored) : stored;
                if (answer !== undefined) {
                    input.deliver(codec.answerFrame(request.id, answer));
                    // After the answer, never before it: the client learns the Session first.
                    if (readyMethods.has(request.method)) setImmediate(release);
                    return null;
                }
            }
            const wireId = toWire(request.id);
            inFlight.set(wireId, { method: request.method, params: key !== undefined ? request.params : undefined });
            if (typeof wireId === 'number') nextId = Math.max(nextId, wireId + 1);
            // The state reaches the holder before the request bytes do.
            publish();
            return codec.withRequestId(frame, wireId);
        },
        incoming(frame: Frame): Frame | null {
            const response = codec.readResponse(frame);
            // Before release only this adopter's own answers pass (they make it ready). The
            // answer to a held request stays in order behind the Agent output it follows:
            // a held turn must not settle before the output it produced is delivered.
            if (!ready && !(response && inFlight.has(response.id))) {
                waiting.push(frame);
                return null;
            }
            const sent = response ? inFlight.get(response.id) : undefined;
            const routed = route(frame);
            if (routed && !ready && sent && readyMethods.has(sent.method)) setImmediate(release);
            return routed;
        },
        heldRequests: () => [...held.entries()].map(([id, entry]) => Object.freeze({ id, method: entry.method, response: entry.response })),
        toWireId: (id: WireId) => toWire(id),
        release,
    });
}
