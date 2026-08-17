import { describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildMachineDisplayCacheEntriesFromRenderables,
    buildPersistedSessionListCacheEntriesFromRenderables,
    buildSessionListRenderableFromCacheEntry,
    buildSessionListCacheEntryFromRenderable,
    buildSessionListCacheEntriesFromRenderables,
    SESSION_LIST_WARM_CACHE_MAX_ENTRIES,
} from './warmCacheAdapters';
import type { SessionListCacheEntryV1 } from './warmCachePersistence';

function makeWindowRenderable(id: string, meaningfulActivityAt: number): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 5,
        updatedAt: meaningfulActivityAt,
        meaningfulActivityAt,
        active: true,
        activeAt: meaningfulActivityAt,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    } as unknown as SessionListRenderableSession;
}

describe('warmCacheAdapters', () => {
    it('does not preserve or resurrect legacy private cache fields after the privacy layout contracts', () => {
        const previousEntry: SessionListCacheEntryV1 = {
            sessionId: 'privacy-contraction',
            seq: 7,
            metadataVersion: 9,
            agentStateVersion: 8,
            updatedAt: 10,
            createdAt: 1,
            active: true,
            activeAt: 10,
            archivedAt: null,
            name: 'Legacy title',
            path: '/private/worktree',
            homeDir: '/private',
            host: 'private-host',
            machineId: 'private-machine',
            flavor: 'codex',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'private-machine',
                remoteSessionId: 'private-native-id',
                source: { kind: 'codexHome', home: 'local' },
            },
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: true,
        };
        const contractedRecipientRenderable = {
            id: 'privacy-contraction',
            seq: 8,
            createdAt: 1,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            archivedAt: null,
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };

        const contractedEntry = buildSessionListCacheEntryFromRenderable(
            contractedRecipientRenderable as SessionListRenderableSession,
            previousEntry,
        );
        const reloaded = buildSessionListRenderableFromCacheEntry(contractedEntry);

        expect(contractedEntry).toMatchObject({
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            name: undefined,
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            externalSessionV1: null,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
        expect(reloaded.metadata).toBeNull();
        expect(JSON.stringify(reloaded)).not.toContain('private-native-id');
        expect(JSON.stringify(reloaded)).not.toContain('/private/worktree');
    });

    it('invalidates and roundtrips the canonical external-session agent identity', () => {
        const createRenderable = (agentId: string): SessionListRenderableSession => ({
            id: 'external-agent-change',
            seq: 1,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            metadataVersion: 2,
            agentStateVersion: 4,
            lastViewedSessionSeq: 0,
            metadata: {
                path: '/home/u/repo',
                externalSessionV1: {
                    v: 1,
                    agentId,
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            hasUnreadMessages: false,
        });
        const previousEntry = buildSessionListCacheEntryFromRenderable(createRenderable('codex'));
        const nextEntry = buildSessionListCacheEntryFromRenderable(
            createRenderable('claude'),
            previousEntry,
        );

        expect(nextEntry).not.toBe(previousEntry);
        expect(nextEntry.externalSessionV1).toMatchObject({ v: 1, agentId: 'claude' });
        expect(buildSessionListRenderableFromCacheEntry(nextEntry).metadata?.externalSessionV1).toEqual({
            v: 1,
            agentId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        });
    });

    it('preserves previous session cache metadata and agent-state projection while a replacement renderable is still stale', () => {
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
            pendingRequestObservedAt: 30,
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
            pendingRequestObservedAt: 30,
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
                externalSessionV1: null,
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

    it('evicts a stale entry when a same-size renderable set swapped one member', () => {
        const previousEntries = buildSessionListCacheEntriesFromRenderables({
            a: makeWindowRenderable('a', 20),
            b: makeWindowRenderable('b', 20),
        });
        const nextEntries = buildSessionListCacheEntriesFromRenderables(
            { b: makeWindowRenderable('b', 20), c: makeWindowRenderable('c', 20) },
            previousEntries,
        );

        expect(Object.keys(nextEntries).sort()).toEqual(['b', 'c']);
    });

    it('persists only the most recent window of sessions, ordered by the server list key', () => {
        const renderables: Record<string, SessionListRenderableSession> = {};
        const total = SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 25;
        for (let index = 0; index < total; index += 1) {
            const id = `s${String(index).padStart(4, '0')}`;
            renderables[id] = makeWindowRenderable(id, 1_000 + index);
        }

        const persisted = buildPersistedSessionListCacheEntriesFromRenderables(renderables);

        expect(Object.keys(persisted)).toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
        expect(persisted['s0000']).toBeUndefined();
        expect(persisted[`s${String(total - 1).padStart(4, '0')}`]).toBeDefined();

        // Capping must not cost referential stability, or every fetch would rewrite the blob.
        expect(buildPersistedSessionListCacheEntriesFromRenderables(renderables, persisted)).toBe(persisted);
    });

    it('leaves the in-memory metadata fallback uncapped', () => {
        const renderables: Record<string, SessionListRenderableSession> = {};
        const total = SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 25;
        for (let index = 0; index < total; index += 1) {
            const id = `s${String(index).padStart(4, '0')}`;
            renderables[id] = makeWindowRenderable(id, 1_000 + index);
        }

        expect(Object.keys(buildSessionListCacheEntriesFromRenderables(renderables))).toHaveLength(total);
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
                externalSessionV1: null,
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
                externalSessionV1: null,
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

    it('roundtrips session unread state through cache entries', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 7,
            createdAt: 5,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            lastViewedSessionSeq: 4,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasUnreadMessages: true,
        } as any);

        expect(entry.seq).toBe(7);
        expect(entry.lastViewedSessionSeq).toBe(4);
        expect(entry.hasUnreadMessages).toBe(true);
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            seq: 7,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
        }));
    });

    it('roundtrips durable session status and attention projection through cache entries', () => {
        const renderable = {
            id: 's_attention',
            seq: 12,
            createdAt: 5,
            updatedAt: 20,
            meaningfulActivityAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 1,
            pendingVersion: 4,
            lastViewedSessionSeq: 10,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Needs review',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'codex',
                externalSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 500,
            presence: 'online',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 1_200,
            },
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 10_000,
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 1_000,
            rollbackEligibleTurnStarts: [3, 9],
            hasUnreadMessages: true,
        } satisfies SessionListRenderableSession & { rollbackEligibleTurnStarts: readonly number[] };

        const entry = buildSessionListCacheEntryFromRenderable(renderable);

        expect(entry).toEqual(expect.objectContaining({
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 10_000,
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            rollbackEligibleTurnStarts: [3, 9],
        }));
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 10_000,
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            rollbackEligibleTurnStarts: [3, 9],
        }));
    });

    it('does not hydrate placeholder session metadata from an empty warm-cache identity', () => {
        const renderable = buildSessionListRenderableFromCacheEntry({
            sessionId: 's-placeholder',
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 20,
            createdAt: 10,
            active: true,
            activeAt: 20,
            archivedAt: null,
            path: '',
        });

        expect(renderable.metadata).toBeNull();
        expect(renderable.metadataUnavailable).toBe(true);
    });

    it('does not preserve placeholder session metadata from a previous empty warm-cache identity', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's-placeholder',
            seq: 1,
            createdAt: 10,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: null,
            metadataUnavailable: true,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, {
            sessionId: 's-placeholder',
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 10,
            createdAt: 10,
            active: true,
            activeAt: 10,
            archivedAt: null,
            path: '',
        });

        expect(entry.path).toBe('');
        expect(entry.name).toBeUndefined();
        expect(entry.host).toBeNull();
        expect(entry.machineId).toBeNull();
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
