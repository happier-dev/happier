import { describe, expect, it } from 'vitest';

import {
    createTurnPolicyMachine,
    DEFAULT_TURN_POLICY,
    normalizeTurnPolicy,
} from './turnPolicyMachine';

describe('turnPolicyMachine', () => {
    it('exposes documented defaults', () => {
        expect(DEFAULT_TURN_POLICY).toEqual({ confirmMs: 800, silenceMs: 700 });
    });

    it('clamps invalid policy values into bounds', () => {
        expect(normalizeTurnPolicy({ confirmMs: -10, silenceMs: 99_999 })).toEqual({
            confirmMs: 0,
            silenceMs: 5_000,
        });
        expect(normalizeTurnPolicy({})).toEqual(DEFAULT_TURN_POLICY);
    });

    it('confirms speech only after confirmMs of sustained detection (false-start debounce)', () => {
        const machine = createTurnPolicyMachine({ policy: { confirmMs: 800, silenceMs: 700 } });
        // Detection that drops before confirmMs is discarded as a false start.
        expect(machine.step({ detected: true, windowTimeMs: 0 })).toBeNull();
        expect(machine.step({ detected: true, windowTimeMs: 400 })).toBeNull();
        expect(machine.step({ detected: false, windowTimeMs: 500 })).toBeNull();
        expect(machine.phase()).toBe('idle');

        // Sustained detection past confirmMs emits speech_started.
        expect(machine.step({ detected: true, windowTimeMs: 600 })).toBeNull();
        expect(machine.step({ detected: true, windowTimeMs: 1_500 })).toEqual({ kind: 'speech_started' });
        expect(machine.phase()).toBe('speaking');
    });

    it('ends the turn after silenceMs of trailing silence and resumes on re-detection', () => {
        const machine = createTurnPolicyMachine({ policy: { confirmMs: 100, silenceMs: 700 } });
        machine.step({ detected: true, windowTimeMs: 0 });
        machine.step({ detected: true, windowTimeMs: 200 });
        expect(machine.phase()).toBe('speaking');

        // Silence begins; re-detection before silenceMs resumes speaking.
        expect(machine.step({ detected: false, windowTimeMs: 300 })).toBeNull();
        expect(machine.phase()).toBe('ending');
        expect(machine.step({ detected: true, windowTimeMs: 500 })).toBeNull();
        expect(machine.phase()).toBe('speaking');

        // Sustained silence past silenceMs ends the turn.
        machine.step({ detected: false, windowTimeMs: 600 });
        expect(machine.step({ detected: false, windowTimeMs: 1_400 })).toEqual({ kind: 'speech_stopped' });
        expect(machine.phase()).toBe('idle');
    });

    it('flush() force-ends a speaking/ending turn and discards an unconfirmed one', () => {
        const speaking = createTurnPolicyMachine({ policy: { confirmMs: 100, silenceMs: 700 } });
        speaking.step({ detected: true, windowTimeMs: 0 });
        speaking.step({ detected: true, windowTimeMs: 200 });
        expect(speaking.flush({ windowTimeMs: 300 })).toEqual({ kind: 'speech_stopped' });
        expect(speaking.phase()).toBe('idle');

        const confirming = createTurnPolicyMachine({ policy: { confirmMs: 800, silenceMs: 700 } });
        confirming.step({ detected: true, windowTimeMs: 0 });
        expect(confirming.phase()).toBe('confirming');
        expect(confirming.flush({ windowTimeMs: 100 })).toBeNull();
        expect(confirming.phase()).toBe('idle');

        const idle = createTurnPolicyMachine({ policy: DEFAULT_TURN_POLICY });
        expect(idle.flush({ windowTimeMs: 0 })).toBeNull();
    });
});
