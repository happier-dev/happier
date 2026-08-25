import { describe, expect, it } from 'vitest';

import { createSyncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';

import { recordSessionMessageDeliveryDecision } from './sessionMessageDeliveryTelemetry';

describe('recordSessionMessageDeliveryDecision', () => {
    it('uses the canonical pending-support decision for opaque development CLI identities', () => {
        const telemetry = createSyncReliabilityTelemetry({
            now: () => 123,
            randomId: () => 'event-1',
        });

        recordSessionMessageDeliveryDecision({
            sessionId: 'session-1',
            session: {
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                pendingVersion: 1,
                metadata: { version: 'runner-snapshot-abc123' },
            } as any,
            selectedMode: 'server_pending',
            configuredMode: 'server_pending',
            telemetry,
        });

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                fields: expect.objectContaining({
                    pendingSupportState: 'supported',
                }),
            }),
        ]);
    });
});
