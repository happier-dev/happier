import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

const navigation = vi.hoisted(() => ({ routes: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: (route) => navigation.routes.push(route) } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { getStorage } = await import('@/sync/domains/state/storage');
const { buildSessionMessagesPath } = await import('@happier-dev/protocol');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
const { invokeNextPendingRequest, markSessionPendingAnswer, useSessionPendingAnswerToken } = await import('@/activity/source/pendingNavigationRuntime');
const { NextPendingNavigationHost } = await import('./NextPendingNavigationHost');
const initialState = getStorage().getState();
beforeEach(() => {
    // The real keyboard owner leaves the process only at the browser event target.
    vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    getStorage().setState(initialState, true);
    await homes.reset();
    navigation.routes = [];
});

describe('mounted app-shell Next navigation', () => {
    it('navigates a real pending request through the mounted runtime and keyboard seam, and retires on unmount', async () => {
        const serverId = await homes.addHome({ name: 'Next Home', serverUrl: 'https://next-home.test', accountId: 'next-owner' });
        const session = createSessionFixture({ id: 'needs-answer', serverId, active: true, activeAt: Date.now(), updatedAt: Date.now(),
            pendingRequestObservedAt: Date.now(),
            agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: Date.now() - 10 } } } });
        homes.answer(serverId, '/v2/sessions/needs-answer', { body: { session: {
            id: session.id, createdAt: 1, updatedAt: Date.now(), seq: 5,
            active: true, activeAt: Date.now(), encryptionMode: 'plain', dataEncryptionKey: null,
            metadataLayoutVersion: 0, metadataVersion: 1, metadata: JSON.stringify({ name: 'Needs an answer' }),
            agentStateVersion: 1, agentState: JSON.stringify(session.agentState), share: null,
        } } });
        homes.answer(serverId, buildSessionMessagesPath({ sessionId: session.id, scope: 'all' }), {
            body: { messages: [], hasMore: false, nextBeforeSeq: null },
        });
        getStorage().setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'next-owner' },
            sessions: { [session.id]: session },
            sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
            ordinarySessionListMembershipByServerId: { [serverId]: [session.id] },
        });
        let invokeCommand: ReturnType<typeof useKeyboardCommand> = () => false;
        let answerToken: number | null = null;
        function KeyboardProbe() {
            invokeCommand = useKeyboardCommand();
            return null;
        }
        function AnswerProbe({ address }: { address: SessionAddress | null }) {
            answerToken = useSessionPendingAnswerToken(address);
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}>
            <NextPendingNavigationHost /><KeyboardProbe /><AnswerProbe address={null} />
        </KeyboardShortcutProvider>);
        expect(homes.requestsFor('/v2/sessions/needs-answer')).toHaveLength(0);
        let result: Awaited<ReturnType<typeof invokeNextPendingRequest>> = { status: 'unavailable' };
        await act(async () => { result = await invokeNextPendingRequest(); });
        expect(result, `HTTP paths: ${homes.requests.map(request => request.path).join(', ')}`).toEqual({ status: 'opened' });
        expect(navigation.routes.at(-1)).toEqual(expect.stringContaining('/session/needs-answer'));
        await act(async () => {
            expect(invokeCommand('session.pending.next')).toBe(true);
            await waitForHomeGovernance(() => expect(navigation.routes).toHaveLength(2));
        });
        await expect(invokeNextPendingRequest({ expectedServerId: 'another-home' })).resolves.toEqual({ status: 'unavailable' });
        const cancel = new AbortController();
        cancel.abort();
        await expect(invokeNextPendingRequest({ signal: cancel.signal })).resolves.toEqual({ status: 'unavailable' });
        let otherHome = '';
        await act(async () => {
            otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-next-home.test', accountId: 'other-owner' });
        });
        const otherAddress = { serverId: otherHome, sessionId: 'answered-in-other-home' };
        await screen.update(<KeyboardShortcutProvider handlers={{}}>
            <NextPendingNavigationHost /><KeyboardProbe /><AnswerProbe address={otherAddress} />
        </KeyboardShortcutProvider>);
        await act(async () => { markSessionPendingAnswer(otherAddress, 'other-question'); });
        const retainedAnswerToken = answerToken;
        expect(retainedAnswerToken).toEqual(expect.any(Number));
        await act(async () => { await homes.switchAccount(serverId, 'replacement-owner'); });
        expect(answerToken).toBe(retainedAnswerToken);
        await act(async () => { screen.tree.unmount(); });
        await expect(invokeNextPendingRequest()).resolves.toEqual({ status: 'unavailable' });
    });

    it('distinguishes a mounted empty source from an unavailable client', async () => {
        const serverId = await homes.addHome({ name: 'Empty Home', serverUrl: 'https://empty-next-home.test', accountId: 'next-owner' });
        getStorage().setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'next-owner' },
            sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
        });
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><NextPendingNavigationHost /></KeyboardShortcutProvider>);
        await expect(invokeNextPendingRequest()).resolves.toEqual({ status: 'none' });
        expect(navigation.routes).toHaveLength(0);
    });
});
