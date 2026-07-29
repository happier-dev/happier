import { describe, expect, it } from 'vitest';

import { INSTRUMENT_DURATIONS } from './motionTokens';
import { resolveMotionPreferences, type MotionPreferencesInput } from './useMotionPreferences';

function input(overrides: Partial<MotionPreferencesInput> = {}): MotionPreferencesInput {
    return {
        visualEffectsLevel: 'full',
        animatedNumbers: true,
        contextGaugeStyle: 'gauge',
        osReduceMotion: false,
        isWeb: false,
        ...overrides,
    };
}

describe('resolveMotionPreferences', () => {
    it('full level enables effects, travel entrance, numbers and haptics (native)', () => {
        const p = resolveMotionPreferences(input({ visualEffectsLevel: 'full' }));
        expect(p.level).toBe('full');
        expect(p.effectsEnabled).toBe(true);
        expect(p.entrance).toEqual({ kind: 'travel', durationMs: INSTRUMENT_DURATIONS.entrance });
        expect(p.animatedNumbersEnabled).toBe(true);
        expect(p.hapticsEnabled).toBe(true);
        expect(p.reduceMotion).toBe(false);
    });

    it('subtle level keeps travel entrance + numbers but disables shader effects', () => {
        const p = resolveMotionPreferences(input({ visualEffectsLevel: 'subtle' }));
        expect(p.level).toBe('subtle');
        expect(p.effectsEnabled).toBe(false);
        expect(p.entrance.kind).toBe('travel');
        expect(p.animatedNumbersEnabled).toBe(true);
        expect(p.hapticsEnabled).toBe(true);
    });

    it('minimal level: crossfade only, effects off, numbers off, haptics off', () => {
        const p = resolveMotionPreferences(input({ visualEffectsLevel: 'minimal' }));
        expect(p.level).toBe('minimal');
        expect(p.effectsEnabled).toBe(false);
        expect(p.entrance).toEqual({ kind: 'crossfade', durationMs: INSTRUMENT_DURATIONS.crossfadeMinimal });
        expect(p.animatedNumbersEnabled).toBe(false);
        expect(p.hapticsEnabled).toBe(false);
    });

    it('OS reduce-motion FORCES minimal regardless of the chosen level', () => {
        for (const chosen of ['full', 'subtle', 'minimal'] as const) {
            const p = resolveMotionPreferences(input({ visualEffectsLevel: chosen, osReduceMotion: true }));
            expect(p.level).toBe('minimal');
            expect(p.effectsEnabled).toBe(false);
            expect(p.entrance.kind).toBe('crossfade');
            expect(p.animatedNumbersEnabled).toBe(false);
            expect(p.hapticsEnabled).toBe(false);
            expect(p.reduceMotion).toBe(true);
        }
    });

    it('web disables haptics even at full level', () => {
        const p = resolveMotionPreferences(input({ visualEffectsLevel: 'full', isWeb: true }));
        expect(p.hapticsEnabled).toBe(false);
        // effects/animated-numbers remain available on web (tier selection handles Skia).
        expect(p.effectsEnabled).toBe(true);
        expect(p.animatedNumbersEnabled).toBe(true);
    });

    it('animatedNumbers=false disables number rolls but keeps other effects', () => {
        const p = resolveMotionPreferences(input({ animatedNumbers: false, visualEffectsLevel: 'full' }));
        expect(p.animatedNumbersEnabled).toBe(false);
        expect(p.effectsEnabled).toBe(true);
    });

    it('passes contextGaugeStyle through untouched', () => {
        expect(resolveMotionPreferences(input({ contextGaugeStyle: 'text' })).contextGaugeStyle).toBe('text');
        expect(resolveMotionPreferences(input({ contextGaugeStyle: 'hidden' })).contextGaugeStyle).toBe('hidden');
    });
});
