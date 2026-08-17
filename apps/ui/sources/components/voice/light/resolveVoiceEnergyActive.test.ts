import { describe, expect, it } from 'vitest';

import {
    resolveVoiceEnergyActive,
    type VoiceEnergyActivationInputs,
} from './resolveVoiceEnergyActive';

/** A surface that could animate *and* has something to animate about. */
const LIVE: VoiceEnergyActivationInputs = {
    runtimeVisible: true,
    providerReady: true,
    motionAllowed: true,
    hasVisibleConsumer: true,
    attemptActive: true,
    inputSourceActive: false,
    outputSourceActive: false,
    settleTransitionPending: false,
};

const GATES = [
    'runtimeVisible',
    'providerReady',
    'motionAllowed',
    'hasVisibleConsumer',
] as const satisfies readonly (keyof VoiceEnergyActivationInputs)[];

const LIVENESS = [
    'attemptActive',
    'inputSourceActive',
    'outputSourceActive',
    'settleTransitionPending',
] as const satisfies readonly (keyof VoiceEnergyActivationInputs)[];

describe('resolveVoiceEnergyActive', () => {
    it('runs the clock when a viewable surface has a live conversation', () => {
        expect(resolveVoiceEnergyActive(LIVE)).toBe(true);
    });

    it.each(GATES)('stays still when %s is false', (gate) => {
        expect(resolveVoiceEnergyActive({ ...LIVE, [gate]: false })).toBe(false);
    });

    it('stays still when every gate is open but nothing is happening', () => {
        // The clause that makes idle *actually* idle. Without it a mounted,
        // visible, motion-allowed Voice surface runs a 60 Hz loop all day while
        // the planet is meant to be motionless (§2.4a) — and no screenshot would
        // ever show it.
        expect(resolveVoiceEnergyActive({ ...LIVE, attemptActive: false })).toBe(false);
    });

    it.each(LIVENESS)('runs the clock when only %s is true', (term) => {
        const idle: VoiceEnergyActivationInputs = {
            ...LIVE,
            attemptActive: false,
            inputSourceActive: false,
            outputSourceActive: false,
            settleTransitionPending: false,
        };
        expect(resolveVoiceEnergyActive({ ...idle, [term]: true })).toBe(true);
    });

    it('keeps audio alone from overriding a closed gate', () => {
        // Amplitude can still arrive from a channel that has not been torn down;
        // it must not reopen a gate the user or the host closed.
        expect(resolveVoiceEnergyActive({
            ...LIVE,
            motionAllowed: false,
            inputSourceActive: true,
            outputSourceActive: true,
        })).toBe(false);
    });
});
