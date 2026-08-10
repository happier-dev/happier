import { ReduceMotion } from 'react-native-reanimated';
import { describe, expect, it } from 'vitest';

import { resolveSlideTransitionSpring, slideTransitionTokens } from './slideTransitionTokens';

const PRESETS = ['soft', 'compact'] as const;

/**
 * The physics are a visual lock, not a preference: these two curves were tuned against reference
 * screenshots. Routing them through the reduced-motion policy owner must not move them.
 */
const EXPECTED_PHYSICS = {
    soft: { stiffness: 140, damping: 18, mass: 0.9 },
    compact: { stiffness: 220, damping: 24, mass: 0.7 },
} as const;

describe('slide transition springs', () => {
    it.each(PRESETS)('%s keeps its tuned physics', (preset) => {
        const config = resolveSlideTransitionSpring(preset, { reducedMotion: false });

        expect(config.stiffness).toBe(EXPECTED_PHYSICS[preset].stiffness);
        expect(config.damping).toBe(EXPECTED_PHYSICS[preset].damping);
        expect(config.mass).toBe(EXPECTED_PHYSICS[preset].mass);
    });

    it.each(PRESETS)('%s answers the caller-supplied reduced-motion state, not the device setting', (preset) => {
        // `ReduceMotion.System` — the library default these configs used to carry — reads the OS
        // preference directly. Both slide adapters accept a `reducedMotion` PROP that overrides
        // that preference for every other branch they own, so the library default left the spring
        // disagreeing with the component wrapped around it.
        expect(resolveSlideTransitionSpring(preset, { reducedMotion: false }).reduceMotion).toBe(
            ReduceMotion.Never,
        );
        expect(resolveSlideTransitionSpring(preset, { reducedMotion: true }).reduceMotion).toBe(
            ReduceMotion.Always,
        );
    });

    it.each(PRESETS)('%s returns one stable config per reduced-motion state', (preset) => {
        // Both adapters list the spring in `useEffect` / `useImperativeHandle` dependency arrays.
        expect(resolveSlideTransitionSpring(preset, { reducedMotion: false })).toBe(
            resolveSlideTransitionSpring(preset, { reducedMotion: false }),
        );
        expect(resolveSlideTransitionSpring(preset, { reducedMotion: true })).toBe(
            resolveSlideTransitionSpring(preset, { reducedMotion: true }),
        );
    });

    it.each(PRESETS)('%s exposes no pre-stamped spring to bypass the policy with', (preset) => {
        expect('spring' in slideTransitionTokens[preset]).toBe(false);
    });

    it.each(PRESETS)('%s keeps its layout and blur tokens', (preset) => {
        const tokens = slideTransitionTokens[preset];
        expect(tokens.translatePx).toBe(preset === 'soft' ? 32 : 16);
        expect(tokens.maxBlurPx).toBe(preset === 'soft' ? 12 : 6);
        expect(tokens.nativeBlurIntensityScale).toBe(3);
    });
});
