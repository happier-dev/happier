import { describe, expect, it } from 'vitest';

import { createTurnPolicyEndpointGate } from './turnPolicyEndpointGate';

describe('createTurnPolicyEndpointGate', () => {
    it('suppresses a candidate endpoint whose speech segment is shorter than confirmMs (false-start debounce)', () => {
        let clock = 0;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 800, silenceMs: 700 },
            now: () => clock,
        });

        // Speech started at t=0, candidate endpoint at t=400 (< confirmMs).
        gate.noteSpeechDetected();
        clock = 400;
        expect(gate.shouldEmitEndpoint()).toBe(false);
    });

    it('emits a candidate endpoint once the speech segment has been sustained past confirmMs', () => {
        let clock = 0;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 800, silenceMs: 700 },
            now: () => clock,
        });

        gate.noteSpeechDetected();
        clock = 900; // sustained past confirmMs before the endpoint arrives
        expect(gate.shouldEmitEndpoint()).toBe(true);
    });

    it('treats a candidate endpoint with no observed speech-start as a confirmed turn (no regression for VAD-only edges)', () => {
        let clock = 1_000;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 800, silenceMs: 700 },
            now: () => clock,
        });

        // No noteSpeechDetected() was called (the live VAD fires onSpeechEnd only);
        // the gate must not silently drop a real endpoint.
        expect(gate.shouldEmitEndpoint()).toBe(true);
    });

    it('re-arms after a false start so a subsequent sustained turn still emits', () => {
        let clock = 0;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 800, silenceMs: 700 },
            now: () => clock,
        });

        gate.noteSpeechDetected();
        clock = 300;
        expect(gate.shouldEmitEndpoint()).toBe(false); // false start dropped

        clock = 1_000;
        gate.noteSpeechDetected();
        clock = 2_000; // sustained > confirmMs
        expect(gate.shouldEmitEndpoint()).toBe(true);
    });

    it('reports the speech-segment duration (speech-start → endpoint) for the emitted turn', () => {
        let clock = 0;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 800, silenceMs: 700 },
            now: () => clock,
        });

        gate.noteSpeechDetected();
        clock = 1_500; // sustained past confirmMs
        expect(gate.shouldEmitEndpoint()).toBe(true);
        // The candidate utterance spanned start (t=0) → endpoint (t=1500).
        expect(gate.getLastSegmentDurationMs()).toBe(1_500);
    });

    it('reports null segment duration for a VAD-only edge with no observed speech-start', () => {
        let clock = 1_000;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 800, silenceMs: 700 },
            now: () => clock,
        });

        expect(gate.shouldEmitEndpoint()).toBe(true);
        // No start edge was observed, so the duration is genuinely unknown.
        expect(gate.getLastSegmentDurationMs()).toBeNull();
    });

    it('reset() discards any in-flight confirming/speaking turn', () => {
        let clock = 0;
        const gate = createTurnPolicyEndpointGate({
            policy: { confirmMs: 100, silenceMs: 700 },
            now: () => clock,
        });

        gate.noteSpeechDetected();
        clock = 500; // would be speaking
        gate.reset();
        // After reset, an immediate endpoint without a fresh start is treated as a
        // confirmed VAD-only edge (emits), proving the prior turn was cleared.
        expect(gate.shouldEmitEndpoint()).toBe(true);
    });
});
