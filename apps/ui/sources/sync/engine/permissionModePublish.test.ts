import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/storageTypes';
import { computeNextPermissionModeMetadata, publishPermissionModeToMetadata } from './permissionModePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('computeNextPermissionModeMetadata', () => {
    it('updates metadata when permissionModeUpdatedAt is newer', () => {
        const base = buildMetadata({ permissionModeUpdatedAt: 10 });
        const next = computeNextPermissionModeMetadata({
            metadata: base,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 11,
        });

        expect(next).toEqual({
            ...base,
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 11,
        });
    });

    it('does not override metadata when permissionModeUpdatedAt is not newer', () => {
        const base = buildMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 });
        const next = computeNextPermissionModeMetadata({
            metadata: base,
            permissionMode: 'read-only',
            permissionModeUpdatedAt: 10,
        });

        expect(next).toBe(base);
    });

    it('stores canonical intent values when given legacy provider tokens', () => {
        const base = buildMetadata({ permissionModeUpdatedAt: 10 });
        const next = computeNextPermissionModeMetadata({
            metadata: base,
            permissionMode: 'acceptEdits' as any,
            permissionModeUpdatedAt: 11,
        });

        expect(next.permissionMode).toBe('safe-yolo');
        expect(next.permissionModeUpdatedAt).toBe(11);
    });

    it('canonicalizes bypassPermissions legacy token to yolo', () => {
        const base = buildMetadata({ permissionModeUpdatedAt: 10 });
        const next = computeNextPermissionModeMetadata({
            metadata: base,
            permissionMode: 'bypassPermissions' as any,
            permissionModeUpdatedAt: 11,
        });

        expect(next.permissionMode).toBe('yolo');
        expect(next.permissionModeUpdatedAt).toBe(11);
    });

    it('does not persist invalid permission tokens', () => {
        const base = buildMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 10 });
        const next = computeNextPermissionModeMetadata({
            metadata: base,
            permissionMode: 'definitely-invalid-token' as any,
            permissionModeUpdatedAt: 99,
        });

        expect(next).toBe(base);
    });

    it('applies a deterministic sequence across multiple updates', () => {
        const base = buildMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 10 });
        const first = computeNextPermissionModeMetadata({
            metadata: base,
            permissionMode: 'acceptEdits' as any,
            permissionModeUpdatedAt: 11,
        });
        const second = computeNextPermissionModeMetadata({
            metadata: first,
            permissionMode: 'read-only',
            permissionModeUpdatedAt: 10,
        });
        const third = computeNextPermissionModeMetadata({
            metadata: second,
            permissionMode: 'read-only',
            permissionModeUpdatedAt: 12,
        });

        expect(first.permissionMode).toBe('safe-yolo');
        expect(first.permissionModeUpdatedAt).toBe(11);
        expect(second).toBe(first);
        expect(third.permissionMode).toBe('read-only');
        expect(third.permissionModeUpdatedAt).toBe(12);
    });
});

describe('publishPermissionModeToMetadata', () => {
    it('uses updateSessionMetadataWithRetry with a monotonic updater', async () => {
        const updates: Metadata[] = [];
        const base = buildMetadata({ permissionModeUpdatedAt: 10 });

        await publishPermissionModeToMetadata({
            sessionId: 's1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 11,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(base));
            },
        });

        expect(updates).toHaveLength(1);
        expect(updates[0]?.permissionMode).toBe('safe-yolo');
        expect(updates[0]?.permissionModeUpdatedAt).toBe(11);
    });
});
