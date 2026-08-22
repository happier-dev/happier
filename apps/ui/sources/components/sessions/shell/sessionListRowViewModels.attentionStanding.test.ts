import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';

import { buildSessionListRowViewModels } from './sessionListRowViewModels';

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function createRenderableSession(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 100,
        updatedAt: 200,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name: 'Kept session',
            path: '/repo/kept',
            homeDir: '/repo',
            host: 'test.local',
            machineId: 'machine-a',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildRow(item: SessionIndexItem) {
    const key = buildSessionListServerScopedRowKey(item.serverId, item.sessionId);
    if (!key) throw new Error('expected a row key');
    return buildSessionListRowViewModels({
        listItems: [item],
        reachableSessionDisplayById: new Map(),
        rowRenderableByKey: new Map([[key, createRenderableSession(item.sessionId)]]),
        relativeNowMs: 1_000,
        runtimeNowMs: 1_000,
        hasMultipleMachines: false,
        pinnedSessionKeys: new Set(),
        sessionTags: {},
        selectedSessionId: null,
        showServerBadge: false,
        showPinnedServerBadge: false,
    })[0];
}

const BASE_ITEM = {
    type: 'session',
    sessionId: 'sess_kept',
    serverId: 'server_a',
    storageKind: 'persisted',
    groupKey: 'attention-promotion-v1',
    groupKind: 'attention',
} satisfies SessionIndexItem;

describe('session list row view model attention standing', () => {
    it('carries the standing placement reason onto the row', () => {
        expect(buildRow({ ...BASE_ITEM, attentionPlacementReason: 'standing' })?.attentionStanding).toBe(true);
        expect(buildRow({ ...BASE_ITEM, attentionPlacementReason: 'unread' })?.attentionStanding).toBe(false);
    });

    it('rebuilds the cached row when only the standing reason changed', () => {
        const kept = buildRow({ ...BASE_ITEM, attentionPlacementReason: 'standing' });
        const removed = buildRow({ ...BASE_ITEM, attentionPlacementReason: undefined, groupKind: 'attention' });

        expect(kept?.attentionStanding).toBe(true);
        expect(removed?.attentionStanding).toBe(false);
        expect(removed).not.toBe(kept);
    });
});
