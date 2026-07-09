import { describe, expect, it } from 'vitest';

import { normalizeTurnEndpointPolicy } from '@/voice/runtime/input/TurnEndpointDetector';
import {
    createNoopSemanticEndpointDetector,
    resolveSemanticEndpointDelayMs,
    type SemanticEndpointDetector,
} from './SemanticEndpointDetector';

describe('SemanticEndpointDetector', () => {
    const policy = normalizeTurnEndpointPolicy({ silenceMs: 700, minSpeechMs: 800 });

    it('default no-op detector returns an undecided result (defers to the silence policy)', () => {
        const detector = createNoopSemanticEndpointDetector();
        expect(detector.evaluate({ transcript: 'are you sure about', speechElapsedMs: 1_000 })).toEqual({
            kind: 'undecided',
        });
    });

    it('resolveSemanticEndpointDelayMs falls back to the silence-policy delay when undecided', () => {
        const detector = createNoopSemanticEndpointDetector();
        const baseDelayMs = 700;
        const resolved = resolveSemanticEndpointDelayMs({
            detector,
            policy,
            baseDelayMs,
            transcript: 'are you sure about',
            speechElapsedMs: 1_000,
        });
        expect(resolved).toBe(baseDelayMs);
    });

    it('a "complete" semantic verdict shortens the wait to the confident floor (never below 0)', () => {
        const eagerDetector: SemanticEndpointDetector = {
            evaluate: () => ({ kind: 'complete', confidence: 0.9 }),
        };
        const resolved = resolveSemanticEndpointDelayMs({
            detector: eagerDetector,
            policy,
            baseDelayMs: 700,
            transcript: 'thanks that is all',
            speechElapsedMs: 1_500,
        });
        expect(resolved).toBe(0);
    });

    it('an "incomplete" semantic verdict extends the wait toward the hard-max ceiling', () => {
        const patientDetector: SemanticEndpointDetector = {
            evaluate: () => ({ kind: 'incomplete', confidence: 0.8 }),
        };
        const resolved = resolveSemanticEndpointDelayMs({
            detector: patientDetector,
            policy,
            baseDelayMs: 700,
            transcript: 'and then i also need',
            speechElapsedMs: 1_500,
            maxDelayMs: 3_000,
        });
        expect(resolved).toBeGreaterThan(700);
        expect(resolved).toBeLessThanOrEqual(3_000);
    });

    it('never returns a delay above the hard-max ceiling even for the base policy delay', () => {
        const detector = createNoopSemanticEndpointDetector();
        const resolved = resolveSemanticEndpointDelayMs({
            detector,
            policy,
            baseDelayMs: 9_999,
            transcript: 'something',
            speechElapsedMs: 100,
            maxDelayMs: 3_000,
        });
        expect(resolved).toBe(3_000);
    });
});
