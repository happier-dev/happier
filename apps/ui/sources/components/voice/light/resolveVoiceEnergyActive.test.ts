import { describe, expect, it } from 'vitest';

import {
    resolveVoiceEnergyActive,
    type VoiceEnergyActivationInputs,
} from './resolveVoiceEnergyActive';

/** A surface that could animate *and* has something to animate about. */
const LIVE: VoiceEnergyActivationInputs = {
    runtimeMotionActive: true,
    providerReady: true,
    motionAllowed: true,
    hasVisibleConsumer: true,
    audioAmplitudePresent: true,
    settleTransitionPending: false,
};

const GATES = [
    'runtimeMotionActive',
    'providerReady',
    'motionAllowed',
    'hasVisibleConsumer',
] as const satisfies readonly (keyof VoiceEnergyActivationInputs)[];

const LIVENESS = [
    'audioAmplitudePresent',
    'settleTransitionPending',
] as const satisfies readonly (keyof VoiceEnergyActivationInputs)[];

describe('resolveVoiceEnergyActive', () => {
    it.each(GATES)('stays still when %s is false', (gate) => {
        expect(resolveVoiceEnergyActive({ ...LIVE, [gate]: false })).toBe(false);
    });

    it('stays still when every gate is open but nothing is happening', () => {
        // The clause that makes idle *actually* idle. Without it a mounted,
        // visible, motion-allowed Voice surface runs a 60 Hz loop all day while
        // the planet is meant to be motionless (§2.4a) — and no screenshot would
        // ever show it.
        expect(resolveVoiceEnergyActive({ ...LIVE, audioAmplitudePresent: false })).toBe(false);
    });

    it.each(LIVENESS)('runs the clock when only %s is true', (term) => {
        const idle: VoiceEnergyActivationInputs = {
            ...LIVE,
            audioAmplitudePresent: false,
            settleTransitionPending: false,
        };
        expect(resolveVoiceEnergyActive({ ...idle, [term]: true })).toBe(true);
    });
});
