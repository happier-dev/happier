import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, createToolCallMessageFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useSessionsHaveAttention } from '@/hooks/session/useSessionsHaveAttention';
import type { ActivityOverviewSnapshot } from '@/activity/attention/activityAttentionTypes';
import { useActivityOverview } from './useActivityOverview';
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

    it('retires an idle pre-viewer action request from the navigation dot when its budget elapses', async () => {
        const dot = await renderNavigationDot();
        expect(dot.read()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(dot.read()).toBe(false);
    });

    it('retires the same request from the full Inbox attention projection without any store change', async () => {
        const overview = await renderOverview();
        expect(overview.hasAttention()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(overview.hasAttention()).toBe(false);
    });

    it('retires pre-viewer permission attention at the same canonical freshness boundary', async () => {
        seedLegacySession('permission');
        const dot = await renderNavigationDot();
        expect(dot.read()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(dot.read()).toBe(false);
    });

    it('keeps an action request while the turn is still projected in progress', async () => {
        seedLegacySession('working_user_action');
        const dot = await renderNavigationDot();
        expect(dot.read()).toBe(true);
        await crossTheFreshnessBoundary();
        expect(dot.read()).toBe(true);
    });

    it('uses the same message-backed pending request for the overview and its exact clock boundary', async () => {
        seedLegacySession('message_user_action');
        const dot = await renderNavigationDot();
        expect(transcriptReads).toBe(0);
        const overview = await renderOverview();
        expect(overview.hasAttention()).toBe(true);
        expect(dot.read()).toBe(true);
        // The real row projector carries the transcript's request into the message-free summary.
        await act(async () => { await vi.advanceTimersByTimeAsync(STALE_SIGNAL_MS - 1_000); });
        expect(overview.hasAttention()).toBe(false);
        expect(dot.read()).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(overview.hasAttention()).toBe(false);
        expect(dot.read()).toBe(false);
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
});
