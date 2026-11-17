import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionViewerFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListAttentionPlacement } from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useActivityOverviewSummary, useHomeCompletedBots } from './useActivityOverview';
import { usePendingNavigationOverview } from './usePendingNavigationOverview';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { createActivityAttentionSourceSelector } from './useActivityAttentionSource';

// React Native is the platform boundary; the store, the Activity source, address and attention owners stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const NOW_MS = 1_700_000_000_000;
const SESSIONS = 1_000;
const initialState = storage.getState();

function idleSession(id: string): Session {
    return createSessionFixture({ id, serverId: 'server-a', viewer: undefined, active: true, presence: 'online',
        createdAt: NOW_MS - 10_000, updatedAt: NOW_MS - 10_000, activeAt: NOW_MS - 10_000, lastViewedSessionSeq: 1,
        agentState: { requests: {}, completedRequests: {} } });
}

function permissionSession(id: string): Session {
    const createdAt = NOW_MS - 1_000;
    return { ...idleSession(id), updatedAt: createdAt,
        agentState: { requests: { req_1: { tool: 'Bash', kind: 'permission' as const, arguments: {}, createdAt } }, completedRequests: {} } };
}

describe('shared Activity summary and pending navigation at a thousand Sessions', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
        vi.useRealTimers();
    });

    it('updates Needs you and Next when the Home retires a native approval', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const id = 'approval-session';
        const source = [{ type: 'session' as const, serverId, sessionId: id, groupKey: 'project-a' }];
        const pending = createSessionFixture({
            id, serverId, active: true, createdAt: NOW_MS - 1000, updatedAt: NOW_MS - 1000, activeAt: NOW_MS - 1000,
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: NOW_MS - 1000,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: NOW_MS - 1000,
            viewer: createSessionViewerFixture({
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' },
            }),
        });
        await act(async () => {
            const state = storage.getState();
            state.applyServerScopedSessionListRows(serverId, [buildSessionListRenderableFromSession(pending)], {
                source: 'ordinary', mode: 'replace',
            });
            state.applySessions([pending]);
            state.applyReady();
        });
        let nextCount: number | undefined;
        function Next() {
            nextCount = usePendingNavigationOverview(null, true).count;
            return null;
        }
        await renderScreen(<Next />);
        const readSidebar = () => buildSessionListAttentionPlacement({
            source, options: { mode: 'global' }, nowMs: NOW_MS,
            resolveSessionRow: (home, sessionId) => home ? storage.getState().sessionListRowsByServerId[home]?.[sessionId] ?? null : null,
        });
        expect(readSidebar()?.attentionItems).toContainEqual(expect.objectContaining({
            sessionId: id, attentionPlacementReason: 'permission_required',
        }));
        expect(nextCount).toBe(1);

        await act(async () => storage.getState().applySessions([{
            ...pending, active: false, presence: NOW_MS - 1000, updatedAt: NOW_MS,
            latestTurnStatus: 'cancelled', latestTurnStatusObservedAt: NOW_MS,
            viewer: createSessionViewerFixture({ relevance: { relevant: true, reasons: ['owned_by_me'] } }),
        }]));
        expect(readSidebar()).toBeNull();
        expect(nextCount).toBe(0);
    });

    it('muse.experience.pc13 re-reads only the changed Session and commits no attention reader for an unrelated update', async () => {
        const previousStackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 80;
        // Count this corridor's row reads (selector, address owner, classifiers), not other subscribers'.
        const fromActivity = () => /(?:buildActivityOverviewFromSource|buildPendingNavigationFromSource|activitySourceSessionAddresses|createActivityAttentionStoreSourceSelector|useActivityAttentionSource|useActivityOverview|usePendingNavigationOverview|sharedActivitySourceProjection)\.tsx?:/
            .test(new Error().stack ?? '');
        let rowReads = 0;
        const countRows = <T extends object>(values: T): T => new Proxy(values, { get(target, key, receiver) {
            if (typeof key === 'string' && key.startsWith('scale-') && fromActivity()) rowReads += 1;
            return Reflect.get(target, key, receiver);
        } });
        const sessions = Object.fromEntries(Array.from({ length: SESSIONS }, (_, index) => {
            const id = `scale-${index}`;
            return [id, index === 7 ? permissionSession(id) : idleSession(id)];
        }));
        const rows = Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, buildSessionListRenderableFromSession(session)]));
        storage.setState({
            ...storage.getState(),
            isDataReady: true,
            sessions,
            sessionListRowsByServerId: { 'server-a': countRows(rows) },
            ordinarySessionListMembershipByServerId: { 'server-a': Object.keys(sessions) },
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            sessionListRenderableDelta: { revision: 100, changedSessionIds: Object.keys(sessions), removedSessionIds: [], rebuiltSessionListIndex: false },
        }, true);

        const read: Record<string, { needsYou?: number; pending?: number }> = {};
        const commits = createRenderCommitCounter();
        function Summary(props: Readonly<{ name: string }>) {
            useRenderCommitCounter(commits);
            read[props.name] = { needsYou: useActivityOverviewSummary().needsYouCount };
            return null;
        }
        function Pending(props: Readonly<{ name: string; sessionId: string }>) {
            useRenderCommitCounter(commits);
            const address = React.useMemo(() => ({ serverId: 'server-a', sessionId: props.sessionId }), [props.sessionId]);
            read[props.name] = { pending: usePendingNavigationOverview(address, true).count };
            return null;
        }
        await renderScreen(<>
            <Summary name="rail" /><Summary name="status" />
            <Pending name="header" sessionId="scale-1" /><Pending name="composer" sessionId="scale-42" />
        </>);
        expect(read).toEqual({ rail: { needsYou: 1 }, status: { needsYou: 1 }, header: { pending: 1 }, composer: { pending: 1 } });

        try {
            // One Session starts waiting on the person.
            const waiting = permissionSession('scale-42');
            rowReads = 0;
            commits.reset();
            await act(async () => storage.setState({
                sessions: { ...sessions, [waiting.id]: waiting },
                sessionListRowsByServerId: { 'server-a': countRows({ ...rows, [waiting.id]: buildSessionListRenderableFromSession(waiting) }) },
                sessionListRenderableDelta: { revision: 101, changedSessionIds: [waiting.id], removedSessionIds: [], rebuiltSessionListIndex: false },
            }));
            expect(read).toEqual({ rail: { needsYou: 2 }, status: { needsYou: 2 }, header: { pending: 2 }, composer: { pending: 1 } });
            // Two reads per shared projection (address owner + classifier) for 4 mounted readers of 1,000 Sessions.
            expect({ rowReads, ...commits.read() }).toEqual({ rowReads: 4, renders: 3, commits: 3 });

            // A row write that changes nothing either projection shows renders no reader.
            const touched = { ...sessions['scale-43']!, seq: (sessions['scale-43']!.seq ?? 0) + 1 };
            const latestRows = storage.getState().sessionListRowsByServerId['server-a']!;
            rowReads = 0;
            commits.reset();
            await act(async () => storage.setState({
                sessions: { ...storage.getState().sessions, [touched.id]: touched },
                sessionListRowsByServerId: { 'server-a': countRows({ ...latestRows, [touched.id]: buildSessionListRenderableFromSession(touched) }) },
                sessionListRenderableDelta: { revision: 102, changedSessionIds: [touched.id], removedSessionIds: [], rebuiltSessionListIndex: false },
            }));
            expect({ rowReads, ...commits.read() }).toEqual({ rowReads: 4, renders: 0, commits: 0 });
        } finally {
            Error.stackTraceLimit = previousStackLimit;
        }
    });

    it('publishes no unchanged Home observations across twenty Session publications', () => {
        const sessions = Object.fromEntries(Array.from({ length: SESSIONS }, (_, index) => {
            const id = `scale-${index}`;
            return [id, idleSession(id)];
        }));
        let state = { ...storage.getState(), sessions,
            concurrentSessionListCacheByServerId: { 'server-a': { serverName: 'A',
                listObservation: { phase: 'ready' as const, lastSuccessAt: NOW_MS } } } };
        const select = createActivityAttentionSourceSelector({ activeServer: getActiveServerSnapshot(),
            personalMembership: { membershipByServerId: {}, statesByServerId: {}, coverageComplete: false },
            includeSessionMessages: false, changeDetection: 'identity' });
        const initial = select(state);
        let current = initial;
        let sessionPublications = 0;
        let homePublications = 0;
        for (let index = 0; index < 20; index += 1) {
            const session = state.sessions[`scale-${index}`]!;
            state = { ...state, sessions: { ...state.sessions, [session.id]: { ...session, seq: session.seq + 1 } } };
            const next = select(state);
            if (next.sessionsById !== current.sessionsById) sessionPublications += 1;
            if (next.sessionListHomeObservationByServerId !== current.sessionListHomeObservationByServerId) homePublications += 1;
            current = next;
        }
        expect({ sessionPublications, homePublications }).toEqual({ sessionPublications: 20, homePublications: 0 });
        const offline = select({ ...state, concurrentSessionListCacheByServerId: { 'server-a': { serverName: 'A',
            listObservation: { phase: 'offline', lastSuccessAt: NOW_MS } } } });
        expect(offline.sessionListHomeObservationByServerId).not.toBe(initial.sessionListHomeObservationByServerId);
        expect(offline.sessionListHomeObservationByServerId?.['server-a']?.phase).toBe('offline');
    });

    it('classifies only the changed row for Completed Bots without republishing unchanged Bot facts', async () => {
        const previousStackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 80;
        const classified = new Set<string>();
        const countRows = <T extends object>(values: T): T => new Proxy(values, { get(target, key, receiver) {
            if (typeof key === 'string' && key.startsWith('scale-')
                && /buildActivityOverviewFromSource\.tsx?:/.test(new Error().stack ?? '')) classified.add(key);
            return Reflect.get(target, key, receiver);
        } });
        const ready = (id: string, bot: boolean): Session => createSessionFixture({
            ...idleSession(id),
            metadata: { path: '/same', host: 'host', ...(bot ? { bot: { kind: 'bot' as const } } : {}) },
            latestTurnId: 'done', latestTurnStatus: 'completed', latestReadyEventSeq: 5, latestReadyEventAt: NOW_MS - 1_000,
            viewer: { latestFailureSeq: null, readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 5 },
                relevance: { relevant: true, reasons: ['owned_by_me'] }, follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' } },
        });
        const sessions = Object.fromEntries(Array.from({ length: SESSIONS }, (_, index) => {
            const id = `scale-${index}`;
            return [id, ready(id, index === 7)];
        }));
        const rows = Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, buildSessionListRenderableFromSession(session)]));
        storage.setState({ ...storage.getState(), isDataReady: true, sessions,
            sessionListRowsByServerId: { 'server-a': countRows(rows) },
            ordinarySessionListMembershipByServerId: { 'server-a': Object.keys(sessions) },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
            sessionListRenderableDelta: { revision: 200, changedSessionIds: Object.keys(sessions), removedSessionIds: [], rebuiltSessionListIndex: false },
        }, true);
        let current: ReturnType<typeof useHomeCompletedBots> | undefined;
        const commits = createRenderCommitCounter();
        function CompletedBots() {
            useRenderCommitCounter(commits);
            current = useHomeCompletedBots();
            return null;
        }
        try {
            await renderScreen(<CompletedBots />);
            expect(current?.readySessions.map(candidate => candidate.sessionId)).toEqual(['scale-7']);
            expect(classified.size).toBe(SESSIONS);
            const initial = current;
            classified.clear();
            commits.reset();
            const touched = { ...sessions['scale-43']!, seq: sessions['scale-43']!.seq + 1 };
            await act(async () => storage.setState({
                sessions: { ...storage.getState().sessions, [touched.id]: touched },
                sessionListRowsByServerId: { 'server-a': countRows({ ...rows, [touched.id]: buildSessionListRenderableFromSession(touched) }) },
                sessionListRenderableDelta: { revision: 201, changedSessionIds: [touched.id], removedSessionIds: [], rebuiltSessionListIndex: false },
            }));
            expect(classified.size).toBe(1);
            expect([...classified]).toEqual(['scale-43']);
            expect({ ...commits.read(), retained: current === initial }).toEqual({ renders: 0, commits: 0, retained: true });
            classified.clear();
            commits.reset();
            const promoted = { ...sessions['scale-42']!, metadataVersion: sessions['scale-42']!.metadataVersion + 1,
                metadata: { ...sessions['scale-42']!.metadata!, bot: { kind: 'bot' as const } } };
            await act(async () => storage.setState({
                sessions: { ...storage.getState().sessions, [promoted.id]: promoted },
                sessionListRowsByServerId: { 'server-a': countRows({ ...storage.getState().sessionListRowsByServerId['server-a'],
                    [promoted.id]: buildSessionListRenderableFromSession(promoted) }) },
                sessionListRenderableDelta: { revision: 202, changedSessionIds: [promoted.id], removedSessionIds: [], rebuiltSessionListIndex: false },
            }));
            expect([...classified]).toEqual(['scale-42']);
            expect(current?.readySessions.map(candidate => candidate.sessionId).sort()).toEqual(['scale-42', 'scale-7']);
            expect(current?.markAllReadTargets).toHaveLength(2);
            expect(commits.read()).toEqual({ renders: 1, commits: 1 });
        } finally { Error.stackTraceLimit = previousStackLimit; }
    });

});
