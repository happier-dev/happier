import { describe, expect, it } from 'vitest';

import { canSendMessagesToExecutionRun } from './canSendMessagesToExecutionRun';

describe('canSendMessagesToExecutionRun', () => {
    it('returns true for running bounded backend runs', () => {
        expect(canSendMessagesToExecutionRun({
            status: 'running',
            intent: 'review',
            runClass: 'bounded',
        })).toBe(true);
    });

    it('returns false for bounded runs that are no longer in flight', () => {
        expect(canSendMessagesToExecutionRun({
            status: 'running',
            intent: 'review',
            runClass: 'bounded',
            turnInFlight: false,
        })).toBe(false);
    });

    it('returns true for running execution runs when runClass is missing for transcript backward compatibility', () => {
        expect(canSendMessagesToExecutionRun({
            status: 'running',
            intent: 'review',
        })).toBe(true);
    });

    it('returns true for running long-lived backend runs', () => {
        expect(canSendMessagesToExecutionRun({
            status: 'running',
            intent: 'delegate',
            runClass: 'long_lived',
        })).toBe(true);
    });

    it('returns false for running voice-agent runs', () => {
        expect(canSendMessagesToExecutionRun({
            status: 'running',
            intent: 'voice_agent',
            runClass: 'long_lived',
        })).toBe(false);
    });

    it('returns false when the run is no longer running', () => {
        expect(canSendMessagesToExecutionRun({
            status: 'succeeded',
            intent: 'review',
            runClass: 'bounded',
        })).toBe(false);
    });
});
