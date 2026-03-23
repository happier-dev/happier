import { describe, expect, it } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildSessionListCacheEntryFromRenderable,
} from './warmCacheAdapters';

describe('warmCacheAdapters', () => {
    it('preserves previous session cache metadata and agent-state flags while a replacement renderable is still stale', () => {
        const previousEntry = {
            sessionId: 's1',
            metadataVersion: 1,
            agentStateVersion: 3,
            updatedAt: 10,
            createdAt: 5,
            active: true,
            activeAt: 10,
            archivedAt: null,
            pendingCount: 1,
            pendingVersion: 2,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        const nextRenderable = {
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 4,
            pendingVersion: 5,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        };

        const entry = (buildSessionListCacheEntryFromRenderable as any)(nextRenderable, previousEntry);

        expect(entry).toEqual(expect.objectContaining({
            sessionId: 's1',
            metadataVersion: 1,
            agentStateVersion: 3,
            updatedAt: 20,
            pendingCount: 4,
            pendingVersion: 5,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        }));
    });

    it('preserves previous machine display cache metadata while a replacement renderable is still stale', () => {
        const previousEntry = {
            machineId: 'm1',
            metadataVersion: 2,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            revokedAt: null,
            displayName: 'Cached machine',
            host: 'mbp',
            homeDir: '/home/u',
        };

        const nextRenderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: null,
        };

        const entry = (buildMachineDisplayCacheEntryFromRenderable as any)(nextRenderable, previousEntry);

        expect(entry).toEqual(expect.objectContaining({
            machineId: 'm1',
            metadataVersion: 2,
            updatedAt: 20,
            activeAt: 20,
            displayName: 'Cached machine',
            host: 'mbp',
            homeDir: '/home/u',
        }));
    });
});
