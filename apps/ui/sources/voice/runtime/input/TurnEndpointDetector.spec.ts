import { describe, expect, it } from 'vitest';

import { computeTurnEndpointDelayMs, normalizeTurnEndpointPolicy } from './TurnEndpointDetector';

describe('TurnEndpointDetector', () => {
    it('computes delay as max(silenceMs, minSpeechMs - elapsedMs, 0)', () => {
        const policy = normalizeTurnEndpointPolicy({ silenceMs: 450, minSpeechMs: 120 });
        expect(computeTurnEndpointDelayMs(policy, 10)).toBe(450);
        expect(computeTurnEndpointDelayMs(policy, 120)).toBe(450);
        expect(computeTurnEndpointDelayMs(policy, 800)).toBe(450);
    });

    it('waits for min speech duration when elapsed speech is shorter than minSpeechMs', () => {
        const policy = normalizeTurnEndpointPolicy({ silenceMs: 50, minSpeechMs: 300 });
        expect(computeTurnEndpointDelayMs(policy, 0)).toBe(300);
        expect(computeTurnEndpointDelayMs(policy, 120)).toBe(180);
        expect(computeTurnEndpointDelayMs(policy, 280)).toBe(50);
    });

    it('clamps invalid values into supported bounds', () => {
        const low = normalizeTurnEndpointPolicy({ silenceMs: -100, minSpeechMs: -5 });
        expect(low.silenceMs).toBe(0);
        expect(low.minSpeechMs).toBe(0);

        const high = normalizeTurnEndpointPolicy({ silenceMs: 99_999, minSpeechMs: 99_999 });
        expect(high.silenceMs).toBe(5_000);
        expect(high.minSpeechMs).toBe(5_000);
    });
});
