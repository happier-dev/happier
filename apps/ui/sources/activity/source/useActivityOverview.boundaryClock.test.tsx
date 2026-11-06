import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, createToolCallMessageFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useSessionsHaveAttention } from '@/hooks/session/useSessionsHaveAttention';
import type { ActivityOverviewSnapshot } from '@/activity/attention/activityAttentionTypes';
import { useActivityOverview, useActivityOverviewSummary } from './useActivityOverview';
import { buildPendingNavigationFromSource } from './buildPendingNavigationFromSource';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';

// React Native is the platform boundary; the store, selectors and attention owners stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const STALE_SIGNAL_MS = 120_000;
const NOW_MS = 1_700_000_000_000;
const initialState = storage.getState();
let transcriptReads = 0;
type FixtureKind = 'idle_user_action' | 'message_user_action' | 'completed_message_user_action' | 'permission' | 'working_user_action';

function seedLegacySession(kind: FixtureKind = 'idle_user_action') {
    const createdAt = NOW_MS - 1_000;
    const request = {
        tool: kind === 'permission' ? 'Bash' : 'AskUserQuestion',
        kind: kind === 'permission' ? 'permission' as const : 'user_action' as const,
        arguments: {}, createdAt,
    };
    const session = createSessionFixture({
        id: 'legacy-session', serverId: 'server-a', viewer: undefined,
        active: true, presence: 'online', createdAt, updatedAt: createdAt, activeAt: createdAt,
        lastViewedSessionSeq: 1,
        latestTurnStatus: kind === 'working_user_action' ? 'in_progress' : undefined,
        latestTurnStatusObservedAt: kind === 'working_user_action' ? createdAt : undefined,
        agentState: { requests: kind === 'message_user_action' ? {} : { ask_1: request }, completedRequests: {} },
    });
    const completed = kind === 'completed_message_user_action';
    const messages = kind === 'message_user_action' || completed ? [createToolCallMessageFixture({
        id: 'message-ask-1', createdAt,
        tool: {
            id: 'ask_1', name: 'AskUserQuestion', state: completed ? 'completed' : 'running', input: {},
            createdAt, startedAt: createdAt, completedAt: completed ? createdAt + 1 : null, description: null,
            permission: { id: 'ask_1', kind: 'user_action', status: completed ? 'approved' : 'pending' },
        },
    })] : [];
    const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    const hydratedMessages = createSessionMessagesFixture({
        messagesById, messageIdsOldestFirst: messages.map((message) => message.id), messagesVersion: 1, isLoaded: true,
    });
    const messageStates = { [session.id]: hydratedMessages };
    // Instrument the real state's field access; do not replace any internal reader or decision.
    transcriptReads = 0;
    Object.defineProperty(messageStates, session.id, { enumerable: true, get: () => {
        transcriptReads += 1;
        return hydratedMessages;
    } });
    storage.setState({
        isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { 'server-a': {
            [session.id]: buildSessionListRenderableFromSession(session, undefined, messages),
        } },
        ordinarySessionListMembershipByServerId: { 'server-a': [session.id] },
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
        sessionMessages: messageStates,
    });
}

async function crossTheFreshnessBoundary() {
    await act(async () => { await vi.advanceTimersByTimeAsync(STALE_SIGNAL_MS + 1_000); });
}

async function renderNavigationDot() {
    let latest: boolean | null = null;
    function Probe() {
        latest = useSessionsHaveAttention();
        return null;
    }
    await renderScreen(<Probe />);
    return { read: () => latest };
}

async function renderOverview() {
    let latest: ActivityOverviewSnapshot | null = null;
    function Probe() {
        latest = useActivityOverview().overview;
        return null;
    }
    await renderScreen(<Probe />);
    return { hasAttention: () => latest?.candidates.some((candidate) => candidate.hasAttention) ?? false };
}

describe('mounted Activity overview boundary clock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        seedLegacySession();
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
        vi.useRealTimers();
    });

    it('keeps an idle pre-viewer action request on the navigation dot while its runtime is live, however long it waits', async () => {
        const dot = await renderNavigationDot();
        expect(dot.read()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(dot.read()).toBe(true);
    });

    it('keeps the same request in the full Inbox attention projection while its runtime is live', async () => {
        const overview = await renderOverview();
        expect(overview.hasAttention()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(overview.hasAttention()).toBe(true);
    });

    it('keeps pre-viewer permission attention while its runtime is live, however long it waits', async () => {
        seedLegacySession('permission');
        const dot = await renderNavigationDot();
        expect(dot.read()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(dot.read()).toBe(true);
    });

    it('keeps an action request while the turn is still projected in progress', async () => {
        seedLegacySession('working_user_action');
        const dot = await renderNavigationDot();
        expect(dot.read()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(dot.read()).toBe(true);
    });

    it('uses the same message-backed pending request for the overview and the navigation dot, with no expiry clock', async () => {
        seedLegacySession('message_user_action');
        const dot = await renderNavigationDot();
        expect(transcriptReads).toBe(0);
        const overview = await renderOverview();
        expect(overview.hasAttention()).toBe(true);
        expect(dot.read()).toBe(true);
        // The real row projector carries the transcript's request into the message-free summary.
        await crossTheFreshnessBoundary();
        expect(overview.hasAttention()).toBe(true);
        expect(dot.read()).toBe(true);
    });

    it('counts a matching hydrated message-backed row without scanning its transcript', () => {
        seedLegacySession('message_user_action');
        const state = storage.getState();
        const source: ActivityAttentionSource = {
            isDataReady: state.isDataReady, sessionsById: state.sessions,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        };
        expect(buildPendingNavigationFromSource({ source, nowMs: NOW_MS }).map((candidate) => candidate.address))
            .toEqual([{ serverId: 'server-a', sessionId: 'legacy-session' }]);
        expect(transcriptReads).toBe(0);
    });

    it('lets a completed transcript request defeat a stale pending agent-state copy before scheduling', async () => {
        seedLegacySession('completed_message_user_action');
        const overview = await renderOverview();
        const dot = await renderNavigationDot();
        expect(overview.hasAttention()).toBe(false);
        expect(dot.read()).toBe(false);
        await crossTheFreshnessBoundary();
        expect(overview.hasAttention()).toBe(false);
        expect(dot.read()).toBe(false);
    });
    it('renders a summary consumer only when the summary changes, not for every Session row write', async () => {
        let renders = 0;
        // Written by the probe's render; a mutable holder keeps TypeScript from narrowing it to its initial null.
        const probe: { latest: ReturnType<typeof useActivityOverviewSummary> | null } = { latest: null };
        function SummaryProbe() {
            renders += 1;
            probe.latest = useActivityOverviewSummary();
            return null;
        }
        await renderScreen(<SummaryProbe />);
        const baseline = probe.latest;
        expect(baseline?.totalAttentionCount).toBe(1);
        const rowWrite = (patch: Partial<ReturnType<typeof createSessionFixture>>) => {
            const state = storage.getState();
            const session = { ...state.sessions['legacy-session']!, ...patch };
            storage.setState({
                sessions: { ...state.sessions, [session.id]: session },
                sessionListRowsByServerId: { 'server-a': {
                    [session.id]: buildSessionListRenderableFromSession(session, state.sessionListRowsByServerId['server-a']?.[session.id]),
                } },
            });
        };
        const before = renders;
        // A row write that moves no summary fact (the Session list churns like this constantly).
        await act(async () => { rowWrite({ metadata: { ...storage.getState().sessions['legacy-session']!.metadata!, name: 'Unrelated rename 1' } }); });
        await act(async () => { rowWrite({ metadata: { ...storage.getState().sessions['legacy-session']!.metadata!, name: 'Unrelated rename 2' } }); });
        expect(renders).toBe(before);
        expect(probe.latest).toBe(baseline);
        // A write that does move a fact renders it once.
        await act(async () => { rowWrite({ agentState: { requests: {}, completedRequests: {} } }); });
        expect(renders).toBe(before + 1);
        expect(probe.latest?.totalAttentionCount).toBe(0);
    });

});
