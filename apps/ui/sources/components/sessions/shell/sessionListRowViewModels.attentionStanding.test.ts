import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

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

function buildRow(item: SessionIndexItem, attentionStandingPolicy?: Parameters<typeof buildSessionListRowViewModels>[0]['attentionStandingPolicy']) {
    const key = buildSessionListServerScopedRowKey(item.serverId, item.sessionId);
    if (!key) throw new Error('expected a row key');
    return buildSessionListRowViewModels({
        listItems: [item],
        reachableSessionDisplayById: new Map(),
        rowRenderableByKey: new Map([[key, createRenderableSession(item.sessionId)]]),
        relativeNowMs: 1_000,
        runtimeNowMs: 1_000,
        pinnedSessionKeys: new Set(),
        sessionTags: {},
        selectedSessionId: null,
        showServerBadge: false,
        showPinnedServerBadge: false,
        attentionStandingPolicy,
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

    it('preserves session context while projecting scheduled and due reminder state', () => {
        const sessionKey = buildSessionOrganizationSessionKey(BASE_ITEM.serverId, BASE_ITEM.sessionId);
        const withoutReminder = buildRow(BASE_ITEM);
        const scheduled = buildRow(BASE_ITEM, {
            defaultStanding: false,
            overridesBySessionKey: {
                [sessionKey]: { standing: false, remindAt: 2_000, updatedAt: 1 },
            },
        });
        const due = buildRow(BASE_ITEM, {
            defaultStanding: false,
            overridesBySessionKey: {
                [sessionKey]: { standing: false, remindAt: 900, updatedAt: 1 },
            },
        });

        expect(scheduled?.subtitleOverride).toBe(withoutReminder?.subtitleOverride);
        expect(scheduled).not.toBe(withoutReminder);
        expect(scheduled?.reminder).toEqual({ state: 'scheduled', remindAt: 2_000 });
        expect(due?.reminder).toEqual({ state: 'due', remindAt: 900 });
    });

    it('retains an unrelated row reference when another session reminder changes', () => {
        const unrelatedItem = { ...BASE_ITEM, sessionId: 'sess_unrelated' };
        const before = buildRow(unrelatedItem);
        const after = buildRow(unrelatedItem, {
            defaultStanding: false,
            overridesBySessionKey: {
                [buildSessionOrganizationSessionKey(BASE_ITEM.serverId, BASE_ITEM.sessionId)]: {
                    standing: false,
                    remindAt: 2_000,
                    updatedAt: 1,
                },
            },
        });

        expect(after).toBe(before);
    });
});
