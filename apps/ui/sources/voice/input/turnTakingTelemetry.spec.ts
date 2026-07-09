import { beforeEach, describe, expect, it } from 'vitest';

import {
    createTurnTakingTelemetry,
    type TurnTakingTelemetryEvent,
} from './turnTakingTelemetry';

function recordedTypes(events: readonly TurnTakingTelemetryEvent[]): string[] {
    return events.map((event) => event.type);
}

describe('turnTakingTelemetry', () => {
    let now: number;
    const advance = (ms: number): void => {
        now += ms;
    };

    beforeEach(() => {
        now = 1_000;
    });

    it('records discrete turn-taking events and exposes a snapshot', () => {
        const telemetry = createTurnTakingTelemetry({ enabled: true, now: () => now });

        telemetry.recordEndpointConfirmed({ sessionId: 's1', source: 'native_vad', confirmLatencyMs: 720 });
        telemetry.recordBargeIn({ sessionId: 's1', source: 'web_vad' });
        telemetry.recordBackchannelSuppressed({ sessionId: 's1', reason: 'min_words' });
        telemetry.recordEchoSuppressed({ sessionId: 's1', reason: 'text_overlap' });

        const snapshot = telemetry.snapshot();
        expect(recordedTypes(snapshot.events)).toEqual([
            'endpoint_confirmed',
            'barge_in',
            'backchannel_suppressed',
            'echo_suppressed',
        ]);
        expect(snapshot.counters).toEqual({
            endpointConfirmed: 1,
            bargeIn: 1,
            backchannelSuppressed: 1,
            echoSuppressed: 1,
        });
        // Endpoint-confirm latency is carried on the discrete event (no high-frequency data).
        expect(snapshot.events[0]).toMatchObject({ type: 'endpoint_confirmed', confirmLatencyMs: 720 });
        // Timestamps are stamped from the injected clock.
        expect(snapshot.events[0].timestampMs).toBe(1_000);
    });

    it('is a no-op when disabled (records nothing, keeps zero counters)', () => {
        const telemetry = createTurnTakingTelemetry({ enabled: false, now: () => now });

        telemetry.recordBargeIn({ sessionId: 's1', source: 'native_vad' });
        telemetry.recordBackchannelSuppressed({ sessionId: 's1', reason: 'protected_head' });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toEqual([]);
        expect(snapshot.counters).toEqual({
            endpointConfirmed: 0,
            bargeIn: 0,
            backchannelSuppressed: 0,
            echoSuppressed: 0,
        });
    });

    it('drops malformed (negative latency / empty session) records without throwing', () => {
        const telemetry = createTurnTakingTelemetry({ enabled: true, now: () => now });

        telemetry.recordEndpointConfirmed({ sessionId: '   ', source: 'native_vad', confirmLatencyMs: 100 });
        telemetry.recordEndpointConfirmed({ sessionId: 's1', source: 'native_vad', confirmLatencyMs: -5 });

        expect(telemetry.snapshot().events).toEqual([]);
        expect(telemetry.snapshot().counters.endpointConfirmed).toBe(0);
    });

    it('redacts the raw session id to a stable ordinal and bounds the buffer to capacity', () => {
        const telemetry = createTurnTakingTelemetry({ enabled: true, now: () => now, capacity: 2 });

        telemetry.recordBargeIn({ sessionId: 'secret-session-a', source: 'native_vad' });
        advance(5);
        telemetry.recordBargeIn({ sessionId: 'secret-session-a', source: 'native_vad' });
        advance(5);
        telemetry.recordBargeIn({ sessionId: 'secret-session-b', source: 'web_vad' });

        const snapshot = telemetry.snapshot();
        // Capacity bound keeps the most recent two events.
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.droppedCount).toBe(1);
        // Counters keep the full lifetime total even after buffer trim.
        expect(snapshot.counters.bargeIn).toBe(3);
        // Raw ids never appear; same raw id maps to the same redacted ordinal.
        const sessionIds = snapshot.events.map((event) => event.sessionId);
        for (const id of sessionIds) {
            expect(id).toMatch(/^session:\d+$/);
            expect(id).not.toContain('secret');
        }
    });

    it('reset clears events and counters', () => {
        const telemetry = createTurnTakingTelemetry({ enabled: true, now: () => now });
        telemetry.recordBargeIn({ sessionId: 's1', source: 'native_vad' });
        telemetry.reset();
        expect(telemetry.snapshot().events).toEqual([]);
        expect(telemetry.snapshot().counters.bargeIn).toBe(0);
    });
});
