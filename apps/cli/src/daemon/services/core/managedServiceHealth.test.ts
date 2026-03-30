import { describe, expect, it } from 'vitest';

import { deriveManagedServiceHealth } from './managedServiceHealth';

describe('managedServiceHealth', () => {
    it('reports running services as healthy', () => {
        expect(deriveManagedServiceHealth({ lifecycleState: 'running' })).toEqual({
            status: 'healthy',
            isDegraded: false,
            reason: null,
        });
    });

    it('treats transitional lifecycle states as pending instead of degraded', () => {
        expect(deriveManagedServiceHealth({ lifecycleState: 'starting' })).toEqual({
            status: 'pending',
            isDegraded: false,
            reason: 'starting',
        });

        expect(deriveManagedServiceHealth({ lifecycleState: 'stopping' })).toEqual({
            status: 'pending',
            isDegraded: false,
            reason: 'stopping',
        });
    });

    it('marks explicitly degraded lifecycle states as degraded', () => {
        expect(deriveManagedServiceHealth({ lifecycleState: 'degraded' })).toEqual({
            status: 'degraded',
            isDegraded: true,
            reason: 'lifecycle_degraded',
        });
    });

    it('surfaces crashed services with a scheduled restart as degraded recovery', () => {
        expect(
            deriveManagedServiceHealth({
                lifecycleState: 'crashed',
                lastRestartDecision: {
                    type: 'restart_after_delay',
                    attempt: 2,
                    delayMs: 500,
                },
            }),
        ).toEqual({
            status: 'degraded',
            isDegraded: true,
            reason: 'restart_scheduled',
        });
    });

    it('treats stopped or exhausted crashed services as offline', () => {
        expect(deriveManagedServiceHealth({ lifecycleState: 'stopped' })).toEqual({
            status: 'offline',
            isDegraded: false,
            reason: 'stopped',
        });

        expect(
            deriveManagedServiceHealth({
                lifecycleState: 'crashed',
                lastRestartDecision: {
                    type: 'do_not_restart',
                    reason: 'max_restart_attempts_exhausted',
                },
            }),
        ).toEqual({
            status: 'offline',
            isDegraded: false,
            reason: 'restart_exhausted',
        });
    });
});
