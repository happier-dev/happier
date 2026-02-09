import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    computeNextAcpConfigOptionOverrideMetadata,
    publishAcpConfigOptionOverrideToMetadata,
} from './acpConfigOptionOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('acpConfigOptionOverridePublish', () => {
    it('stores a config option override when updatedAt is newer', () => {
        const next = computeNextAcpConfigOptionOverrideMetadata({
            metadata: buildMetadata(),
            configId: 'telemetry',
            value: 'true',
            updatedAt: 11,
        });

        expect(next.acpConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 11,
            overrides: {
                telemetry: { updatedAt: 11, value: 'true' },
            },
        });
    });

    it('does not override an existing config option override when updatedAt is older', () => {
        const base = buildMetadata({
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 11,
                overrides: {
                    telemetry: { updatedAt: 11, value: 'true' },
                },
            },
        });

        const next = computeNextAcpConfigOptionOverrideMetadata({
            metadata: base,
            configId: 'telemetry',
            value: 'false',
            updatedAt: 10,
        });

        expect(next).toBe(base);
        expect(next.acpConfigOptionOverridesV1).toEqual(base.acpConfigOptionOverridesV1);
    });

    it('does not override existing value when updatedAt is equal', () => {
        const base = buildMetadata({
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 11,
                overrides: {
                    telemetry: { updatedAt: 11, value: 'true' },
                },
            },
        });

        const next = computeNextAcpConfigOptionOverrideMetadata({
            metadata: base,
            configId: 'telemetry',
            value: 'false',
            updatedAt: 11,
        });

        expect(next).toBe(base);
    });

    it('updates one override key without dropping sibling overrides', () => {
        const base = buildMetadata({
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 11,
                overrides: {
                    telemetry: { updatedAt: 11, value: 'true' },
                    notifications: { updatedAt: 9, value: 'false' },
                },
            },
        });

        const next = computeNextAcpConfigOptionOverrideMetadata({
            metadata: base,
            configId: 'notifications',
            value: 'true',
            updatedAt: 12,
        });

        expect(next.acpConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 12,
            overrides: {
                telemetry: { updatedAt: 11, value: 'true' },
                notifications: { updatedAt: 12, value: 'true' },
            },
        });
    });
});

describe('publishAcpConfigOptionOverrideToMetadata', () => {
    it('publishes overrides via updateSessionMetadataWithRetry updater', async () => {
        const updates: Metadata[] = [];
        const base = buildMetadata();

        await publishAcpConfigOptionOverrideToMetadata({
            sessionId: 's1',
            configId: 'telemetry',
            value: 'true',
            updatedAt: 22,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(base));
            },
        });

        expect(updates).toHaveLength(1);
        expect(updates[0].acpConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 22,
            overrides: {
                telemetry: { updatedAt: 22, value: 'true' },
            },
        });
    });
});
