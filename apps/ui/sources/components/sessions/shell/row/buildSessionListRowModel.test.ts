import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    EMPTY_AGENT_ACTIVITY_COUNTS,
    type AgentActivityCounts,
} from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { SessionPending } from '@/sync/store/domains/pending';
import { createReducer } from '@/sync/reducer/reducer';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { sessionTagKey } from '../sessionTagUtils';
import { treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListRowModel } from './buildSessionListRowModel';
import type { SessionListRowPresentationSettings } from './sessionListRowModelTypes';

const NOW_MS = 1_000_000;

function createRenderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 10,
        createdAt: NOW_MS - 300_000,
        updatedAt: NOW_MS - 120_000,
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

function createMessage(id: string, createdAt: number, seq = 1): Message {
    return {
        kind: 'agent-text',
        id,
        seq,
        localId: null,
        createdAt,
        text: `message ${id}`,
    };
}

function createMessages(messages: readonly Message[] = []): SessionMessages {
    return {
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
        messageRevisionsById: {},
        messagesMap: Object.fromEntries(messages.map((message) => [message.id, message])),
        reducerState: createReducer(),
        reducerVersion: 0,
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 1,
        isLoaded: true,
    } as SessionMessages;
}

function createPending(createdAtValues: readonly number[] = []): SessionPending {
    return {
        messages: createdAtValues.map((createdAt, index) => ({
            id: `pending-${index}`,
            localId: null,
            createdAt,
            updatedAt: createdAt,
            text: `pending ${index}`,
            rawRecord: null,
        })),
        discarded: [],
        isLoaded: true,
    };
}

function createBlockedPending(createdAt: number): SessionPending {
    return {
        messages: [{
            id: 'pending-blocked',
            localId: null,
            createdAt,
            updatedAt: createdAt,
            text: 'blocked pending',
            rawRecord: null,
            pendingDeliveryStatus: 'blocked',
        }],
        discarded: [],
        isLoaded: true,
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

describe('buildSessionListRowModel', () => {
    it('carries the canonical safe existing-session draft projection without changing row placement', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('drafted-session')),
            state: {
                draft: {
                    preview: 'Fix the flaky release test',
                },
            },
            dataIndex: 4,
            isFirst: false,
            isLast: true,
            isSingle: false,
            settings: createSettings(),
        });

        expect(model.draft).toEqual({ preview: 'Fix the flaky release test' });
        expect(model.dataIndex).toBe(4);
        expect(model.groupKey).toBe('group-a');
        expect(model.adjacency).toEqual({ isFirst: false, isLast: true, isSingle: false });
    });

    it('uses server-scoped row identity without collapsing same session ids from different servers', () => {
        const session = createRenderable('shared-id');
        const modelA = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-a' }),
            state: {},
            dataIndex: 2,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });
        const modelB = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-b' }),
            state: {},
            dataIndex: 3,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(modelA.rowKey).toBe(sessionTagKey('server-a', 'shared-id'));
        expect(modelB.rowKey).toBe(sessionTagKey('server-b', 'shared-id'));
        expect(modelA.rowKey).not.toBe(modelB.rowKey);
        expect(modelA.treeRowId).toBe(treeRowId.session('server-a', 'shared-id'));
        expect(modelA.testID).toBe('session-list-item-shared-id');
    });

    it('merges the store renderable overlay while preserving row-only pending flags and newer activity', () => {
        const rowSession = createRenderable('s1', {
            metadata: {
                name: 'Row Name',
                summaryText: null,
                path: '/repo/row',
                homeDir: '/repo',
                host: 'row.local',
                machineId: 'row-machine',
            },
            meaningfulActivityAt: 900,
            hasPendingPermissionRequests: true,
        });
        const storeRenderable = createRenderable('s1', {
            metadata: {
                name: 'Store Name',
                summaryText: null,
                path: '/repo/store',
                homeDir: '/repo',
                host: 'store.local',
                machineId: 'store-machine',
            },
            meaningfulActivityAt: 800,
            hasPendingPermissionRequests: false,
        });

        const model = buildSessionListRowModel({
            item: createSessionItem(rowSession),
            state: { renderable: storeRenderable },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.session.metadata?.name).toBe('Store Name');
        expect((model.session as SessionListRenderableSession).hasPendingPermissionRequests).toBe(true);
        expect((model.session as SessionListRenderableSession).meaningfulActivityAt).toBe(900);
    });

    it('preserves row-only blocked pending state when merging the store renderable overlay', () => {
        const rowSession = createRenderable('s1', {
            pendingCount: 2,
            pendingBlockedCount: 1,
        });
        const storeRenderable = createRenderable('s1', {
            pendingCount: 2,
        });

        const model = buildSessionListRowModel({
            item: createSessionItem(rowSession),
            state: { renderable: storeRenderable },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.pendingBlockedCount).toBe(1);
        expect((model.session as SessionListRenderableSession).pendingBlockedCount).toBe(1);
        expect(model.attention.listState).toBe('action_required');
    });

    it('treats explicit store-renderable blocked pending zero as authoritative over stale row state', () => {
        const rowSession = createRenderable('s1', {
            pendingCount: 1,
            pendingBlockedCount: 1,
        });
        const storeRenderable = createRenderable('s1', {
            pendingCount: 1,
            pendingBlockedCount: 0,
        });

        const model = buildSessionListRowModel({
            item: createSessionItem(rowSession),
            state: { renderable: storeRenderable },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.pendingBlockedCount).toBe(0);
        expect((model.session as SessionListRenderableSession).pendingBlockedCount).toBe(0);
        expect(model.attention.listState).toBe('pending');
    });

    it('derives date-group row activity from the raw updated-at timestamp', () => {
        const session = createRenderable('s1', {
            createdAt: NOW_MS - 900_000,
            updatedAt: NOW_MS - 240_000,
            meaningfulActivityAt: NOW_MS - 600_000,
        });
        const model = buildSessionListRowModel({
            item: createSessionItem(session, { groupKind: 'date' }),
            state: {
                messages: createMessages([createMessage('m1', NOW_MS - 120_000)]),
                pending: createPending([NOW_MS - 60_000]),
            },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ relativeNowMs: NOW_MS }),
        });

        expect(model.activity.mode).toBe('updatedAt');
        expect(model.activity.timestamp).toBe(NOW_MS - 240_000);
        expect(model.activity.label).toBe('4m');
    });

    it('keeps active attention status visible when the group would otherwise prefer a path subtitle', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - 10,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.secondaryLineMode).toBe('path');
        expect(model.attention.rowState).toBe('working');
        expect(model.presentation.secondaryLine).toBe('status');
        expect(model.status.state).toBe('thinking');
    });

    it('presents retained working placement as a paused working row', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            }), { groupKind: 'working', workingPlacementReason: 'working-retained' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        // Live signals are stale, so the raw status is not working — but the
        // placement retains the session in the working group, and the row
        // presents that as a PAUSED working indicator instead of nothing.
        expect(model.status.state).not.toBe('thinking');
        expect(model.attention.rowState).toBe('working');
        expect(model.workingIndicatorPaused).toBe(true);
        expect(model.presentation.attentionIndicator).toBe('working');
        // The status line must not imply live activity under the paused
        // indicator — the dedicated retained status text is used instead.
        expect(model.presentation.statusTextKey).toBe('status.workingRetained');
    });

    it('does not pause the indicator for live working sessions in the working group', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - 10,
            }), { groupKind: 'working', workingPlacementReason: 'working' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.attention.rowState).toBe('working');
        expect(model.workingIndicatorPaused).toBe(false);
    });

    it('does not override alerting attention states for retained working placement', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                presence: 'online',
                activeAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: NOW_MS - 10,
                lastRuntimeIssue: {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'auth_error',
                    source: 'auth_error',
                    occurredAt: NOW_MS - 10,
                } as any,
            }), { groupKind: 'working', workingPlacementReason: 'working-retained' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.attention.rowState).toBe('failed');
        expect(model.workingIndicatorPaused).toBe(false);
    });

    it('explains a session the person kept in the attention band', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1'), {
                groupKind: 'attention',
                attentionPromotionReason: 'standing',
            }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        // The session was read and nothing is running in it, so the row must not
        // borrow an unread/working signal to justify its place in the band — it
        // says why it is there and stays visually quiet.
        expect(model.attention.rowState).toBe('quiet');
        expect(model.presentation.attentionIndicator).toBe('standing');
        expect(model.presentation.secondaryLine).toBe('status');
        expect(model.presentation.statusTextKey).toBe('status.keptInAttention');
        expect(model.presentation.titleTone).toBe('quiet');
    });

    it('does not present standing for a row promoted for any other reason', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1'), {
                groupKind: 'attention',
                attentionPromotionReason: 'unread',
            }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.presentation.attentionIndicator).toBe('none');
        expect(model.presentation.statusTextKey).toBeUndefined();
    });

    it('presents background activity with the normal working indicator and precise neutral secondary copy', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10_000,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastViewedSessionSeq: 9,
                hasUnreadMessages: true,
                pendingCount: 2,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: NOW_MS - 1_000,
                runtimeActivityRevision: 1,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('background_active');
        expect(model.status.statusColor).toBe('default-token');
        expect(model.status.statusDotColor).toBe('default-token');
        expect(model.attention.listState).toBe('pending');
        expect(model.attention.rowState).toBe('pending');
        expect(model.hasUnreadMessages).toBe(true);
        expect(model.pendingCount).toBe(2);
        expect(model.presentation.attentionIndicator).toBe('working');
        expect(model.presentation.secondaryLine).toBe('status');
        expect(model.presentation.backgroundActivityStatusLine).toBe(true);
        expect(model.presentation.statusTextKey).toBeUndefined();
        expect(model.workingIndicatorPaused).toBe(false);
    });

    it('keeps disconnected row presentation ahead of background activity', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: false,
                presence: 0,
                thinking: false,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: NOW_MS - 5_000,
                lastViewedSessionSeq: 10,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: NOW_MS - 1_000,
                runtimeActivityRevision: 1,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('disconnected');
        expect(model.presentation.backgroundActivityStatusLine).toBeUndefined();
    });

    it('keeps explicit unknown activity quiet', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: false,
                thinking: false,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: NOW_MS - 5_000,
                lastViewedSessionSeq: 10,
                runtimeActivityState: 'unknown',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: NOW_MS - 1_000,
                runtimeActivityRevision: 9,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.attention.rowState).toBe('quiet');
        expect(model.presentation.attentionIndicator).toBe('none');
        expect(model.presentation.titleTone).toBe('quiet');
        expect(model.presentation.secondaryLine).toBe('path');
        expect(model.presentation.statusTextKey).toBeUndefined();
        expect(model.workingIndicatorPaused).toBe(false);
    });

    it('schedules exactly one clock refresh for detached activity: the instant its evidence expires', () => {
        // Was: "does not schedule a clock refresh for detached activity". Background activity can
        // now go quiet, so the row that shows it has to be woken when it does — otherwise the
        // freshness gate only takes effect the next time something unrelated re-renders, which is
        // how a dead session kept saying "running in background" forever. One wake, on the newest
        // witness, not one per signal.
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 15_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: NOW_MS - 1_000,
                runtimeActivityRevision: 4,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.nextRuntimeFreshnessAtMs).toBe(NOW_MS - 1_000 + 120_000);
    });

    it('does not schedule a clock refresh once nothing witnesses the detached activity', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 300_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: NOW_MS - 300_000,
                runtimeActivityRevision: 4,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.nextRuntimeFreshnessAtMs).toBeNull();
    });

    it('keeps foreground working presentation when detached runtime activity overlaps an active turn', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 1_000,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - 2_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: NOW_MS - 1_000,
                runtimeActivityRevision: 1,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('thinking');
        expect(model.attention.rowState).toBe('working');
        expect(model.presentation.attentionIndicator).toBe('working');
    });

    it('leaves rows idle when runtime activity count is zero', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10_000,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: NOW_MS - 5_000,
                lastViewedSessionSeq: 10,
                runtimeActivityState: 'idle',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: NOW_MS - 1_000,
                runtimeActivityRevision: 1,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('waiting');
        expect(model.attention.rowState).toBe('quiet');
        expect(model.presentation.attentionIndicator).toBe('none');
    });

    it('schedules runtime freshness from fresh active heartbeat when an in-progress observation is stale', () => {
        const activeAt = NOW_MS - 10;
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt,
                thinking: true,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 30_000,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('thinking');
        expect(model.nextRuntimeFreshnessAtMs).toBe(activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    });

    it('schedules runtime freshness from active heartbeat for stale in-progress turns without legacy thinking', () => {
        const activeAt = NOW_MS - 10;
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 30_000,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('thinking');
        expect(model.nextRuntimeFreshnessAtMs).toBe(activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    });

    it('does not schedule runtime freshness from meaningful activity alone', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 30_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: NOW_MS - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: NOW_MS - 10,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('waiting');
        expect(model.nextRuntimeFreshnessAtMs).toBeNull();
    });

    it('does not schedule runtime freshness from legacy thinking after terminal turn projection', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1', {
                active: true,
                activeAt: NOW_MS - 10,
                thinking: true,
                thinkingAt: NOW_MS - 10,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: NOW_MS - 100,
            }), { groupKind: 'date' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings({ runtimeNowMs: NOW_MS }),
        });

        expect(model.status.state).toBe('waiting');
        expect(model.nextRuntimeFreshnessAtMs).toBeNull();
    });

    it('uses presentation-setting status colors instead of hidden default colors', () => {
        const model = buildSessionListRowModel({
            item: createSessionItem(createRenderable('s1')),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.status.statusColor).toBe('connected-token');
        expect(model.status.statusDotColor).toBe('connected-token');
    });

    it('uses server-scoped reachability subtitles for duplicate session ids', () => {
        const session = createRenderable('shared-id');
        const settings = createSettings({
            hasMultipleMachines: true,
            reachableSessionDisplayByKey: {
                [sessionTagKey('server-a', 'shared-id')]: {
                    machineLabel: 'MacBook',
                    workspaceSubtitle: 'Repo A',
                    workspaceSubtitleEllipsizeMode: 'tail',
                },
                [sessionTagKey('server-b', 'shared-id')]: {
                    machineLabel: 'Linux Box',
                    workspaceSubtitle: 'Repo B',
                    workspaceSubtitleEllipsizeMode: 'head',
                },
            },
        });

        const modelA = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-a' }),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings,
        });
        const modelB = buildSessionListRowModel({
            item: createSessionItem(session, { serverId: 'server-b' }),
            state: {},
            dataIndex: 1,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings,
        });

        expect(modelA.subtitle).toBe('MacBook · Repo A');
        expect(modelA.subtitleEllipsizeMode).toBe('tail');
        expect(modelB.subtitle).toBe('Linux Box · Repo B');
        expect(modelB.subtitleEllipsizeMode).toBe('head');
    });

    it('preserves archived, pinned, unread, folder, and tag facts for presentational rows', () => {
        const session = createRenderable('s1', {
            archivedAt: NOW_MS - 1,
            hasUnreadMessages: true,
            pendingCount: 2,
        });
        const key = sessionTagKey('server-a', 's1');
        const model = buildSessionListRowModel({
            item: createSessionItem(session, {
                folderId: 'folder-a',
                folderDepth: 2,
                pinned: false,
                selected: true,
            } as Partial<Extract<SessionListViewItem, { type: 'session' }> & { selected: true }>),
            state: { pending: createPending([NOW_MS - 50_000, NOW_MS - 40_000]) },
            dataIndex: 5,
            isFirst: false,
            isLast: true,
            isSingle: false,
            settings: createSettings({
                pinnedSessionKeys: [key],
                sessionTagsByKey: { [key]: ['review', 'urgent'] },
                allKnownTags: ['review', 'urgent'],
            }),
        });

        expect(model.isArchived).toBe(true);
        expect(model.isPinned).toBe(true);
        expect(model.isSelected).toBe(true);
        expect(model.hasUnreadMessages).toBe(true);
        expect(model.pendingCount).toBe(2);
        expect(model.folder.id).toBe('folder-a');
        expect(model.folder.depth).toBe(2);
        expect(model.tags).toEqual(['review', 'urgent']);
        expect(model.adjacency).toEqual({ isFirst: false, isLast: true, isSingle: false });
    });

    it('promotes blocked pending delivery to action-required row attention from the server aggregate', () => {
        const session = createRenderable('s-blocked', {
            pendingCount: 2,
            pendingBlockedCount: 1,
        });
        const model = buildSessionListRowModel({
            item: createSessionItem(session),
            state: {},
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.pendingCount).toBe(2);
        expect(model.pendingBlockedCount).toBe(1);
        expect(model.attention.listState).toBe('action_required');
    });

    it('promotes blocked pending delivery to action-required row attention from loaded pending details', () => {
        const session = createRenderable('s-blocked-detail', {
            pendingCount: 1,
        });
        const model = buildSessionListRowModel({
            item: createSessionItem(session),
            state: { pending: createBlockedPending(NOW_MS - 50_000) },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(model.pendingBlockedCount).toBe(1);
        expect(model.attention.listState).toBe('action_required');
    });

    it('uses the server blocked-pending aggregate over stale loaded pending details', () => {
        const blockedAggregateSession = createRenderable('s-blocked-aggregate-authoritative', {
            pendingCount: 1,
            pendingBlockedCount: 1,
        });
        const blockedModel = buildSessionListRowModel({
            item: createSessionItem(blockedAggregateSession),
            state: { pending: createPending([NOW_MS - 50_000]) },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(blockedModel.pendingBlockedCount).toBe(1);
        expect(blockedModel.attention.listState).toBe('action_required');

        const unblockedAggregateSession = createRenderable('s-unblocked-aggregate-authoritative', {
            pendingCount: 1,
            pendingBlockedCount: 0,
        });
        const unblockedModel = buildSessionListRowModel({
            item: createSessionItem(unblockedAggregateSession),
            state: { pending: createBlockedPending(NOW_MS - 50_000) },
            dataIndex: 0,
            isFirst: true,
            isLast: true,
            isSingle: true,
            settings: createSettings(),
        });

        expect(unblockedModel.pendingBlockedCount).toBe(0);
        expect(unblockedModel.attention.listState).toBe('pending');
    });

    /**
     * A list row never holds a session's real metadata, only the narrow renderable projection, so
     * the count has to travel on that projection. A test that fed a full `Session` here would pass
     * while every real virtualized row silently reported zero.
     */
    describe('agent activity count (R-8)', () => {
        function renderableWithCounts(counts: Partial<AgentActivityCounts>): SessionListRenderableSession {
            const base = createRenderable('s-agents');
            return {
                ...base,
                metadata: {
                    ...base.metadata!,
                    agentActivityCounts: { ...EMPTY_AGENT_ACTIVITY_COUNTS, ...counts },
                },
            };
        }

        function buildWithSetting(enabled: boolean, counts: Partial<AgentActivityCounts>) {
            return buildSessionListRowModel({
                item: createSessionItem(renderableWithCounts(counts)),
                dataIndex: 0,
                isFirst: true,
                isLast: true,
                isSingle: true,
                settings: createSettings({ agentActivityCountEnabled: enabled }),
            });
        }

        it('says nothing while the opt-in setting is off, which is the default', () => {
            expect(createSettings().agentActivityCountEnabled).toBe(false);
            expect(buildWithSetting(false, { live: 3, liveSubagents: 3 }).agentActivityLabel).toBeNull();
        });

        it('names the session\'s live agents once the setting is on', () => {
            expect(buildWithSetting(true, { live: 3, liveSubagents: 3 }).agentActivityLabel)
                .toBe('3 subagents working');
        });

        /**
         * RULING-10 at the row.
         *
         * The row understated a five-agent workflow exactly as the chip did — one number through one
         * noun, "1 agent working" — because it read a scalar rather than the description. It now
         * composes through the same owner as the chip, so the two cannot disagree about the same
         * session.
         */
        it('states a workflow and its agent complement, exactly as the composer chip does', () => {
            expect(buildWithSetting(true, { live: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 5 }).agentActivityLabel)
                .toBe('1 workflow, 5 agents');
        });

        it('says nothing for a session with no published activity', () => {
            expect(buildSessionListRowModel({
                item: createSessionItem(createRenderable('s-quiet')),
                dataIndex: 0,
                isFirst: true,
                isLast: true,
                isSingle: true,
                settings: createSettings({ agentActivityCountEnabled: true }),
            }).agentActivityLabel).toBeNull();
        });
    });
});
