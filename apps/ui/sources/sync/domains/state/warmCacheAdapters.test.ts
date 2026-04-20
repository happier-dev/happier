import { describe, expect, it, vi } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildMachineDisplayCacheEntriesFromRenderables,
    buildSessionListRenderableFromCacheEntry,
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

        const originalKeys = Object.keys;
        const keysSpy = vi.spyOn(Object, 'keys');
        const previousEntries = {
            s1: buildSessionListCacheEntryFromRenderable(renderable as any),
        };
        keysSpy.mockImplementation((value) => {
            if (value === previousEntries) {
                throw new Error('previous session entries should not be enumerated');
            }
            return originalKeys(value as never);
        });

        const nextEntries = buildSessionListCacheEntriesFromRenderables(
            { s1: renderable as any },
            previousEntries,
        );

        expect(nextEntries).toBe(previousEntries);
        keysSpy.mockRestore();
    });

    it('reuses shared empty maps when renderables are empty', () => {
        const firstSessionEntries = buildSessionListCacheEntriesFromRenderables({});
        const secondSessionEntries = buildSessionListCacheEntriesFromRenderables({});
        const firstMachineEntries = buildMachineDisplayCacheEntriesFromRenderables({});
        const secondMachineEntries = buildMachineDisplayCacheEntriesFromRenderables({});

        expect(firstSessionEntries).toBe(secondSessionEntries);
        expect(firstSessionEntries).toEqual({});
        expect(firstMachineEntries).toBe(secondMachineEntries);
        expect(firstSessionEntries).toBe(firstMachineEntries);
        expect(firstMachineEntries).toEqual({});
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

    it('roundtrips keepVisibleWhenInactive through cache entries', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: false,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
            keepVisibleWhenInactive: true,
        } as any);

        expect(entry.keepVisibleWhenInactive).toBe(true);
        expect(buildSessionListRenderableFromCacheEntry(entry).keepVisibleWhenInactive).toBe(true);
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

        const originalKeys = Object.keys;
        const keysSpy = vi.spyOn(Object, 'keys');
        const previousEntries = {
            m1: buildMachineDisplayCacheEntryFromRenderable(renderable as any),
        };
        keysSpy.mockImplementation((value) => {
            if (value === previousEntries) {
                throw new Error('previous machine entries should not be enumerated');
            }
            return originalKeys(value as never);
        });

        const nextEntries = buildMachineDisplayCacheEntriesFromRenderables(
            { m1: renderable as any },
            previousEntries,
        );

        expect(nextEntries).toBe(previousEntries);
        keysSpy.mockRestore();
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
