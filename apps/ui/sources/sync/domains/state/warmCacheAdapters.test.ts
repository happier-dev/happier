import { describe, expect, it } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildSessionListRenderableFromCacheEntry,
    buildPersistedSessionListCacheEntriesFromRenderables,
    buildSessionListCacheEntryFromRenderable,
    SESSION_LIST_WARM_CACHE_MAX_ENTRIES,
} from './warmCacheAdapters';
import { SessionListCacheEntryV1Schema } from './warmCachePersistence';
import { buildSessionListRenderableFromSession, resolveSessionListRenderableAttentionPromotionPlacement } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionFixture } from '@/dev/testkit';

describe('warmCacheAdapters', () => {
    it('persists resolved runtime identity through compact projection and JSON cache hydration', () => {
        const renderable = buildSessionListRenderableFromSession(createSessionFixture({
            metadata: {
                path: '/repo',
                host: 'host',
                flavor: 'claude',
                agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } },
            },
        }));
        const entry = buildSessionListCacheEntryFromRenderable(renderable);
        const persisted = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));

        expect(buildSessionListRenderableFromCacheEntry(persisted).metadata?.flavor).toBe('codex');
        expect(buildSessionListCacheEntryFromRenderable(buildSessionListRenderableFromCacheEntry(persisted), persisted)).toBe(persisted);
    });

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

    it('does not persist keepVisibleWhenInactive, which every commit re-derives from the previous renderable', () => {
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

        expect(entry).not.toHaveProperty('keepVisibleWhenInactive');
        expect(buildSessionListRenderableFromCacheEntry(entry).keepVisibleWhenInactive).toBeUndefined();
    });

    it('round-trips a persisted entry back to an identical entry so hydration never rewrites the cache', () => {
        const persistedEntry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 7,
            createdAt: 5,
            updatedAt: 20,
            meaningfulActivityAt: 18,
            active: false,
            activeAt: 20,
            archivedAt: null,
            pendingCount: 2,
            pendingVersion: 3,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Cached title',
                summaryText: null,
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
            presence: 20,
            // Not hydrated yet: the agent-state flags are absent rather than false.
            keepVisibleWhenInactive: true,
        });

        // Storage is JSON, so absent optional fields must survive the trip as absent.
        const reloadedEntry = JSON.parse(JSON.stringify(persistedEntry)) as typeof persistedEntry;
        const hydratedRenderable = buildSessionListRenderableFromCacheEntry(reloadedEntry);
        const rewrittenEntry = buildSessionListCacheEntryFromRenderable(hydratedRenderable, reloadedEntry);

        expect(rewrittenEntry).toBe(reloadedEntry);
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
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasUnreadMessages: true,
        });

        expect(entry).toEqual(expect.objectContaining({
            seq: 7,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
        }));
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            seq: 7,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
        }));
    });

    it('persists the unread entry fact so a cold boot restores the same attention ordering key', () => {
        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's_unread',
            seq: 12,
            createdAt: 1_000,
            updatedAt: 9_000,
            meaningfulActivityAt: 9_000,
            active: false,
            activeAt: 9_000,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            lastViewedSessionSeq: 4,
            metadataVersion: 2,
            agentStateVersion: 4,
            metadata: {
                name: 'Unread session',
                summaryText: null,
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
            presence: 9_000,
            hasUnreadMessages: true,
            unreadSince: 2_000,
        });

        expect(entry.unreadSince).toBe(2_000);

        // Storage is JSON validated by the persisted schema on load, so a field the
        // schema does not declare is silently stripped: the round trip has to go
        // through the schema to prove the entry fact actually survives a cold boot.
        const reloadedEntry = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));
        const hydrated = buildSessionListRenderableFromCacheEntry(reloadedEntry);

        expect(hydrated.unreadSince).toBe(2_000);
        expect(resolveSessionListRenderableAttentionPromotionPlacement(hydrated, 10_000)).toEqual({
            kind: 'unread',
            timestamp: 2_000,
        });
        // Hydration must not look like new information, or boot rewrites the cache.
        expect(buildSessionListCacheEntryFromRenderable(hydrated, reloadedEntry)).toBe(reloadedEntry);
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
                directSessionV1: null,
                hiddenSystemSession: false,
            },
            thinking: false,
            thinkingAt: 500,
            presence: 'online',
            latestTurnId: 'turn-failed',
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
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 1_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityState: 'active',
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 17,
            rollbackEligibleTurnStarts: [2, 4],
            hasUnreadMessages: true,
        } satisfies SessionListRenderableSession;

        const entry = buildSessionListCacheEntryFromRenderable(renderable);

        expect(entry).toEqual(expect.objectContaining({
            latestTurnId: 'turn-failed',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityState: 'active',
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 17,
            rollbackEligibleTurnStarts: [2, 4],
        }));
        expect(buildSessionListRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            latestTurnId: 'turn-failed',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_200,
            lastRuntimeIssue: expect.objectContaining({ code: 'auth_error' }),
            latestReadyEventSeq: 11,
            latestReadyEventAt: 1_100,
            pendingRequestObservedAt: 1_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityState: 'active',
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 17,
            rollbackEligibleTurnStarts: [2, 4],
        }));
    });

    it('does not hydrate placeholder session metadata from an empty warm-cache identity', () => {
        const renderable = buildSessionListRenderableFromCacheEntry({
            sessionId: 's1',
            seq: 7,
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 20,
            createdAt: 5,
            active: false,
            activeAt: 5,
            archivedAt: null,
            lastViewedSessionSeq: null,
            pendingCount: 0,
            pendingVersion: 0,
            summaryText: null,
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            directSessionV1: null,
            hiddenSystemSession: false,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            hasUnreadMessages: true,
        });

        expect(renderable.metadata).toBeNull();
        expect(renderable.metadataUnavailable).toBe(true);
    });

    it('does not preserve placeholder session metadata from a previous empty warm-cache identity', () => {
        const previousEntry = {
            sessionId: 's1',
            seq: 7,
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 20,
            createdAt: 5,
            active: false,
            activeAt: 5,
            archivedAt: null,
            lastViewedSessionSeq: null,
            pendingCount: 0,
            pendingVersion: 0,
            summaryText: null,
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            directSessionV1: null,
            hiddenSystemSession: false,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
            hasUnreadMessages: true,
        };

        const entry = buildSessionListCacheEntryFromRenderable({
            id: 's1',
            seq: 8,
            createdAt: 5,
            updatedAt: 30,
            active: false,
            activeAt: 5,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 0,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 5,
            metadataUnavailable: true,
        } as any, previousEntry);

        expect(entry.metadataVersion).toBe(1);
        expect(entry.path).toBe('');
        expect(entry.name).toBeUndefined();
    });

    describe('buildPersistedSessionListCacheEntriesFromRenderables', () => {
        function makeRenderable(id: string, meaningfulActivityAt: number): SessionListRenderableSession {
            return {
                id,
                seq: 1,
                createdAt: meaningfulActivityAt,
                updatedAt: meaningfulActivityAt,
                meaningfulActivityAt,
                active: false,
                activeAt: meaningfulActivityAt,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata: null,
                metadataUnavailable: true,
                thinking: false,
                thinkingAt: 0,
                presence: meaningfulActivityAt,
            };
        }

        function makeRenderables(count: number): Record<string, SessionListRenderableSession> {
            const renderables: Record<string, SessionListRenderableSession> = {};
            for (let index = 0; index < count; index += 1) {
                const id = `s${String(index).padStart(4, '0')}`;
                renderables[id] = makeRenderable(id, index);
            }
            return renderables;
        }

        it('keeps only the most recent rows by the list ordering key', () => {
            const renderables = makeRenderables(SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 25);
            const entries = buildPersistedSessionListCacheEntriesFromRenderables(renderables);
            const cachedIds = Object.keys(entries);

            expect(cachedIds).toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
            expect(Math.min(...cachedIds.map((id) => entries[id].meaningfulActivityAt ?? 0))).toBe(25);
            expect(entries.s0000).toBeUndefined();
        });

        it('returns the previous record unchanged when the retained rows did not change', () => {
            const renderables = makeRenderables(SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 25);
            const previousEntries = buildPersistedSessionListCacheEntriesFromRenderables(renderables);

            expect(buildPersistedSessionListCacheEntriesFromRenderables(renderables, previousEntries)).toBe(previousEntries);
        });

        it('evicts a row that leaves the retained window even when the entry count is unchanged', () => {
            const renderables = makeRenderables(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
            const previousEntries = buildPersistedSessionListCacheEntriesFromRenderables(renderables);
            const withNewerRow = { ...renderables, s_newest: makeRenderable('s_newest', 10_000) };

            const nextEntries = buildPersistedSessionListCacheEntriesFromRenderables(withNewerRow, previousEntries);

            expect(Object.keys(nextEntries)).toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
            expect(nextEntries.s_newest).toBeDefined();
            expect(nextEntries.s0000).toBeUndefined();
        });

        it('evicts a removed row when another row arrives in the same commit', () => {
            const previousEntries = buildPersistedSessionListCacheEntriesFromRenderables({
                kept: makeRenderable('kept', 3),
                gone: makeRenderable('gone', 2),
            });

            const nextEntries = buildPersistedSessionListCacheEntriesFromRenderables({
                kept: makeRenderable('kept', 3),
                added: makeRenderable('added', 1),
            }, previousEntries);

            expect(Object.keys(nextEntries).sort()).toEqual(['added', 'kept']);
        });
    });
});
