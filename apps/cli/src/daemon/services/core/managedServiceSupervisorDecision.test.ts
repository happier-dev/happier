import { describe, expect, it } from 'vitest';

import { decideManagedServiceSupervisorAction } from './managedServiceSupervisorDecision';

describe('managedServiceSupervisorDecision', () => {
    it('starts stopped services immediately while preserving offline health', () => {
        expect(
            decideManagedServiceSupervisorAction({
                lifecycleState: 'stopped',
                completedRestartCount: 0,
                restartPolicy: {
                    maxRestartAttempts: 3,
                    baseDelayMs: 100,
                    maxDelayMs: 1_000,
                    jitterMs: 0,
                },
                random: () => 0,
            }),
        ).toEqual({
            type: 'start',
            health: {
                status: 'offline',
                isDegraded: false,
                reason: 'stopped',
            },
        });
    });

    it('waits while healthy and transitional services are already converging', () => {
        expect(
            decideManagedServiceSupervisorAction({
                lifecycleState: 'running',
                completedRestartCount: 0,
                restartPolicy: {
                    maxRestartAttempts: 3,
                    baseDelayMs: 100,
                    maxDelayMs: 1_000,
                    jitterMs: 0,
                },
                random: () => 0,
            }),
        ).toEqual({
            type: 'wait',
            health: {
                status: 'healthy',
                isDegraded: false,
                reason: null,
            },
        });

        expect(
            decideManagedServiceSupervisorAction({
                lifecycleState: 'starting',
                completedRestartCount: 0,
                restartPolicy: {
                    maxRestartAttempts: 3,
                    baseDelayMs: 100,
                    maxDelayMs: 1_000,
                    jitterMs: 0,
                },
                random: () => 0,
            }),
        ).toEqual({
            type: 'wait',
            health: {
                status: 'pending',
                isDegraded: false,
                reason: 'starting',
            },
        });
    });

    it('schedules crashed services for restart when the policy still allows recovery', () => {
        expect(
            decideManagedServiceSupervisorAction({
                lifecycleState: 'crashed',
                completedRestartCount: 1,
                restartPolicy: {
                    maxRestartAttempts: 3,
                    baseDelayMs: 100,
                    maxDelayMs: 1_000,
                    jitterMs: 0,
                },
                random: () => 0,
            }),
        ).toEqual({
            type: 'restart_after_delay',
            restartDecision: {
                type: 'restart_after_delay',
                attempt: 2,
                delayMs: 200,
            },
            health: {
                status: 'degraded',
                isDegraded: true,
                reason: 'restart_scheduled',
            },
        });
    });

    it('stops retrying crashed services after restart attempts are exhausted', () => {
        expect(
            decideManagedServiceSupervisorAction({
                lifecycleState: 'crashed',
                completedRestartCount: 1,
                restartPolicy: {
                    maxRestartAttempts: 1,
                    baseDelayMs: 100,
                    maxDelayMs: 1_000,
                    jitterMs: 0,
                },
                random: () => 0,
            }),
        ).toEqual({
            type: 'do_not_restart',
            restartDecision: {
                type: 'do_not_restart',
                reason: 'max_restart_attempts_exhausted',
            },
            health: {
                status: 'offline',
                isDegraded: false,
                reason: 'restart_exhausted',
            },
        });
    });
});
