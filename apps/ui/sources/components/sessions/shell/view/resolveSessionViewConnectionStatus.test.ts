import { describe, expect, it } from 'vitest';

import { resolveSessionViewConnectionStatus } from './resolveSessionViewConnectionStatus';

const baseInput = {
    connectedServicesRestartState: null,
    restartingText: 'restarting connected service',
    switchFailedText: 'switch failed',
    resumingText: 'resuming',
    inactiveStatusText: null,
    sessionStatusText: 'ready',
    sessionStatusColor: 'status-color',
    sessionStatusDotColor: 'dot-color',
    sessionStatusPulsing: false,
    isResuming: false,
    isPendingQueueWakeResuming: false,
    isSessionStatusResuming: false,
} as const;

describe('resolveSessionViewConnectionStatus', () => {
    it.each(['restarting', 'pending_confirmation'] as const)(
        'prioritizes non-terminal connected-service restart state %s as the main status',
        (status) => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                connectedServicesRestartState: {
                    status,
                    attemptId: 'manual-auth-switch:1',
                    reason: 'manual_auth_switch',
                    startedAtMs: 1_000,
                },
                isSessionStatusResuming: true,
            })).toEqual({
                text: 'restarting connected service',
                color: 'status-color',
                dotColor: 'dot-color',
                isPulsing: true,
            });
        },
    );

    it('shows failed restart state only when positive failure evidence reaches the shared state', () => {
        expect(resolveSessionViewConnectionStatus({
            ...baseInput,
            connectedServicesRestartState: {
                status: 'failed',
                attemptId: 'manual-auth-switch:1',
                reason: 'manual_auth_switch',
                startedAtMs: 1_000,
            },
            inactiveStatusText: 'inactive',
        })).toEqual({
            text: 'switch failed',
            color: 'status-color',
            dotColor: 'dot-color',
            isPulsing: false,
        });
    });
});
