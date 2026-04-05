import { describe, expect, it } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildMachineDisplayCacheEntriesFromRenderables,
    buildSessionListCacheEntryFromRenderable,
    buildSessionListCacheEntriesFromRenderables,
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

    it('reuses the previous session cache map when renderables are semantically identical', () => {
        const renderable = {
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
            metadata: {
                name: 'Cached title',
                summaryText: null,
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'host-a',
                machineId: 'm1',
                flavor: null,
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            accessLevel: null,
            canApprovePermissions: false,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        const previousEntries = {
            s1: buildSessionListCacheEntryFromRenderable(renderable as any),
        };

        const nextEntries = buildSessionListCacheEntriesFromRenderables(
            { s1: renderable as any },
            previousEntries,
        );

        expect(nextEntries).toBe(previousEntries);
    });

    it('reuses the previous session cache entry when renderable data is semantically identical', () => {
        const renderable = {
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
            metadata: {
                name: 'Cached title',
                summaryText: null,
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'host-a',
                machineId: 'm1',
                flavor: null,
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            accessLevel: null,
            canApprovePermissions: false,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        const previousEntry = buildSessionListCacheEntryFromRenderable(renderable as any);
        const nextEntry = buildSessionListCacheEntryFromRenderable(renderable as any, previousEntry);

        expect(nextEntry).toBe(previousEntry);
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

    it('reuses the previous machine display cache map when renderables are semantically identical', () => {
        const renderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: {
                displayName: 'Cached machine',
                host: 'mbp',
                homeDir: '/home/u',
            },
        };

        const previousEntries = {
            m1: buildMachineDisplayCacheEntryFromRenderable(renderable as any),
        };

        const nextEntries = buildMachineDisplayCacheEntriesFromRenderables(
            { m1: renderable as any },
            previousEntries,
        );

        expect(nextEntries).toBe(previousEntries);
    });

    it('reuses the previous machine display cache entry when renderable data is semantically identical', () => {
        const renderable = {
            id: 'm1',
            updatedAt: 20,
            active: true,
            activeAt: 20,
            revokedAt: null,
            metadataVersion: 3,
            metadata: {
                displayName: 'Cached machine',
                host: 'mbp',
                homeDir: '/home/u',
            },
        };

        const previousEntry = buildMachineDisplayCacheEntryFromRenderable(renderable as any);
        const nextEntry = buildMachineDisplayCacheEntryFromRenderable(renderable as any, previousEntry);

        expect(nextEntry).toBe(previousEntry);
    });
});
