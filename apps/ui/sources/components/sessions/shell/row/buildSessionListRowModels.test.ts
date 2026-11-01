import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import {
    buildCachedSessionListRowModel,
    createSessionListRowModelsCache,
    resolveSessionListRowModelAdjacency,
} from './buildSessionListRowModels';
import { sessionTagKey } from '../sessionTagUtils';
import type {
    SessionListRowPresentationSettings,
    SessionListRowStateSnapshot,
} from './sessionListRowModelTypes';

const NOW_MS = 1_000_000;
const EMPTY_ROW_STATE: SessionListRowStateSnapshot = {
    session: undefined,
    renderable: undefined,
    messages: undefined,
    pending: undefined,
};

describe('resolveSessionListRowModelAdjacency', () => {
    it('updates the appearance of one row and retains its model for equivalent colour snapshots', () => {
        const item = createSessionItem(createRenderable('coloured'));
        const cache = createSessionListRowModelsCache();
        const settings = createSettings();
        const adjacency = resolveSessionListRowModelAdjacency([item], 0);
        const first = buildCachedSessionListRowModel({ item, cache, settings, adjacency, snapshot: EMPTY_ROW_STATE });
        const snapshot = { ...EMPTY_ROW_STATE, appearanceColor: { kind: 'accent', key: 'blue' } as const };
        const coloured = buildCachedSessionListRowModel({ item, cache, settings, adjacency, snapshot });
        expect(coloured).toMatchObject({ appearanceColor: { kind: 'accent', key: 'blue' } });
        expect(coloured).not.toBe(first);
        expect(buildCachedSessionListRowModel({ item, cache, settings, adjacency, snapshot: { ...snapshot, appearanceColor: { ...snapshot.appearanceColor } } })).toBe(coloured);
    });
    it('reuses the canonical adjacency value when list identity changes without changing neighbors', () => {
        const session = createSessionItem(createRenderable('stable-adjacency'));
        const first = resolveSessionListRowModelAdjacency([session], 0);
        const second = resolveSessionListRowModelAdjacency([{ ...session }], 0);

        expect(second).toBe(first);
    });
});

function createRenderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 10,
        createdAt: NOW_MS - 300_000,
        updatedAt: NOW_MS - 60_000,
        meaningfulActivityAt: null,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name: `Session ${id}`,
            summaryText: null,
            path: `/repo/${id}`,
            homeDir: '/repo',
            host: 'workstation.local',
            machineId: 'machine-1',
            directSessionV1: null,
            readStateV1: null,
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: null,
        latestTurnStatusObservedAt: null,
        lastRuntimeIssue: null,
        ...overrides,
    };
}

function createSessionItem(
    session: SessionListRenderableSession,
    overrides: Partial<Extract<SessionListViewItem, { type: 'session' }>> = {},
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        session,
        section: 'active',
        groupKey: 'group-a',
        groupKind: 'project',
        serverId: 'server-a',
        serverName: 'Server A',
        ...overrides,
    };
}

function createSettings(
    overrides: Partial<SessionListRowPresentationSettings> = {},
): SessionListRowPresentationSettings {
    return {
        currentUserId: 'user-1',
        density: 'default',
        compact: false,
        compactMinimal: false,
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        workingIndicatorMode: 'spinner',
        workingTextMode: 'static',
        hideInactiveSessions: false,
        showServerBadge: false,
        showPinnedServerBadge: true,
        agentActivityCountEnabled: false,
        tagsEnabled: true,
        sessionTagsByKey: {},
        allKnownTags: [],
        pinnedSessionKeys: [],
        attentionStandingEnabled: false,
        attentionStandingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
        hasMultipleMachines: false,
        reachableSessionDisplayByKey: {},
        folderViewEnabled: true,
        relativeNowMs: NOW_MS,
        runtimeNowMs: NOW_MS,
        statusColors: {
            connected: 'connected-token',
            connecting: 'connecting-token',
            actionRequired: 'action-token',
            disconnected: 'disconnected-token',
            error: 'error-token',
            default: 'default-token',
        },
        ...overrides,
    };
}

describe('buildCachedSessionListRowModel', () => {
    it('reuses a fresh cached model on pure clock updates without rebuilding stable input signatures', () => {
        const cache = createSessionListRowModelsCache();
        const item = createSessionItem(createRenderable('s1'));
        const statusColors = {
            connected: 'connected-token',
            connecting: 'connecting-token',
            actionRequired: 'action-token',
            disconnected: 'disconnected-token',
            error: 'error-token',
            default: 'default-token',
        };
        const settings = createSettings({ statusColors });
        const adjacency = { isFirst: true, isLast: true, isSingle: true };
        const first = buildCachedSessionListRowModel({
            item,
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings,
            cache,
        });
        Object.defineProperty(statusColors, 'connected', {
            configurable: true,
            get: () => {
                throw new Error('stable row model cache hits must not rebuild the input signature');
            },
        });

        const second = buildCachedSessionListRowModel({
            item,
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings: createSettings({
                ...settings,
                relativeNowMs: NOW_MS + 1_000,
                runtimeNowMs: NOW_MS + 1_000,
                statusColors,
            }),
            cache,
        });

        expect(second).toBe(first);
    });

    // A placement reason changes without any other input changing: promotion
    // within a group keeps the row's group, session and snapshot exactly as they
    // were, so a signature that ignores the reason hands back the row the person
    // just changed.
    it('updates a cached background row when unread presentation preference changes', () => {
        const cache = createSessionListRowModelsCache();
        const item = createSessionItem(createRenderable('background-unread', {
            active: true, activeAt: NOW_MS, hasUnreadMessages: true, lastViewedSessionSeq: 1,
            runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: NOW_MS, runtimeActivityRevision: 1,
        }));
        const adjacency = { isFirst: true, isLast: true, isSingle: true };
        const input = { item, snapshot: EMPTY_ROW_STATE, adjacency, cache };
        const initial = buildCachedSessionListRowModel({ ...input, settings: createSettings({ backgroundWorkAttentionMode: 'keepWorking' }) });
        const changed = buildCachedSessionListRowModel({ ...input, settings: createSettings({ backgroundWorkAttentionMode: 'keepWorkingUnread' }) });
        expect(initial.attention.rowState).toBe('working');
        expect(changed.attention.rowState).toBe('unread');
        expect(changed.hasUnreadMessages).toBe(true);
    });

    it('rebuilds a row when its attention placement reason changes', () => {
        const cache = createSessionListRowModelsCache();
        const session = createRenderable('s1');
        const settings = createSettings();
        const adjacency = { isFirst: true, isLast: true, isSingle: true };

        const standing = buildCachedSessionListRowModel({
            item: createSessionItem(session, { attentionPromotionReason: 'standing' }),
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings,
            cache,
        });
        expect(standing.presentation.attentionIndicator).toBe('standing');

        const removed = buildCachedSessionListRowModel({
            item: createSessionItem(session),
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings,
            cache,
        });

        expect(removed.presentation.attentionIndicator).toBe('none');
    });

    // The action menu reads `isAttentionStanding`, which is resolved from the
    // SETTINGS policy rather than from the item — so a cache key that only
    // watches the item hands back the row the person just changed, and the menu
    // keeps offering "Keep in Needs attention" after they pressed it.
    it('rebuilds a row when the attention standing policy changes', () => {
        const cache = createSessionListRowModelsCache();
        const session = createRenderable('s1');
        const item = createSessionItem(session);
        const adjacency = { isFirst: true, isLast: true, isSingle: true };
        const rowKey = sessionTagKey(String(item.serverId), String(session.id));

        const before = buildCachedSessionListRowModel({
            item,
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings: createSettings({ attentionStandingEnabled: true }),
            cache,
        });
        expect(before.isAttentionStanding).toBe(false);

        const after = buildCachedSessionListRowModel({
            item,
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings: createSettings({
                attentionStandingEnabled: true,
                attentionStandingPolicy: {
                    defaultStanding: false,
                    overridesBySessionKey: { [rowKey]: true },
                },
            }),
            cache,
        });

        expect(after.isAttentionStanding).toBe(true);
    });

    it('rebuilds only the row whose reminder changed', () => {
        const cache = createSessionListRowModelsCache();
        const firstItem = createSessionItem(createRenderable('s1'));
        const secondItem = createSessionItem(createRenderable('s2'));
        const adjacency = { isFirst: true, isLast: true, isSingle: true };
        const initialSettings = createSettings();
        const firstBefore = buildCachedSessionListRowModel({ item: firstItem, snapshot: EMPTY_ROW_STATE, adjacency, settings: initialSettings, cache });
        const secondBefore = buildCachedSessionListRowModel({ item: secondItem, snapshot: EMPTY_ROW_STATE, adjacency, settings: initialSettings, cache });
        const firstKey = sessionTagKey(String(firstItem.serverId), 's1');
        const remindAt = Date.now() + 60_000;
        const reminderSettings = createSettings({
            attentionStandingPolicy: {
                defaultStanding: false,
                overridesBySessionKey: {
                    [firstKey]: { standing: false, remindAt, updatedAt: 1 },
                },
            },
        });

        const firstAfter = buildCachedSessionListRowModel({ item: firstItem, snapshot: EMPTY_ROW_STATE, adjacency, settings: reminderSettings, cache });
        const secondAfter = buildCachedSessionListRowModel({ item: secondItem, snapshot: EMPTY_ROW_STATE, adjacency, settings: reminderSettings, cache });

        expect(firstAfter).not.toBe(firstBefore);
        expect(firstAfter.reminder).toEqual({ state: 'scheduled', remindAt });
        expect(secondAfter).toBe(secondBefore);
    });

    it('rebuilds a row when its working placement reason changes', () => {
        const cache = createSessionListRowModelsCache();
        const session = createRenderable('s1', {
            active: true,
            activeAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });
        const settings = createSettings();
        const adjacency = { isFirst: true, isLast: true, isSingle: true };

        const retained = buildCachedSessionListRowModel({
            item: createSessionItem(session, { groupKind: 'working', workingPlacementReason: 'working-retained' }),
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings,
            cache,
        });
        expect(retained.workingIndicatorPaused).toBe(true);

        const live = buildCachedSessionListRowModel({
            item: createSessionItem(session, { groupKind: 'working', workingPlacementReason: 'working' }),
            snapshot: EMPTY_ROW_STATE,
            adjacency,
            settings,
            cache,
        });

        expect(live.workingIndicatorPaused).toBe(false);
    });
});
