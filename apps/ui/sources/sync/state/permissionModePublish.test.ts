import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishPermissionModeToMetadata } from './permissionModePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('publishPermissionModeToMetadata', () => {
    it('publishes permission mode through the UI session-state engine', async () => {
        const updates: Metadata[] = [];

        await publishPermissionModeToMetadata({
            sessionId: 's1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 11,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata({ permissionModeUpdatedAt: 10 })));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                permissionMode: 'safe-yolo',
                permissionModeUpdatedAt: 11,
            }),
        ]);
    });

    it('keeps stale permission candidates behind the shared session-state policy', async () => {
        const updates: Metadata[] = [];

        await publishPermissionModeToMetadata({
            sessionId: 's1',
            permissionMode: 'read-only',
            permissionModeUpdatedAt: 10,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                const base = buildMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 });
                updates.push(updater(base));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 10,
            }),
        ]);
    });

    it('maps UI metadata port failures to session-state publish errors', async () => {
        await expect(publishPermissionModeToMetadata({
            sessionId: 's1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 11,
            updateSessionMetadataWithRetry: async () => {
                throw Object.assign(new Error('conflict'), { code: 'conflict' });
            },
        })).rejects.toThrow('Session state metadata update failed: conflict');
    });
});
