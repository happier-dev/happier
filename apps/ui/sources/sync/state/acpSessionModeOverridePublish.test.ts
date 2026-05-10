import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishAcpSessionModeOverrideToMetadata } from './acpSessionModeOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('publishAcpSessionModeOverrideToMetadata', () => {
    it('publishes ACP session mode through the UI session-state engine', async () => {
        const updates: Metadata[] = [];

        await publishAcpSessionModeOverrideToMetadata({
            sessionId: 's1',
            modeId: 'plan',
            updatedAt: 11,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' },
            }),
        ]);
    });

    it('keeps ACP legacy alias writes behind the shared session-state policy', async () => {
        const updates: Metadata[] = [];

        await publishAcpSessionModeOverrideToMetadata({
            sessionId: 's1',
            modeId: 'build',
            updatedAt: 5,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata({
                    sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
                    acpSessionModeOverrideV1: { v: 1, updatedAt: 3, modeId: 'plan' },
                })));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'build' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'build' },
            }),
        ]);
    });
});
