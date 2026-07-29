import type { TurnEndpointSignalSource } from '@/voice/runtime/input/TurnEndpointController';

/**
 * Discrete conversational turn-taking telemetry (L3.T6).
 *
 * This is the canonical sink for the four turn-taking signals the hardening
 * plan wants to tune against: endpoint-confirm latency, automatic barge-in
 * count, backchannel-suppressed count, and echo-suppressed count. It mirrors the
 * in-repo `transcriptViewportTelemetry` owner: a bounded ring buffer of sanitized
 * discrete records plus lifetime counters, behind a hand-written sanitizer so
 * malformed inputs never throw and raw session ids never leak.
 *
 * DELIBERATE non-goals (kept off this path on purpose):
 *  - NO high-frequency level / amplitude / RMS data. The acoustic level lives on
 *    the runtime level store and its Reanimated SharedValue bridge; it never
 *    enters telemetry.
 *  - NO `console` logging path. Discrete events only; a dev snapshot accessor is
 *    the inspection surface.
 */

export type TurnTakingTelemetrySuppressionReason =
    | 'empty_transcript'
    | 'phrase_match'
    | 'min_words'
    | 'low_confidence'
    | 'protected_head';

export type TurnTakingTelemetryEchoReason = 'text_overlap' | 'tts_just_started';

export type TurnTakingTelemetryEvent =
    | Readonly<{
        type: 'endpoint_confirmed';
        sessionId: string;
        source: TurnEndpointSignalSource;
        /** Wall-clock latency from speech-start to the confirmed endpoint signal. */
        confirmLatencyMs: number;
        timestampMs: number;
    }>
    | Readonly<{
        type: 'barge_in';
        sessionId: string;
        source: TurnEndpointSignalSource;
        timestampMs: number;
    }>
    | Readonly<{
        type: 'backchannel_suppressed';
        sessionId: string;
        reason: TurnTakingTelemetrySuppressionReason;
        timestampMs: number;
    }>
    | Readonly<{
        type: 'echo_suppressed';
        sessionId: string;
        reason: TurnTakingTelemetryEchoReason;
        timestampMs: number;
    }>;

export type TurnTakingTelemetryCounters = Readonly<{
    endpointConfirmed: number;
    bargeIn: number;
    backchannelSuppressed: number;
    echoSuppressed: number;
}>;

export type TurnTakingTelemetrySnapshot = Readonly<{
    events: readonly TurnTakingTelemetryEvent[];
    counters: TurnTakingTelemetryCounters;
    droppedCount: number;
}>;

export type TurnTakingTelemetry = Readonly<{
    recordEndpointConfirmed: (args: Readonly<{
        sessionId: string;
        source: TurnEndpointSignalSource;
        confirmLatencyMs: number;
    }>) => void;
    recordBargeIn: (args: Readonly<{
        sessionId: string;
        source: TurnEndpointSignalSource;
    }>) => void;
    recordBackchannelSuppressed: (args: Readonly<{
        sessionId: string;
        reason: TurnTakingTelemetrySuppressionReason;
    }>) => void;
    recordEchoSuppressed: (args: Readonly<{
        sessionId: string;
        reason: TurnTakingTelemetryEchoReason;
    }>) => void;
    snapshot: () => TurnTakingTelemetrySnapshot;
    isEnabled: () => boolean;
    reset: () => void;
}>;

export type TurnTakingTelemetryOptions = Readonly<{
    enabled?: boolean;
    now?: () => number;
    capacity?: number;
}>;

const DEFAULT_TURN_TAKING_TELEMETRY_CAPACITY = 256;

function normalizeCapacity(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_TURN_TAKING_TELEMETRY_CAPACITY;
    }
    return Math.max(1, Math.min(100_000, Math.trunc(value)));
}

function normalizeSessionId(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isNonNegativeFinite(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
}

export function createTurnTakingTelemetry(options: TurnTakingTelemetryOptions = {}): TurnTakingTelemetry {
    const enabled = options.enabled === true;
    const now = options.now ?? (() => Date.now());
    const capacity = normalizeCapacity(options.capacity);

    let events: TurnTakingTelemetryEvent[] = [];
    let rawSessionIds: string[] = [];
    let droppedCount = 0;
    const counters = {
        endpointConfirmed: 0,
        bargeIn: 0,
        backchannelSuppressed: 0,
        echoSuppressed: 0,
    };

    const redactedSessionIds = new Map<string, string>();
    let nextSessionOrdinal = 1;
    const redactSessionId = (rawSessionId: string): string => {
        const existing = redactedSessionIds.get(rawSessionId);
        if (existing) {
            return existing;
        }
        const redacted = `session:${nextSessionOrdinal}`;
        nextSessionOrdinal += 1;
        redactedSessionIds.set(rawSessionId, redacted);
        return redacted;
    };

    const pruneRedactionsToBuffer = (): void => {
        const retained = new Set(rawSessionIds);
        for (const rawSessionId of redactedSessionIds.keys()) {
            if (!retained.has(rawSessionId)) {
                redactedSessionIds.delete(rawSessionId);
            }
        }
    };

    const trimToCapacity = (): void => {
        if (events.length <= capacity) {
            return;
        }
        const overflow = events.length - capacity;
        events = events.slice(overflow);
        rawSessionIds = rawSessionIds.slice(overflow);
        droppedCount += overflow;
        pruneRedactionsToBuffer();
    };

    const push = (rawSessionId: string, build: (redactedSessionId: string, timestampMs: number) => TurnTakingTelemetryEvent): void => {
        const redacted = redactSessionId(rawSessionId);
        events.push(build(redacted, now()));
        rawSessionIds.push(rawSessionId);
        trimToCapacity();
    };

    return {
        recordEndpointConfirmed: ({ sessionId, source, confirmLatencyMs }) => {
            if (!enabled) {
                return;
            }
            const rawSessionId = normalizeSessionId(sessionId);
            if (!rawSessionId || !isNonNegativeFinite(confirmLatencyMs)) {
                return;
            }
            counters.endpointConfirmed += 1;
            push(rawSessionId, (redactedSessionId, timestampMs) => ({
                type: 'endpoint_confirmed',
                sessionId: redactedSessionId,
                source,
                confirmLatencyMs: Math.trunc(confirmLatencyMs),
                timestampMs,
            }));
        },
        recordBargeIn: ({ sessionId, source }) => {
            if (!enabled) {
                return;
            }
            const rawSessionId = normalizeSessionId(sessionId);
            if (!rawSessionId) {
                return;
            }
            counters.bargeIn += 1;
            push(rawSessionId, (redactedSessionId, timestampMs) => ({
                type: 'barge_in',
                sessionId: redactedSessionId,
                source,
                timestampMs,
            }));
        },
        recordBackchannelSuppressed: ({ sessionId, reason }) => {
            if (!enabled) {
                return;
            }
            const rawSessionId = normalizeSessionId(sessionId);
            if (!rawSessionId) {
                return;
            }
            counters.backchannelSuppressed += 1;
            push(rawSessionId, (redactedSessionId, timestampMs) => ({
                type: 'backchannel_suppressed',
                sessionId: redactedSessionId,
                reason,
                timestampMs,
            }));
        },
        recordEchoSuppressed: ({ sessionId, reason }) => {
            if (!enabled) {
                return;
            }
            const rawSessionId = normalizeSessionId(sessionId);
            if (!rawSessionId) {
                return;
            }
            counters.echoSuppressed += 1;
            push(rawSessionId, (redactedSessionId, timestampMs) => ({
                type: 'echo_suppressed',
                sessionId: redactedSessionId,
                reason,
                timestampMs,
            }));
        },
        snapshot: () => ({
            events: events.map((event) => ({ ...event })),
            counters: { ...counters },
            droppedCount,
        }),
        isEnabled: () => enabled,
        reset: () => {
            events = [];
            rawSessionIds = [];
            droppedCount = 0;
            counters.endpointConfirmed = 0;
            counters.bargeIn = 0;
            counters.backchannelSuppressed = 0;
            counters.echoSuppressed = 0;
            redactedSessionIds.clear();
            nextSessionOrdinal = 1;
        },
    };
}

/**
 * Process-wide singleton sink. Disabled by default so production carries no
 * overhead; dev/QA flips it on to collect counters. A dev snapshot accessor is
 * installed lazily for inspection (no console logging path).
 */
export const turnTakingTelemetry = createTurnTakingTelemetry({
    enabled: typeof __DEV__ !== 'undefined' && __DEV__ === true,
});
