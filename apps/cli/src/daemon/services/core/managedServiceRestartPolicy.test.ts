import { describe, expect, it } from 'vitest';

import {
    createManagedServiceRestartDecision,
    normalizeManagedServiceRestartPolicy,
    type ManagedServiceRestartPolicy,
} from './managedServiceRestartPolicy';

describe('managedServiceRestartPolicy', () => {
    it('normalizes restart policy values into safe bounds', () => {
        const normalized = normalizeManagedServiceRestartPolicy({
            maxRestartAttempts: -10,
            baseDelayMs: -1,
            maxDelayMs: 25,
            jitterMs: -50,
        });

        expect(normalized).toEqual({
            maxRestartAttempts: 0,
            baseDelayMs: 0,
            maxDelayMs: 25,
            jitterMs: 0,
        });
    });

    it('preserves unlimited restart attempts when the policy opts in with null', () => {
        const policy = normalizeManagedServiceRestartPolicy({
            maxRestartAttempts: null,
            baseDelayMs: 100,
            maxDelayMs: 1_000,
            jitterMs: 10,
        });

        expect(policy.maxRestartAttempts).toBeNull();
    });

    it('schedules bounded exponential restart delays', () => {
        const policy: ManagedServiceRestartPolicy = {
            maxRestartAttempts: 3,
            baseDelayMs: 100,
            maxDelayMs: 250,
            jitterMs: 0,
        };

        expect(createManagedServiceRestartDecision({ policy, completedRestartCount: 0, random: () => 0 })).toEqual({
            type: 'restart_after_delay',
            attempt: 1,
            delayMs: 100,
        });

        expect(createManagedServiceRestartDecision({ policy, completedRestartCount: 1, random: () => 0 })).toEqual({
            type: 'restart_after_delay',
            attempt: 2,
            delayMs: 200,
        });

        expect(createManagedServiceRestartDecision({ policy, completedRestartCount: 2, random: () => 0 })).toEqual({
            type: 'restart_after_delay',
            attempt: 3,
            delayMs: 250,
        });
    });

    it('adds jitter and stops when the attempt budget is exhausted', () => {
        const policy: ManagedServiceRestartPolicy = {
            maxRestartAttempts: 1,
            baseDelayMs: 100,
            maxDelayMs: 1_000,
            jitterMs: 10,
        };

        expect(createManagedServiceRestartDecision({ policy, completedRestartCount: 0, random: () => 1 })).toEqual({
            type: 'restart_after_delay',
            attempt: 1,
            delayMs: 111,
        });

        expect(createManagedServiceRestartDecision({ policy, completedRestartCount: 1, random: () => 0.5 })).toEqual({
            type: 'do_not_restart',
            reason: 'max_restart_attempts_exhausted',
        });
    });
});
