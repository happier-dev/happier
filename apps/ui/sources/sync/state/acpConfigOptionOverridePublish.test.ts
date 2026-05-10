import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishAcpConfigOptionOverrideToMetadata } from './acpConfigOptionOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('publishAcpConfigOptionOverrideToMetadata', () => {
    it('publishes ACP config option through the UI session-state engine', async () => {
        const updates: Metadata[] = [];

        await publishAcpConfigOptionOverrideToMetadata({
            sessionId: 's1',
            configId: 'telemetry',
            value: 'true',
            updatedAt: 22,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 22,
                    overrides: {
                        telemetry: { updatedAt: 22, value: 'true' },
                    },
                },
            }),
        ]);
    });

    it('keeps sibling ACP config overrides behind the shared session-state policy', async () => {
        const updates: Metadata[] = [];

        await publishAcpConfigOptionOverrideToMetadata({
            sessionId: 's1',
            configId: 'notifications',
            value: 'true',
            updatedAt: 12,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata({
                    acpConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 11,
                        overrides: {
                            telemetry: { updatedAt: 11, value: 'true' },
                            notifications: { updatedAt: 9, value: 'false' },
                        },
                    },
                })));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 12,
                    overrides: {
                        telemetry: { updatedAt: 11, value: 'true' },
                        notifications: { updatedAt: 12, value: 'true' },
                    },
                },
            }),
        ]);
    });
});
