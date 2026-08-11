import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import {
    buildCachedSessionListRowModel,
    createSessionListRowModelsCache,
} from './buildSessionListRowModels';
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
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        session,
        section: 'active',
        groupKey: 'group-a',
        groupKind: 'project',
        serverId: 'server-a',
        serverName: 'Server A',
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
            dataIndex: 0,
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
            dataIndex: 0,
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
});
