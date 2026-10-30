import { describe, expect, it } from 'vitest';

import { createTurnPolicyEndpointGate } from './turnPolicyEndpointGate';

describe('createTurnPolicyEndpointGate', () => {
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
        clock = 50; // Still unconfirmed: a no-op reset would suppress the endpoint.
        gate.reset();
        // After reset, an immediate endpoint without a fresh start is treated as a
        // confirmed VAD-only edge (emits), proving the prior turn was cleared.
        expect(gate.shouldEmitEndpoint()).toBe(true);
        expect(gate.getLastSegmentDurationMs()).toBeNull();

        clock = 1_000;
        gate.noteSpeechDetected();
        clock = 1_050;
        expect(gate.shouldEmitEndpoint()).toBe(false);

        clock = 2_000;
        gate.noteSpeechDetected();
        clock = 2_150;
        expect(gate.shouldEmitEndpoint()).toBe(true);
        expect(gate.getLastSegmentDurationMs()).toBe(150);
    });
});
