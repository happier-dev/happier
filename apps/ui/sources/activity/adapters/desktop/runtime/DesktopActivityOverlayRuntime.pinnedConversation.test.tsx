import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const { renderHook, standardCleanup, createSessionFixture, createPlainSessionByIdResponseFixture, createSessionMessagesFixture } = await import('@/dev/testkit');
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { createHomeHubArtifactHttpBoundary } = await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
const { createEmptyAccountBootstrapHttpResponse } = await import('@/dev/testkit/fixtures/accountBootstrapHttpBoundary');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { registerSessionRealtimeTranscriptConsumer, readMountedSessionRealtimeTranscriptConsumerSessionIds, clearMountedSessionRealtimeTranscriptConsumers } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
const { usePinnedDesktopOverlayConversation } = await import('./usePinnedDesktopOverlayConversation');

afterEach(() => { standardCleanup(); clearMountedSessionRealtimeTranscriptConsumers(); });

describe('notch.N3.F3.pin conversation demand', () => {
    it.each([false, true])('hydrates the pinned Home without disclosing a same-id transcript (pending old Home read: %s)', async pendingOldHomeRead => {
        const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const homes = createHomeGovernanceHarness();
        await homes.reset();
        installHomeGovernanceBoundaries({ ...homes, request: createSessionReadBatchFetchBoundary(homes.request) });
        const pinnedHome = await homes.addHome({ name: 'Pinned', serverUrl: 'https://notch-pinned.test', accountId: 'pinned-account', currentAccount: true });
        const activeHome = await homes.addHome({ name: 'Active', serverUrl: 'https://notch-active.test', accountId: 'active-account', currentAccount: true });
        const environment = await restoreServerAccountForTest({ serverUrl: 'https://notch-active.test', accountId: 'active-account',
            additionalRequestOrigins: ['https://notch-pinned.test'], request: createSessionReadBatchFetchBoundary(homes.request) });
        const sessionId = 'same-id';
        const target = { serverId: pinnedHome, accountId: 'pinned-account', sessionId };
        const reply: Message = { kind: 'agent-text', id: 'same-message-id', localId: null, createdAt: 1, text: 'Home A private reply' };
        storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: activeHome, encryptionMode: 'plain' }) },
            sessionMessages: { [sessionId]: createSessionMessagesFixture({ isLoaded: true, messageIdsOldestFirst: [reply.id], messagesById: { [reply.id]: reply } }) } });
        let settleOldPage = () => {};
        let releaseOldConsumer = () => {};
        let oldRead: Promise<void> | undefined;
        if (pendingOldHomeRead) {
            releaseOldConsumer = registerSessionRealtimeTranscriptConsumer(sessionId, activeHome);
            const heldOldPage = new Promise<void>(resolve => { settleOldPage = resolve; });
            homes.answer(activeHome, `/v1/sessions/${sessionId}/messages`, { body: {
                messages: [{ id: 'late-a', seq: 2, localId: null, messageRole: 'agent', sidechainId: null, createdAt: 2,
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'claude',
                        data: { type: 'message', message: 'Home A late private reply' } }, meta: { source: 'cli' } } } }],
                hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
            }, respondAfter: heldOldPage });
            const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
            oldRead = getSyncSingleton().refreshSessionMessages(sessionId);
            await vi.waitFor(() => expect(homes.requests.filter(request => request.serverId === activeHome && request.path.includes('/messages'))).toHaveLength(1));
        }
        homes.answer(pinnedHome, `/v2/sessions/${sessionId}`, { body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, encryptionMode: 'plain' })) });
        let settlePage!: () => void;
        const heldPage = new Promise<void>(resolve => { settlePage = resolve; });
        homes.answer(pinnedHome, `/v1/sessions/${sessionId}/messages`, { select: () => ({ respondAfter: heldPage,
            body: { messages: [{ id: reply.id, seq: 1, localId: null, messageRole: 'agent', sidechainId: null, createdAt: 1,
                content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'claude',
                    data: { type: 'message', message: 'Home B own reply' } }, meta: { source: 'cli' } } } }],
                hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } }) });
        const seen: Array<string | null> = [];
        const hook = await renderHook(() => {
            const value = usePinnedDesktopOverlayConversation({ target, hidden: false, reachable: true });
            seen.push(value.reply.text);
            return value;
        });
        try {
            expect(hook.getCurrent()).toMatchObject({ reply: { state: 'loading', text: null } });
            await vi.waitFor(() => expect(storage.getState().sessions[sessionId]?.serverId).toBe(pinnedHome));
            await React.act(async () => { settleOldPage(); await oldRead; });
            expect(seen).not.toContain('Home A private reply');
            expect(seen).not.toContain('Home A late private reply');
            expect(hook.getCurrent().reply.text).toBeNull();
            await vi.waitFor(() => expect(homes.requests.filter(request => request.serverId === pinnedHome && request.path.includes('/messages'))).toHaveLength(1));
            await React.act(async () => { settlePage(); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ reply: { state: 'ready', text: 'Home B own reply' }, refreshing: false }));
            expect(seen).not.toContain('Home A private reply');
            expect(seen).not.toContain('Home A late private reply');
            expect(homes.requests.filter(request => request.serverId === pinnedHome && request.path.includes('/messages'))).toHaveLength(1);
        } finally { settleOldPage(); settlePage(); releaseOldConsumer(); await oldRead; await hook.unmount(); await environment.dispose(); await homes.reset(); }
    });

    it('loads one cold page, publishes only pinned reply changes, and releases on retarget and unmount', async () => {
        const requests: string[] = [];
        let settlePage: ((response: Response) => void) | undefined;
        const heldPage = new Promise<Response>(resolve => { settlePage = resolve; });
        const boundary = createHomeHubArtifactHttpBoundary('notch-account');
        const environment = await restoreServerAccountForTest({ serverUrl: 'http://notch-conversation.test', accountId: 'notch-account',
            request: createSessionReadBatchFetchBoundary(async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path.endsWith('/messages')) { requests.push(path); return heldPage; }
                const bootstrap = createEmptyAccountBootstrapHttpResponse(path);
                if (bootstrap) return bootstrap;
                const match = /^\/v2\/sessions\/([^/]+)$/.exec(path);
                if (match) return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
                    id: match[1], encryptionMode: 'plain', metadata: { path: '/repo', host: 'test' },
                })));
                return boundary.request(input, init);
            }),
        });
        const target = { serverId: environment.home.id, accountId: 'notch-account', sessionId: 'bot-a' };
        storage.setState({ sessions: Object.fromEntries(['bot-a', 'bot-b', 'other'].map(id => [id,
            createSessionFixture({ id, serverId: target.serverId, encryptionMode: 'plain' })])), sessionMessages: {
            'bot-b': createSessionMessagesFixture({ isLoaded: true }),
        } });
        const slices: unknown[] = [];
        const renderedReplyStates: string[] = [];
        const hook = await renderHook((props: { target: typeof target; hidden: boolean; reachable: boolean }) => {
            const slice = usePinnedDesktopOverlayConversation(props);
            renderedReplyStates.push(slice.reply.state);
            React.useEffect(() => { slices.push(slice); }, [slice]);
            return slice;
        }, { initialProps: { target, hidden: false, reachable: true } });
        try {
            expect(renderedReplyStates[0]).toBe('loading');
            await vi.waitFor(() => expect(requests).toHaveLength(1));
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(target.serverId)).toEqual(['bot-a']);
            expect(hook.getCurrent()).toMatchObject({ ...target, reply: { state: 'loading', text: null }, refreshing: true });
            await React.act(async () => { settlePage!(Response.json({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ reply: { state: 'none', text: null }, refreshing: false }));
            const settledCount = slices.length;
            for (let index = 0; index < 50; index++) await React.act(async () => {
                storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
                    other: createSessionMessagesFixture({ isLoaded: true, messagesVersion: index + 1 }),
                } }));
            });
            expect(slices).toHaveLength(settledCount);
            const reply: Message = { kind: 'agent-text', id: 'reply', localId: null, createdAt: 1, text: 'The reply' };
            await React.act(async () => { storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
                'bot-a': createSessionMessagesFixture({ isLoaded: true, messageIdsOldestFirst: ['reply'], messagesById: { reply } }),
            } })); });
            expect(hook.getCurrent()).toMatchObject({ reply: { state: 'ready', text: 'The reply' } });
            expect(slices).toHaveLength(settledCount + 1);
            await hook.rerender({ target, hidden: true, reachable: true });
            expect(hook.getCurrent()).toMatchObject({ reply: { state: 'hidden', text: null } });
            await hook.rerender({ target: { ...target, sessionId: 'bot-b' }, hidden: false, reachable: true });
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(target.serverId)).toEqual(['bot-b']);
            expect(requests).toHaveLength(1);
            await hook.unmount();
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(target.serverId)).toEqual([]);
        } finally { await hook.unmount(); await environment.dispose(); }
    });
});
