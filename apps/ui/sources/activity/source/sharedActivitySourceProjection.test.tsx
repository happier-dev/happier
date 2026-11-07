import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useActivityOverviewSummary } from './useActivityOverview';
import { usePendingNavigationOverview } from './usePendingNavigationOverview';

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

    it('re-reads only the changed Session for every mounted summary and pending reader', async () => {
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
        let renders = 0;
        function Summary(props: Readonly<{ name: string }>) {
            read[props.name] = { needsYou: useActivityOverviewSummary().needsYouCount };
            renders += 1;
            return null;
        }
        function Pending(props: Readonly<{ name: string; sessionId: string }>) {
            const address = React.useMemo(() => ({ serverId: 'server-a', sessionId: props.sessionId }), [props.sessionId]);
            read[props.name] = { pending: usePendingNavigationOverview(address, true).count };
            renders += 1;
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
            renders = 0;
            await act(async () => storage.setState({
                sessions: { ...sessions, [waiting.id]: waiting },
                sessionListRowsByServerId: { 'server-a': countRows({ ...rows, [waiting.id]: buildSessionListRenderableFromSession(waiting) }) },
                sessionListRenderableDelta: { revision: 101, changedSessionIds: [waiting.id], removedSessionIds: [], rebuiltSessionListIndex: false },
            }));
            expect(read).toEqual({ rail: { needsYou: 2 }, status: { needsYou: 2 }, header: { pending: 2 }, composer: { pending: 1 } });
            // Two reads per shared projection (address owner + classifier) for 4 mounted readers of 1,000 Sessions.
            expect({ rowReads, renders }).toEqual({ rowReads: 4, renders: 3 });

            // A row write that changes nothing either projection shows renders no reader.
            const touched = { ...sessions['scale-43']!, seq: (sessions['scale-43']!.seq ?? 0) + 1 };
            const latestRows = storage.getState().sessionListRowsByServerId['server-a']!;
            rowReads = 0;
            renders = 0;
            await act(async () => storage.setState({
                sessions: { ...storage.getState().sessions, [touched.id]: touched },
                sessionListRowsByServerId: { 'server-a': countRows({ ...latestRows, [touched.id]: buildSessionListRenderableFromSession(touched) }) },
                sessionListRenderableDelta: { revision: 102, changedSessionIds: [touched.id], removedSessionIds: [], rebuiltSessionListIndex: false },
            }));
            expect({ rowReads, renders }).toEqual({ rowReads: 4, renders: 0 });
        } finally {
            Error.stackTraceLimit = previousStackLimit;
        }
    });
});
