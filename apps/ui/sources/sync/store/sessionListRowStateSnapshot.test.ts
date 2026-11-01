import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from './domains/messages';
import type { SessionPending } from './domains/pending';
import {
    createSessionListRuntimePriorityRowScopeSelector,
    createSessionListRowStoreStateSelector,
    selectSessionListRowStateSnapshot,
} from './sessionListRowStateSnapshot';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableMetadata } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { buildSessionOrganizationLabelKey } from '@/sync/domains/session/organization/keys';

const serverProfileMockState = vi.hoisted(() => ({
    profiles: [] as ServerProfile[],
}));

const runtimeClockMockState = vi.hoisted(() => ({
    nowServerMs: null as number | null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            listServerProfiles: () => serverProfileMockState.profiles,
        },
    });
});

vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => runtimeClockMockState.nowServerMs ?? Date.now(),
}));

function createSession(id: string): Session {
    return {
        id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0,
    };
}

function createRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0,
    };
}

const messages = {
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
} satisfies SessionMessages;

const pending = {
    messages: [],
    discarded: [],
    isLoaded: true,
} satisfies SessionPending;

describe('selectSessionListRowStateSnapshot', () => {
    it.each(['renderable', 'session'] as const)('keeps foreign workspace appearance metadata scoped when the active Home shares its session id (%s)', (source) => {
        const activeMetadata = { path: '/active/repo', machineId: 'machine', host: 'active' };
        const activeSession = createSessionFixture({ id: 'shared', metadata: activeMetadata });
        const foreignSession = createSessionFixture({ id: 'shared', metadata: { path: '/foreign/repo', machineId: 'machine', host: 'foreign' } });
        const activeScope = { sessionId: 'shared', serverId: 'server-a', metadata: activeSession.metadata };
        const foreignScope = { sessionId: 'shared', serverId: 'server-b', metadata: foreignSession.metadata };
        const activeColor = { kind: 'custom', hex: '#123456' } as const;
        const foreignColor = { kind: 'custom', hex: '#ABCDEF' } as const;
        const labels = [
            { serverId: 'server-a', metadata: activeSession.metadata, color: activeColor },
            { serverId: 'server-b', metadata: activeSession.metadata, color: activeColor },
            { serverId: 'server-b', metadata: foreignSession.metadata, color: foreignColor },
        ].map(({ serverId, metadata, color }) => {
            const scopeKey = resolveSessionWorkspacePresentation({ metadata, machines: {} }).workspaceKey;
            return [buildSessionOrganizationLabelKey({ serverId, labelKind: 'workspace', scopeKey }), {
                labelKind: 'workspace' as const, scopeKey, display: { t: 'plain' as const, v: { color } },
                archivedAt: null, createdAt: 1, updatedAt: 1,
            }] as const;
        });
        const state = {
            sessions: { shared: activeSession },
            sessionListRenderables: source === 'renderable' ? { shared: {
                ...createRenderable('shared'), metadata: buildSessionListRenderableMetadata(activeSession.metadata),
            } } : {},
            sessionMessages: { shared: messages },
            sessionPending: { shared: pending },
            sessionOrganizationLabelsByLabelKey: Object.fromEntries(labels),
        };
        const selector = createSessionListRowStoreStateSelector([activeScope, foreignScope], 'server-a');
        const selected = selector(state);
        const active = selectSessionListRowStateSnapshot(selected, activeScope);
        const foreign = selectSessionListRowStateSnapshot(selected, foreignScope);
        expect(active.appearanceColor).toEqual(activeColor);
        expect(active.renderable ?? active.session).toBe(state.sessionListRenderables.shared ?? activeSession);
        expect(foreign).toEqual({ session: undefined, renderable: undefined, messages: undefined, pending: undefined, appearanceColor: foreignColor });

        const foreignOnly = createSessionListRowStoreStateSelector([foreignScope], 'server-a');
        const before = foreignOnly(state);
        const changedActiveSession = { ...activeSession, metadata: { ...activeMetadata, path: '/active/changed' } };
        expect(foreignOnly({ ...state, sessions: { shared: changedActiveSession },
            sessionListRenderables: source === 'renderable' ? { shared: {
                ...createRenderable('shared'), metadata: buildSessionListRenderableMetadata(changedActiveSession.metadata),
            } } : {},
        })).toBe(before);
    });

    afterEach(() => {
        serverProfileMockState.profiles = [];
        runtimeClockMockState.nowServerMs = null;
        vi.useRealTimers();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('reads exact per-session inputs without depending on outer store map identity', () => {
        const session = createSession('s1');
        const renderable = createRenderable('s1');
        const snapshotA = selectSessionListRowStateSnapshot({
            sessions: { s1: session },
            sessionListRenderables: { s1: renderable },
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        }, 's1');
        const snapshotB = selectSessionListRowStateSnapshot({
            sessions: { s1: session, unrelated: createSession('unrelated') },
            sessionListRenderables: { s1: renderable },
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        }, 's1');

        expect(snapshotA.session).toBe(session);
        expect(snapshotB.session).toBe(session);
        expect(snapshotB.renderable).toBe(renderable);
        expect(snapshotB.messages).toBe(messages);
        expect(snapshotB.pending).toBe(pending);
    });

    it('keeps focused row store state stable when unrelated outer maps change', () => {
        const session = createSession('s1');
        const renderable = createRenderable('s1');
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        const first = selector({
            sessions: { s1: session },
            sessionListRenderables: { s1: renderable },
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        });
        const second = selector({
            sessions: { s1: createSession('s1'), unrelated: createSession('unrelated') },
            sessionListRenderables: { s1: renderable },
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        });
        const changedMessages = {
            ...messages,
            messagesVersion: messages.messagesVersion + 1,
        };
        const third = selector({
            sessions: { s1: session, unrelated: createSession('unrelated') },
            sessionListRenderables: { s1: renderable },
            sessionMessages: { s1: changedMessages },
            sessionPending: { s1: pending },
        });

        expect(second).toBe(first);
        expect(third).toBe(first);
        expect(first.sessions?.s1).toBeUndefined();
        expect(third.sessionMessages?.s1).toBeUndefined();

        const selectorWithoutRenderable = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');
        const firstWithoutRenderable = selectorWithoutRenderable({
            sessions: { s1: session },
            sessionListRenderables: {},
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        });
        const secondWithoutRenderable = selectorWithoutRenderable({
            sessions: { s1: session },
            sessionListRenderables: {},
            sessionMessages: { s1: changedMessages },
            sessionPending: { s1: pending },
        });

        expect(secondWithoutRenderable).not.toBe(firstWithoutRenderable);
        expect(secondWithoutRenderable.sessionMessages?.s1).toBe(changedMessages);
    });

    it('keeps focused row store state stable for fresh progress-only renderable timestamp advances', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const firstRenderable = {
            ...createRenderable('s1'),
            seq: 10,
            updatedAt: Date.now() - 5_000,
            meaningfulActivityAt: Date.now() - 5_000,
            active: true,
            activeAt: Date.now() - 5_000,
            presence: 'online' as const,
            latestTurnStatus: 'in_progress' as const,
            hasUnreadMessages: true,
            metadata: { path: '/tmp', host: 'localhost' },
        } satisfies SessionListRenderableSession;
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        const first = selector({
            sessions: {},
            sessionListRenderables: { s1: firstRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });
        const freshProgressRenderable = {
            ...firstRenderable,
            seq: 11,
            updatedAt: firstRenderable.updatedAt + 5_000,
            meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
        } satisfies SessionListRenderableSession;
        const second = selector({
            sessions: {},
            sessionListRenderables: { s1: freshProgressRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });

        expect(second).toBe(first);
        expect(second.sessionListRenderables?.s1).toBe(firstRenderable);

        const laterProgressRenderable = {
            ...firstRenderable,
            seq: 12,
            updatedAt: firstRenderable.updatedAt + 31_000,
            meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 31_000,
        } satisfies SessionListRenderableSession;
        const third = selector({
            sessions: {},
            sessionListRenderables: { s1: laterProgressRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });

        expect(third).not.toBe(first);
        expect(third.sessionListRenderables?.s1).toBe(laterProgressRenderable);
    });

    it('keeps focused row store state stable when fresh progress also advances active heartbeat', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const firstRenderable = {
            ...createRenderable('s1'),
            seq: 10,
            updatedAt: Date.now() - 5_000,
            meaningfulActivityAt: Date.now() - 5_000,
            active: true,
            activeAt: Date.now() - 5_000,
            presence: 'online' as const,
            latestTurnStatus: 'in_progress' as const,
            latestTurnStatusObservedAt: Date.now() - 5_000,
            hasUnreadMessages: true,
            metadata: { path: '/tmp', host: 'localhost' },
        } satisfies SessionListRenderableSession;
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        const first = selector({
            sessions: {},
            sessionListRenderables: { s1: firstRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });
        const freshProgressRenderable = {
            ...firstRenderable,
            seq: 11,
            updatedAt: firstRenderable.updatedAt + 5_000,
            meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
            activeAt: firstRenderable.activeAt + 5_000,
        } satisfies SessionListRenderableSession;
        const second = selector({
            sessions: {},
            sessionListRenderables: { s1: freshProgressRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });

        expect(second).toBe(first);
        expect(second.sessionListRenderables?.s1).toBe(firstRenderable);
    });

    it('does not suppress row store updates when an active heartbeat refresh is needed before stale status', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const firstRenderable = {
            ...createRenderable('s1'),
            seq: 10,
            updatedAt: Date.now() - 5_000,
            meaningfulActivityAt: Date.now() - 5_000,
            active: true,
            activeAt: Date.now() - 119_000,
            presence: 'online' as const,
            latestTurnStatus: 'in_progress' as const,
            latestTurnStatusObservedAt: Date.now() - 119_000,
            hasUnreadMessages: true,
            metadata: { path: '/tmp', host: 'localhost' },
        } satisfies SessionListRenderableSession;
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        const first = selector({
            sessions: {},
            sessionListRenderables: { s1: firstRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });
        const heartbeatRefreshRenderable = {
            ...firstRenderable,
            seq: 11,
            updatedAt: firstRenderable.updatedAt + 5_000,
            meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
            activeAt: Date.now(),
        } satisfies SessionListRenderableSession;
        const second = selector({
            sessions: {},
            sessionListRenderables: { s1: heartbeatRefreshRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });

        expect(second).not.toBe(first);
        expect(second.sessionListRenderables?.s1).toBe(heartbeatRefreshRenderable);
    });

    it('does not suppress row store updates when a fresh activity patch starts thinking', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const firstRenderable = {
            ...createRenderable('s1'),
            seq: 10,
            updatedAt: Date.now() - 5_000,
            meaningfulActivityAt: Date.now() - 5_000,
            active: true,
            activeAt: Date.now() - 5_000,
            presence: 'online' as const,
            thinking: false,
            thinkingAt: 0,
            hasUnreadMessages: true,
            metadata: { path: '/tmp', host: 'localhost' },
        } satisfies SessionListRenderableSession;
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        const first = selector({
            sessions: {},
            sessionListRenderables: { s1: firstRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });
        const thinkingRenderable = {
            ...firstRenderable,
            seq: 11,
            updatedAt: firstRenderable.updatedAt + 5_000,
            meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
            thinking: true,
            thinkingAt: Date.now(),
        } satisfies SessionListRenderableSession;
        const second = selector({
            sessions: {},
            sessionListRenderables: { s1: thinkingRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });

        expect(second).not.toBe(first);
        expect(second.sessionListRenderables?.s1).toBe(thinkingRenderable);
    });

    it('does not suppress row store updates when progress changes make a renderable unread', () => {
        const firstRenderable = {
            ...createRenderable('s1'),
            seq: 10,
            updatedAt: 1_000,
            meaningfulActivityAt: 1_000,
            active: true,
            activeAt: 1_000,
            presence: 'online' as const,
            latestTurnStatus: 'in_progress' as const,
            hasUnreadMessages: false,
            metadata: { path: '/tmp', host: 'localhost' },
        } satisfies SessionListRenderableSession;
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        const first = selector({
            sessions: {},
            sessionListRenderables: { s1: firstRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });
        const unreadRenderable = {
            ...firstRenderable,
            seq: 11,
            updatedAt: 2_000,
            meaningfulActivityAt: 2_000,
            hasUnreadMessages: true,
        } satisfies SessionListRenderableSession;
        const second = selector({
            sessions: {},
            sessionListRenderables: { s1: unreadRenderable },
            sessionMessages: {},
            sessionPending: { s1: pending },
        });

        expect(second).not.toBe(first);
        expect(second.sessionListRenderables?.s1).toBe(unreadRenderable);
    });

    it('reuses unchanged runtime-priority inputs across unrelated updates until their freshness boundary', () => {
        runtimeClockMockState.nowServerMs = 1_000_000;
        let runtimeReads = 0;
        const working = {
            ...createRenderable('s1'),
            active: true,
            activeAt: 990_000,
            get latestTurnStatus() {
                runtimeReads += 1;
                return 'in_progress' as const;
            },
            latestTurnStatusObservedAt: 995_000,
        } satisfies SessionListRenderableSession;
        const scope = { sessionId: 's1', serverId: 'server-a' };
        const selector = createSessionListRuntimePriorityRowScopeSelector([scope], 'server-a');
        const renderables = { s1: working, other: createRenderable('other') };
        const first = selector({ sessionListRenderables: renderables });
        const initialReads = runtimeReads;
        expect(first).toEqual([scope]);
        expect(initialReads).toBeGreaterThan(0);

        runtimeClockMockState.nowServerMs = 1_001_000;
        expect(selector({ sessionListRenderables: renderables, sessionMessages: { other: messages } })).toBe(first);
        expect(selector({
            sessionListRenderables: { ...renderables, other: { ...renderables.other, updatedAt: 1234 } },
        })).toBe(first);
        expect(runtimeReads).toBe(initialReads);

        runtimeClockMockState.nowServerMs = 1_115_000;
        expect(selector({ sessionListRenderables: renderables })).toEqual([]);
        expect(runtimeReads).toBeGreaterThan(initialReads);

        // A correction of the server clock can make the same input fresh again.
        runtimeClockMockState.nowServerMs = 1_000_000;
        expect(selector({ sessionListRenderables: renderables })).toEqual([scope]);
        expect(selector({
            sessionListRenderables: {
                ...renderables,
                s1: { ...working, latestTurnStatus: 'completed' },
            },
        })).toEqual([]);
    });

    it('tracks runtime-priority scopes without changing for non-priority row overlay updates', () => {
        const s1 = createRenderable('s1');
        const s2 = createRenderable('s2');
        const selector = createSessionListRuntimePriorityRowScopeSelector([
            { sessionId: 's1', serverId: 'server-a' },
            { sessionId: 's2', serverId: 'server-a' },
        ], 'server-a');

        const first = selector({
            sessionListRenderables: {
                s1,
                s2,
            },
        });
        const unreadOnly = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    hasUnreadMessages: true,
                    latestReadyEventSeq: 2,
                },
                s2,
            },
        });
        const runtimeIssueOnly = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    lastRuntimeIssue: {
                        v: 1,
                        scope: 'primary_session',
                        status: 'failed',
                        code: 'failed',
                        source: 'unknown',
                        occurredAt: 123,
                    },
                },
                s2,
            },
        });
        const actionRequired = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    hasUnreadMessages: true,
                    latestReadyEventSeq: 2,
                    hasPendingUserActionRequests: true,
                    pendingRequestObservedAt: 100,
                },
                s2,
            },
        });
        const stillActionRequired = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    hasUnreadMessages: true,
                    latestReadyEventSeq: 3,
                    hasPendingUserActionRequests: true,
                    pendingRequestObservedAt: 200,
                },
                s2,
            },
        });

        expect(first).toEqual([]);
        expect(unreadOnly).toBe(first);
        expect(actionRequired).toEqual([{ sessionId: 's1', serverId: 'server-a' }]);
        expect(runtimeIssueOnly).toBe(first);
        expect(stillActionRequired).toBe(actionRequired);
    });

    it('tracks background activity transitions as runtime-priority scopes without an observedAt lease', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const nowMs = Date.now();
        const s1 = createRenderable('s1');
        const selector = createSessionListRuntimePriorityRowScopeSelector([
            { sessionId: 's1', serverId: 'server-a' },
        ], 'server-a');

        const idle = selector({
            sessionListRenderables: { s1 },
        });
        const runtimeWorking = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    active: true,
                    activeAt: nowMs - 10_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: nowMs - 5_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: nowMs - 1_000,
                    runtimeActivityRevision: 1,
                },
            },
        });
        const longRunningRuntimeActivity = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    active: true,
                    activeAt: nowMs - 10_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: nowMs - 5_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: nowMs - 10_000,
                    runtimeActivityRevision: 1,
                },
            },
        });
        const runtimeIdleAgain = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    active: false,
                    activeAt: nowMs - 10_000,
                    presence: 0,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: nowMs - 5_000,
                    runtimeActivityState: 'idle',
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: nowMs - 10_000,
                    runtimeActivityRevision: 2,
                },
            },
        });

        expect(idle).toEqual([]);
        expect(runtimeWorking).toEqual([{ sessionId: 's1', serverId: 'server-a' }]);
        expect(longRunningRuntimeActivity).toBe(runtimeWorking);
        expect(runtimeIdleAgain).toBe(idle);
    });

    it.each([
        ['offline', { active: false, presence: 0, archivedAt: null }],
        ['archived', { active: true, presence: 'online' as const, archivedAt: 123 }],
    ])('does not add Activity-only runtime priority for %s rows', (_label, lifecycle) => {
        const s1 = createRenderable('s1');
        const selector = createSessionListRuntimePriorityRowScopeSelector([
            { sessionId: 's1', serverId: 'server-a' },
        ], 'server-a');

        expect(selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    ...lifecycle,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 100,
                    runtimeActivityRevision: 1,
                },
            },
        })).toEqual([]);
    });

    it('keeps background activity priority independent of the selector clock', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        runtimeClockMockState.nowServerMs = 1_000_000;
        const s1 = createRenderable('s1');
        const selector = createSessionListRuntimePriorityRowScopeSelector([
            { sessionId: 's1', serverId: 'server-a' },
        ], 'server-a');

        const runtimeWorking = selector({
            sessionListRenderables: {
                s1: {
                    ...s1,
                    active: true,
                    activeAt: 990_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 995_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 999_000,
                    runtimeActivityRevision: 1,
                },
            },
        });

        expect(runtimeWorking).toEqual([{ sessionId: 's1', serverId: 'server-a' }]);
    });

    it('records why the row-store selector output changed when telemetry is enabled', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        const session = createSession('s1');
        const selector = createSessionListRowStoreStateSelector([{
            sessionId: 's1',
            serverId: 'server-a',
        }], 'server-a');

        selector({
            sessions: { s1: session },
            sessionListRenderables: {},
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        });
        syncPerformanceTelemetry.reset();

        selector({
            sessions: { s1: createSession('s1') },
            sessionListRenderables: {},
            sessionMessages: { s1: messages },
            sessionPending: { s1: pending },
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((entry) => entry.name === 'ui.sessionsList.rowStoreSelector.changed');
        expect(event?.fields).toEqual(expect.objectContaining({
            scopedRows: 1,
            changedSessions: 1,
            changedRenderables: 0,
            changedMessages: 0,
            changedPending: 0,
        }));
    });

    it('applies active-server overlays only to matching duplicate session ids', () => {
        const session = createSession('shared');
        const renderable = createRenderable('shared');
        const state = {
            activeServerId: 'server-a',
            sessions: { shared: session },
            sessionListRenderables: { shared: renderable },
            sessionMessages: { shared: messages },
            sessionPending: { shared: pending },
        };

        const activeServerSnapshot = selectSessionListRowStateSnapshot(state, {
            sessionId: 'shared',
            serverId: 'server-a',
        });
        const otherServerSnapshot = selectSessionListRowStateSnapshot(state, {
            sessionId: 'shared',
            serverId: 'server-b',
        });

        expect(activeServerSnapshot.session).toBe(session);
        expect(activeServerSnapshot.renderable).toBe(renderable);
        expect(activeServerSnapshot.messages).toBe(messages);
        expect(activeServerSnapshot.pending).toBe(pending);
        expect(otherServerSnapshot.session).toBeUndefined();
        expect(otherServerSnapshot.renderable).toBeUndefined();
        expect(otherServerSnapshot.messages).toBeUndefined();
        expect(otherServerSnapshot.pending).toBeUndefined();
    });

    it('applies active-server overlays when row server id is the selected server identity id', () => {
        serverProfileMockState.profiles = [{
            id: 'localhost-52753',
            name: 'Local dev',
            serverUrl: 'http://127.0.0.1:52753',
            serverIdentityId: 'srv_remote_identity',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        }];
        const session = createSession('shared');
        const renderable = createRenderable('shared');
        const state = {
            activeServerId: 'localhost-52753',
            sessions: { shared: session },
            sessionListRenderables: { shared: renderable },
            sessionMessages: { shared: messages },
            sessionPending: { shared: pending },
        };

        const identityServerSnapshot = selectSessionListRowStateSnapshot(state, {
            sessionId: 'shared',
            serverId: 'srv_remote_identity',
        });
        const otherServerSnapshot = selectSessionListRowStateSnapshot(state, {
            sessionId: 'shared',
            serverId: 'srv_other_identity',
        });

        expect(identityServerSnapshot.session).toBe(session);
        expect(identityServerSnapshot.renderable).toBe(renderable);
        expect(identityServerSnapshot.messages).toBe(messages);
        expect(identityServerSnapshot.pending).toBe(pending);
        expect(otherServerSnapshot.session).toBeUndefined();
        expect(otherServerSnapshot.renderable).toBeUndefined();
        expect(otherServerSnapshot.messages).toBeUndefined();
        expect(otherServerSnapshot.pending).toBeUndefined();
    });
});
