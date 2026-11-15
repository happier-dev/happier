import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildActivityOverviewSummaryFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { Message } from "@happier-dev/session-core/messages";
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from "@happier-dev/session-core/reducer";
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';
import { createLocalActivityBadgeSnapshotSelector } from './createLocalActivityBadgeSnapshotSelector';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

let currentState: StorageState;

function createStorageState(overrides: Partial<StorageState>): StorageState {
    const sessionIds = Object.keys(overrides.sessions ?? {});
    const derivedOrdinaryState = sessionIds.length > 0
        ? {
            sessionListRowsByServerId: {
                server1: Object.fromEntries(sessionIds.map((id) => [id, createRenderable({ id })])),
            },
            ordinarySessionListMembershipByServerId: { server1: sessionIds },
        }
        : {};
    currentState = createStorageStoreMock({
        sessions: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionMessages: {},
        isDataReady: true,
        profileScope: { serverId: 'server1', accountId: 'account1' },
        ...derivedOrdinaryState,
        ...overrides,
    }).getState();
    return currentState;
}

function createSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
    const { id, ...rest } = overrides;
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        pendingCount: 0,
        ...rest,
        id,
    } as Session;
}

function createRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    const { id, ...rest } = overrides;
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...rest,
        id,
    };
}

function createSessionMessages(overrides: Partial<SessionMessages> = {}): SessionMessages {
    return {
        messageIdsOldestFirst: [],
        messagesById: {},
        messagesMap: {},
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 1,
        isLoaded: true,
        ...overrides,
    };
}

function createPermissionMessage(createdAt: number): Message {
    return {
        kind: 'tool-call',
        id: 'message-permission',
        localId: null,
        createdAt,
        children: [],
        tool: {
            id: 'request-permission',
            name: 'Bash',
            state: 'running',
            input: { command: 'ls' },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
            permission: {
                id: 'request-permission',
                status: 'pending',
                kind: 'permission',
            },
        },
    };
}

function expectNoObjectKeysOrValuesOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectKeys = Object.keys.bind(Object);
    const originalObjectValues = Object.values.bind(Object);
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.keys');
        }
        return originalObjectKeys(value);
    }) as typeof Object.keys);
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.values');
        }
        return originalObjectValues(value);
    }) as typeof Object.values);

    try {
        expect(action).not.toThrow();
    } finally {
        keysSpy.mockRestore();
        valuesSpy.mockRestore();
    }
}

function createSelector() {
    return createLocalActivityBadgeSnapshotSelector({
        // The badge corpus in these cases lives on `server1`, which is also the active Home.
        accountSettingsByServerId: { server1: accountSettingsParse({}) },
        friendRequestCount: 0,
        hasNonNumericInboxAttention: false,
        localSettings: localSettingsDefaults,
    });
}

describe('createLocalActivityBadgeSnapshotSelector', () => {
    beforeEach(() => {
        vi.useRealTimers();
        currentState = createStorageState({});
        registerStorageStateReader(() => currentState);
    });

    it('counts and refreshes a request held only by the authorized rule query corpus', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const session = createSessionFixture({ id: 'rule-query-source', serverId: 'server1', active: true, activeAt: 950, updatedAt: 950,
            access: createSessionAccessFixture('edit'), viewer: createSessionViewerFixture(),
            agentState: { controlledByUser: null, requests: { request_1: {
                tool: 'Read', kind: 'user_action', arguments: {}, createdAt: 950,
            } } } });
        const row = buildSessionListRenderableFromSession(session);
        const state = createStorageState({ sessions: {}, sessionListRowsByServerId: { server1: { [session.id]: row } },
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {} });
        const selector = createLocalActivityBadgeSnapshotSelector({
            accountSettingsByServerId: { server1: accountSettingsParse({}) }, friendRequestCount: 0,
            hasNonNumericInboxAttention: false, localSettings: localSettingsDefaults,
            personalSessionListMembershipByServerId: { server1: [] },
            ruleSessionMembershipByServerId: { server1: [session.id] },
            personalFollowRulesByServerId: { server1: { status: 'ready', accountId: 'account1', rules: [{
                ruleId: 'all-accessible', receiver: { kind: 'account' }, version: 1,
                definition: { v: 1, enabled: true, policy: { preset: 'important' },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server1'],
                        startedBy: ['you', 'triggers', 'agents'] }) },
            }] } },
        });
        expect(selector(state)).toMatchObject({ hasLocalActivitySource: true, localBadgeState: { count: 1 } });
        const settled = { ...state, sessionListRowsByServerId: { server1: { [session.id]: { ...row,
            hasPendingUserActionRequests: false } } } };
        const after = selector(settled);
        expect(after.localBadgeState.count).toBe(0);
        expect(selector({ ...settled, lastSyncAt: 2_000 })).toBe(after);
    });

    it('recounts rule-only requests after held Section assignment changes without unrelated invalidation', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const session = createSessionFixture({ id: 'section-rule', serverId: 'server1', ownerAccountId: 'account1',
            origin: { kind: 'none' }, active: true, activeAt: 950, updatedAt: 950,
            viewer: createSessionViewerFixture(), pendingUserActionRequestCount: 1, pendingRequestObservedAt: 950 });
        const state = createStorageState({ sessions: { [session.id]: session } });
        const selector = createLocalActivityBadgeSnapshotSelector({
            accountSettingsByServerId: { server1: accountSettingsParse({}) }, friendRequestCount: 0,
            hasNonNumericInboxAttention: false, localSettings: localSettingsDefaults,
            personalFollowRulesByServerId: { server1: { status: 'ready', accountId: 'account1', rules: [{
                ruleId: 'section', receiver: { kind: 'account' }, version: 0,
                definition: { v: 1, enabled: true, policy: { preset: 'important' },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server1'],
                        startedBy: ['you', 'triggers', 'agents'], sections: { include: [{ serverId: 'server1', sectionId: 'section-a' }], exclude: [] } }) },
            }] } },
        });
        expect(selector(state).localBadgeState.count).toBe(0);
        const key = buildSessionOrganizationSessionKey('server1', session.id);
        const held = { ...state, sessionOrganizationFolderAssignmentsBySessionKey: {
            [key]: { sessionId: session.id, folderId: 'section-a' },
        } };
        const selected = selector(held);
        expect(selected.localBadgeState.count).toBe(1);
        expect(selector({ ...held, sessionOrganizationFolderAssignmentsBySessionKey: {
            ...held.sessionOrganizationFolderAssignmentsBySessionKey,
            [buildSessionOrganizationSessionKey('server1', 'unloaded')]: { sessionId: 'unloaded', folderId: 'elsewhere' },
        } })).toBe(selected);
        expect(selector({ ...held, sessionOrganizationFolderAssignmentsBySessionKey: {
            [key]: { sessionId: session.id, folderId: null },
        } }).localBadgeState.count).toBe(0);
    });

    it('counts loaded rule-only requests and invalidates after a Project-only edit', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const session = createSessionFixture({ id: 'rule-only', serverId: 'server1', active: true, activeAt: 950,
            updatedAt: 950, projectKey: 'payments', presence: 'online', access: createSessionAccessFixture('edit'),
            viewer: createSessionViewerFixture(), metadata: { ...createSessionFixture().metadata, path: '/Users/tester/project', host: 'tester.local', projectId: 'payments' },
            pendingUserActionRequestCount: 1, pendingRequestObservedAt: 950 });
        const state = createStorageState({ sessions: { [session.id]: session } });
        const personalFollowRulesByServerId: NonNullable<ActivityAttentionSource['personalFollowRulesByServerId']> = {
            server1: { status: 'ready', accountId: 'account1', rules: [{
                ruleId: 'payments', receiver: { kind: 'account' }, version: 0,
                definition: { v: 1, enabled: true, policy: { preset: 'important' },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server1'],
                        startedBy: ['you', 'triggers', 'agents'], projects: { include: [{ serverId: 'server1', projectKey: 'payments' }], exclude: [] } }) },
            }] },
        };
        expect(buildActivityOverviewSummaryFromSource({ source: { isDataReady: true, sessionsById: state.sessions,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
            personalFollowRulesByServerId }, nowMs: 1_000 }).totalAttentionCount).toBe(1);
        const selector = createLocalActivityBadgeSnapshotSelector({
            accountSettingsByServerId: { server1: accountSettingsParse({}) }, friendRequestCount: 0,
            hasNonNumericInboxAttention: false, localSettings: localSettingsDefaults,
            personalSessionListCoverageComplete: true, personalSessionListMembershipByServerId: { server1: [] },
            personalFollowRulesByServerId,
        });
        expect(selector(state).localBadgeState.count).toBe(1);
        const moved = { ...session, projectKey: 'design', metadata: { ...session.metadata, path: '/Users/tester/project', host: 'tester.local', projectId: 'design' } };
        expect(selector({ ...state, sessions: { [session.id]: moved } }).localBadgeState.count).toBe(0);
    });

    it('crosses quiet hours in both directions without any source identity changing', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
        const state = createStorageState({
            sessionListRowsByServerId: { server1: { session1: createRenderable({ id: 'session1', hasUnreadMessages: true }) } },
            ordinarySessionListMembershipByServerId: { server1: ['session1'] },
        });
        const selector = createLocalActivityBadgeSnapshotSelector({
            accountSettingsByServerId: { server1: accountSettingsParse({ attentionDeliveryPolicyV1: {
                quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }] },
                channels: { badge: { quietHoursBehavior: 'suppress' } },
            } }) },
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            localSettings: localSettingsDefaults,
        });
        expect(selector(state).localBadgeState.count).toBe(1);
        vi.setSystemTime(new Date('2026-10-19T09:00:00Z'));
        expect(selector({ ...state }).localBadgeState.count).toBe(0);
        vi.setSystemTime(new Date('2026-10-19T17:00:00Z'));
        expect(selector({ ...state }).localBadgeState.count).toBe(1);
    });

    it('keeps a long-waiting pending request while its runtime is live', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const state = createStorageState({ sessions: { session1: createSession({
            id: 'session1', active: true, presence: 'online',
            pendingUserActionRequestCount: 1, pendingRequestObservedAt: 1_000,
        }) } });
        expect(selector(state).localBadgeState.count).toBe(1);
        vi.setSystemTime(new Date(1_000_000));
        expect(selector({ ...state }).localBadgeState.count).toBe(1);
    });

    it('does not readmit fixed device settings when badge source records change', () => {
        let overrideReads = 0;
        const selector = createLocalActivityBadgeSnapshotSelector({
            accountSettingsByServerId: { server1: accountSettingsParse({}) },
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            localSettings: {
                get attentionDeviceOverridesV1() {
                    overrideReads += 1;
                    return localSettingsDefaults.attentionDeviceOverridesV1;
                },
            },
        });
        const state = createStorageState({});
        const first = selector(state);
        const readsAfterFirst = overrideReads;
        expect(readsAfterFirst).toBeGreaterThan(0);
        expect(selector({ ...state, sessions: { ...state.sessions } })).toBe(first);
        expect(overrideReads).toBe(readsAfterFirst);
    });

    it('builds large membership signatures with linear address-key allocation', () => {
        const ids = Array.from({ length: 2_000 }, (_, index) => `key-cost-session-${(index * 997) % 2_000}`);
        const state = createStorageState({ ordinarySessionListMembershipByServerId: { server1: ids } });
        // Call-through allocation instrumentation, not a replacement key or classifier.
        const stringify = vi.spyOn(JSON, 'stringify');
        const start = performance.now();
        try {
            createSelector()(state);
            const allocations = stringify.mock.calls.filter(([value]) => Array.isArray(value)
                && value[0] === 'server1' && typeof value[1] === 'string' && value[1].startsWith('key-cost-session-')).length;
            console.info('[PERF-3 badge keys]', JSON.stringify({ addresses: ids.length, allocations, ms: performance.now() - start }));
            // The attention/runtime signatures each walk the same membership once.
            expect(allocations).toBe(ids.length * 2);
        } finally { stringify.mockRestore(); }
    });

    it('counts attention without constructing private display details for closed chrome', () => {
        const metadata = { path: '/repo', host: 'local' };
        Object.defineProperty(metadata, 'name', { get: () => { throw new Error('Badge read private display details'); } });
        const state = createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({ id: 'session1', hasUnreadMessages: true, metadata }) },
            },
            ordinarySessionListMembershipByServerId: { server1: ['session1'] },
        });

        expect(createSelector()(state).localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
    });

    it('reuses the previous badge snapshot when only unrelated renderable fields change', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 10,
                }) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        const second = selector(createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 11,
                }) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(second).toBe(first);
        expect(second).toMatchObject({
            channelDisabled: false,
            sessionOptions: {
                showUnread: true,
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
            },
        });
        expect(second.localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
    });

    it('keeps the published snapshot when qualified index tuples differ only by delimiter placement', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListIndexByServerId: {
                index: [{
                    type: 'session',
                    sessionId: 'alpha',
                    serverId: 'home:b',
                    serverName: 'Home',
                }],
            },
        }));

        const second = selector(createStorageState({
            sessionListIndexByServerId: {
                index: [{
                    type: 'session',
                    sessionId: 'alpha:home',
                    serverId: 'b',
                    serverName: 'Home',
                }],
            },
        }));

        // Both index shapes serialize to `s:alpha:home:b:Home` with the old delimiter join. The
        // re-derivation here yields equal badge facts, so the published snapshot is kept.
        expect(first.localBadgeState).toEqual({ count: 0, showNonNumericDot: false });
        expect(second).toBe(first);
    });

    it('invalidates the badge snapshot when renderable blocked pending delivery changes', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    pendingCount: 4,
                    pendingBlockedCount: 0,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 10,
                } as Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        const second = selector(createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    pendingCount: 4,
                    pendingBlockedCount: 1,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 10,
                } as Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(first.localBadgeState).toEqual({ count: 0, showNonNumericDot: false });
        expect(second).not.toBe(first);
        expect(second.localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
    });

    it('keeps the published snapshot when optimistic thinking starts without changing a badge fact', () => {
        const selector = createSelector();
        const firstSession = createSession({
            id: 'optimistic-thinking',
            optimisticThinkingAt: null,
        });
        const secondSession = {
            ...firstSession,
            optimisticThinkingAt: Date.now(),
        };
        const first = selector(createStorageState({
            sessions: {
                [firstSession.id]: firstSession,
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: firstSession.id, serverId: 'server1', serverName: undefined }],
            },
        }));

        const second = selector(createStorageState({
            sessions: {
                [secondSession.id]: secondSession,
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: secondSession.id, serverId: 'server1', serverName: undefined }],
            },
        }));

        // Optimistic thinking re-derives the badge; with no badge fact changed nothing is republished.
        expect(second).toBe(first);
        expect(second.localBadgeState).toEqual({ count: 0, showNonNumericDot: false });
    });

    it('invalidates the badge snapshot when stored message versions change for a candidate session', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2_100));
        const selector = createSelector();
        const session = createSession({
            id: 'session1',
            active: true,
            presence: 'online',
            lastViewedSessionSeq: 5,
            seq: 50,
            updatedAt: 2_000,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 2_000,
            metadata: { path: '/repo', host: 'local' },
        });
        const first = selector(createStorageState({
            sessions: { session1: session },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({ messagesVersion: 1 }),
            },
        }));

        const second = selector(createStorageState({
            sessions: { session1: session },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: ['message6'],
                    messagesById: {
                        message6: {
                            kind: 'tool-call',
                            id: 'message6',
                            localId: null,
                            createdAt: 2_001,
                            children: [],
                            tool: {
                                id: 'request1',
                                name: 'AskUserQuestion',
                                state: 'error',
                                input: { q: 'continue?' },
                                createdAt: 2_001,
                                startedAt: 2_001,
                                completedAt: 2_002,
                                description: null,
                                permission: {
                                    id: 'request1',
                                    status: 'canceled',
                                    kind: 'user_action',
                                },
                            },
                        },
                    },
                    messagesVersion: 2,
                }),
            },
        }));

        expect(first.localBadgeState.count).toBe(1);
        expect(second).not.toBe(first);
        expect(second.localBadgeState.count).toBe(0);
    });

    it('reuses the previous badge snapshot when unrelated stored messages change', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                }) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                unrelated: createSessionMessages({ messagesVersion: 1 }),
            },
        }));

        const second = selector(createStorageState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                }) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                unrelated: createSessionMessages({ messagesVersion: 2 }),
            },
        }));

        expect(second).toBe(first);
    });

    it('reports local activity sources from index and ordinary membership while bootstrapping', () => {
        const selector = createSelector();

        expect(selector(createStorageState({
            isDataReady: false,
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'missing-session', serverId: 'server1', serverName: undefined }],
            },
        })).hasLocalActivitySource).toBe(true);

        expect(selector(createStorageState({
            isDataReady: false,
            sessionListRowsByServerId: {
                server2: { session2: createRenderable({ id: 'session2', hasUnreadMessages: true }) },
            },
            ordinarySessionListMembershipByServerId: {
                server2: ['session2'],
            },
        })).hasLocalActivitySource).toBe(true);
    });

    it('computes badge snapshots without Object.keys or Object.values over hot state records', () => {
        const selector = createSelector();
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_000,
                    metadata: { path: '/repo', host: 'local' },
                }),
            },
            sessionListRowsByServerId: {
                server1: { session2: createRenderable({
                    id: 'session2',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo/other', host: 'local' },
                }) },
            },
            ordinarySessionListMembershipByServerId: {
                server1: ['session2'],
            },
        });
        let snapshot: ReturnType<ReturnType<typeof createLocalActivityBadgeSnapshotSelector>> | undefined;

        expectNoObjectKeysOrValuesOnRecords(() => {
            snapshot = selector(state);
        }, [state.sessions, state.sessionListRowsByServerId]);

        expect(snapshot?.hasLocalActivitySource).toBe(true);
    });

    it('does no per-session renderable derivation on an empty session-list delta tick', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const selector = createSelector();
        let thinkingAtReads = 0;
        const renderable = createRenderable({
            id: 'session1',
            hasUnreadMessages: true,
            metadata: { path: '/repo', host: 'local' },
        });
        Object.defineProperty(renderable, 'thinkingAt', {
            configurable: true,
            enumerable: true,
            get: () => {
                thinkingAtReads += 1;
                return 0;
            },
        });
        const sessionListRowsByServerId = { server1: { session1: renderable } };
        const ordinarySessionListMembershipByServerId = { server1: ['session1'] };
        const first = selector(createStorageState({
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListIndex: true,
            },
            sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId,
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));
        const readsAfterFirstSelection = thinkingAtReads;

        const second = selector(createStorageState({
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: [],
                rebuiltSessionListIndex: false,
            },
            sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId,
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(second).toBe(first);
        expect(thinkingAtReads).toBe(readsAfterFirstSelection);
    });

    it('does no derivation at all on a store commit that moved none of its sources', () => {
        // The commit storm: many store notifications carrying no badge-relevant movement (the
        // delta revision does not even advance). The previous shape rebuilt the whole signature -
        // an O(sessions) pass over every hot record - on each one, only to conclude nothing changed.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const selector = createSelector();
        let thinkingAtReads = 0;
        const renderable = createRenderable({
            id: 'session1',
            hasUnreadMessages: true,
            metadata: { path: '/repo', host: 'local' },
        });
        Object.defineProperty(renderable, 'thinkingAt', {
            configurable: true,
            enumerable: true,
            get: () => {
                thinkingAtReads += 1;
                return 0;
            },
        });
        const sessions = {};
        const sessionMessages = {};
        const sessionListRowsByServerId = { server1: { session1: renderable } };
        const ordinarySessionListMembershipByServerId = { server1: ['session1'] };
        const sessionListIndexByServerId = {
            server1: [{ type: 'session' as const, sessionId: 'session1', serverId: 'server1', serverName: undefined }],
        };
        const concurrentSessionListCacheByServerId = {};
        const sessionListRenderableDelta = {
            revision: 7,
            changedSessionIds: ['session1'],
            removedSessionIds: [],
            rebuiltSessionListIndex: true,
        };
        const sourceSlices = {
            concurrentSessionListCacheByServerId,
            sessionListIndexByServerId,
            sessionListRenderableDelta,
            sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId,
            sessionMessages,
            sessions,
        };

        const first = selector(createStorageState(sourceSlices));
        const readsAfterFirstSelection = thinkingAtReads;

        // A later commit: same slice identities, same delta revision, later wall clock.
        vi.setSystemTime(new Date(10_050));
        const second = selector(createStorageState(sourceSlices));

        expect(second).toBe(first);
        expect(thinkingAtReads).toBe(readsAfterFirstSelection);
    });

    it('still re-derives when canonical ordinary membership moves', () => {
        // The guard against porting a narrower source set than this repository's derivation reads:
        // the badge enumerates canonical scoped rows through ordinary membership, so movement in
        // that membership must invalidate even when the scoped row object itself is unchanged.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const selector = createSelector();
        const sessions = {};
        const sessionMessages = {};
        const sessionListRowsByServerId = { server1: {
            session1: createRenderable({
                id: 'session1',
                hasUnreadMessages: true,
                metadata: { path: '/repo', host: 'local' },
            }),
        } };
        const sessionListRenderableDelta = {
            revision: 7,
            changedSessionIds: ['session1'],
            removedSessionIds: [],
            rebuiltSessionListIndex: true,
        };

        const first = selector(createStorageState({
            concurrentSessionListCacheByServerId: {},
            sessionListIndexByServerId: {},
            sessionListRenderableDelta,
            sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: {},
            sessionMessages,
            sessions,
        }));
        expect(first.localBadgeState).toEqual({ count: 0, showNonNumericDot: false });

        const second = selector(createStorageState({
            concurrentSessionListCacheByServerId: {},
            // Only this slice moved: the scoped row becomes ordinary list membership.
            sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: {
                server1: ['session1'],
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionListRenderableDelta,
            sessionMessages,
            sessions,
        }));

        expect(second).not.toBe(first);
        expect(second.localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
    });

    it('counts transcript-only pending permissions from the selector state', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const permissionMessage = createPermissionMessage(1_000);
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    metadata: { path: '/repo', host: 'local' },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: [permissionMessage.id],
                    messagesById: {
                        [permissionMessage.id]: permissionMessage,
                    },
                    messagesVersion: 2,
                }),
            },
        });
        registerStorageStateReader(() => createStorageState({}));

        const snapshot = selector(state);

        expect(snapshot.localBadgeState.count).toBe(1);
    });

    it('counts same-id pending agent requests when the completed request arguments differ', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(12_600));
        const selector = createSelector();
        const snapshot = selector(createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: null,
                    metadata: { path: '/repo', host: 'local' },
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            permission_retry: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                createdAt: 12_345,
                            },
                        },
                        completedRequests: {
                            permission_retry: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git diff' },
                                completedAt: 12_500,
                                status: 'approved',
                            },
                        },
                    },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(snapshot.localBadgeState.count).toBe(1);
    });

    it('still probes transcript freshness when raw agent requests are terminal-covered', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const permissionMessage = createPermissionMessage(1_000);
        const snapshot = selector(createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 0,
                    presence: 'online',
                    latestTurnStatusObservedAt: 0,
                    metadata: { path: '/repo', host: 'local' },
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            covered_request: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                createdAt: 900,
                            },
                        },
                        completedRequests: {
                            covered_request: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                completedAt: 950,
                                status: 'approved',
                            },
                        },
                    },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: [permissionMessage.id],
                    messagesById: {
                        [permissionMessage.id]: permissionMessage,
                    },
                    messagesVersion: 2,
                }),
            },
        }));

        expect(snapshot.localBadgeState.count).toBe(1);
    });

    it('reuses the previous badge snapshot when an active loaded transcript has no pending requests', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    metadata: { path: '/repo', host: 'local' },
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({ messagesVersion: 2 }),
            },
        });

        const first = selector(state);
        vi.setSystemTime(new Date(2_000));
        const second = selector(state);

        expect(first.localBadgeState.count).toBe(0);
        expect(second).toBe(first);
    });

    it('keeps the published badge snapshot when a streamed reply changes a candidate transcript but not the badge', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const session = createSession({
            id: 'session1',
            active: true,
            activeAt: 1_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            metadata: { path: '/repo', host: 'local' },
            agentState: { controlledByUser: null, requests: {}, completedRequests: null },
        });
        const stateWith = (text: string, messagesVersion: number) => createStorageState({
            sessions: { session1: session },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: ['reply'],
                    messagesById: { reply: { kind: 'agent-text', id: 'reply', localId: null, createdAt: 1_000, text } },
                    messagesVersion,
                }),
            },
        });

        // Three streamed deltas of one reply: the transcript moves, the badge count does not.
        const published = [stateWith('word0 ', 1), stateWith('word0 word1 ', 2), stateWith('word0 word1 word2 ', 3)]
            .map((state) => selector(state));

        expect(published[0].localBadgeState.count).toBe(0);
        expect(new Set(published).size).toBe(1);
    });
});
