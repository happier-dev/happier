import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from './sessionListViewData';
import { filterSessionListViewDataByStorageKind } from './filterSessionListViewDataByStorageKind';
import { buildSessionListRenderableMetadata } from './sessionListRenderable';
import { buildSessionListCacheEntryFromRenderable, buildSessionListRenderableFromCacheEntry } from '@/sync/domains/state/warmCacheAdapters';
import { SessionListCacheEntryV1Schema } from '@/sync/domains/state/warmCachePersistence';
import { readDirectSessionLink } from '../directSessions/readDirectSessionLink';

function makeSession(id: string, direct: boolean): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        serverId: 'server-a',
        session: {
            id,
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: direct ? { path: '', host: '', directSessionV1: { v: 1, providerId: 'codex' } } : { path: '', host: '' },
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        },
    };
}

describe('filterSessionListViewDataByStorageKind', () => {
    it('shows a fresh Direct session in the Direct tab before a native transcript can be linked, including on warm start', () => {
        const fresh = makeSession('starting-direct', false);
        const metadata = { path: '/workspace', host: 'machine', flavor: 'claude', directTranscriptPendingV1: true as const };
        expect(readDirectSessionLink(metadata)).toBeNull();
        fresh.session.metadata = buildSessionListRenderableMetadata(metadata);
        const cached = SessionListCacheEntryV1Schema.parse(buildSessionListCacheEntryFromRenderable(fresh.session));
        const warm = { ...fresh, session: buildSessionListRenderableFromCacheEntry(cached) };
        for (const row of [fresh, warm]) {
            expect(filterSessionListViewDataByStorageKind([row], 'direct')).toContainEqual(row);
            expect(filterSessionListViewDataByStorageKind([row], 'persisted')).toEqual([]);
        }
    });

    it('keeps only direct sessions and the headers that still own visible rows', () => {
        const groupKey = 'server:server-a:day:2026-03-05';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey, serverId: 'server-a' },
            makeSession('persisted-1', false),
            makeSession('direct-1', true),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'direct');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Today',
            's:direct-1',
        ]);
    });

    it('keeps only persisted sessions and removes orphaned headers', () => {
        const directGroupKey = 'server:server-a:day:2026-03-05';
        const persistedGroupKey = 'server:server-a:day:2026-03-04';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: directGroupKey, serverId: 'server-a' },
            makeSession('direct-1', true),
            { type: 'header', title: 'Yesterday', headerKind: 'date', groupKey: persistedGroupKey, serverId: 'server-a' },
            makeSession('persisted-1', false),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'persisted');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Yesterday',
            's:persisted-1',
        ]);
    });
});
