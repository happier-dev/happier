import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { useInboxReadySessionResult } from './useInboxReadySessionResult';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')
).createSessionOpsSocketIoClientBoundary(importOriginal));
// Native Markdown is a third-party boundary; this reader renders no Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));

const h = await createConcurrentCacheNetworkHarness('inbox-result');
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(() => h.dispose());

describe('useInboxReadySessionResult exact transcript demand', () => {
    it.each(['completed', 'in_progress'] as const)('hydrates exact %s output through consumption ACK and follows completion without scanning Sessions', async initialStatus => {
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const { readMountedSessionRealtimeTranscriptConsumerSessionIds } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const sessionId = `linked-${initialStatus}-session`;
        let projection = buildSessionTurnsProjectionV1({ sessionId, updatedAt: 5, latestTurnId: 'completed-turn', turns: [
            { turnId: 'completed-turn', initiator: 'user', status: initialStatus, startedAt: 1, updatedAt: 5,
                ...(initialStatus === 'completed' ? { terminalAt: 5 } : {}), transcriptAnchors: { finalAssistantMessageSeq: 4 } },
        ] });
        const row = { ...h.session({ id: sessionId, seq: 4, updatedAt: 5 }),
            latestTurnId: 'completed-turn', latestTurnStatus: initialStatus,
            latestTurnStatusObservedAt: 5 } satisfies ReturnType<typeof h.session>;
        h.setSessions(h.homeB, [row, h.session({ id: 'unrelated-session' })]);
        const message = (text: string, updatedAt: number) => ({ id: 'final-answer', seq: 4, localId: null,
            createdAt: 4, updatedAt, content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'output', data: {
                type: 'assistant', uuid: 'final-answer', parentUuid: null, isSidechain: false,
                message: { role: 'assistant', content: [{ type: 'text', text }] },
            } } } } });
        h.setResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === `/v1/sessions/${sessionId}/turns`) return Response.json(projection);
            if (path === `/v1/sessions/${sessionId}/messages`) return Response.json({ messages: [message('Finding', 4)], hasMore: false });
            if (path.endsWith('/pending')) return Response.json({ pending: [], pendingVersion: 0 });
            return null;
        });
        await h.startFocused();
        await getSyncSingleton().refreshSessions();
        await h.start(); await h.ready();
        expect(h.storage.getState().sessionMessages[sessionId]).toBeUndefined();
        const inventories = () => h.httpRequests.filter(({ url }) => ['/v2/sessions', '/v2/sessions/active',
            '/v2/sessions/attention', '/v2/sessions/query'].includes(url.pathname)).length;
        const inventoryBefore = inventories();
        const messagesBefore = h.httpRequests.filter(({ url }) => url.pathname.endsWith('/messages')).length;
        const address = { serverId: h.homeB.id, sessionId };
        const hook = await renderHook(({ hydrateTranscript, active }: { hydrateTranscript: boolean; active: boolean }) => {
            const session = h.storage(state => state.sessions[sessionId], { sessions: [sessionId] });
            const candidate = session ? buildSessionActivityAttention({ session, nowMs: 10 }) : null;
            return useInboxReadySessionResult(candidate, { transcriptAddress: hydrateTranscript ? address : null,
                active, selection: 'latestTurn' });
        },
        { initialProps: { hydrateTranscript: false, active: true } });
        try {
            expect(hook.getCurrent().preview.state).toBe('unavailable');
            expect(h.httpRequests.filter(({ url }) => url.pathname.endsWith('/messages'))).toHaveLength(messagesBefore);
            await hook.rerender({ hydrateTranscript: true, active: true });
            await vi.waitFor(() => expect(h.storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true));
            if (initialStatus === 'in_progress') {
                expect(hook.getCurrent().preview.state).toBe('unavailable');
                projection = buildSessionTurnsProjectionV1({ ...projection, updatedAt: 7,
                    turns: projection.turns.map(turn => ({ ...turn, status: 'completed', terminalAt: 7, updatedAt: 7 })) });
                h.setSessions(h.homeB, [{ ...row, updatedAt: 7, latestTurnStatus: 'completed', latestTurnStatusObservedAt: 7 }]);
                await act(async () => {
                    h.socket().trigger('update', { id: 'turn-completed', seq: 7, createdAt: 7,
                        body: { t: 'update-session', id: sessionId, latestTurnId: 'completed-turn',
                            latestTurnStatus: 'completed', latestTurnStatusObservedAt: 7 } });
                });
            }
            await vi.waitFor(() => expect(hook.getCurrent().preview).toEqual({ state: 'available', text: 'Finding' }));
            expect(inventories()).toBe(inventoryBefore);
            const messageReads = h.httpRequests.filter(({ url }) => url.pathname.endsWith('/messages')).slice(messagesBefore);
            expect(messageReads.length).toBeGreaterThan(0);
            expect(messageReads.every(({ url }) => url.pathname === `/v1/sessions/${sessionId}/messages`)).toBe(true);
            const readsBeforePush = h.httpRequests.length;
            await act(async () => {
                h.socket().trigger('update', { id: 'final-answer-revision', seq: 8, createdAt: 8,
                    body: { t: 'message-updated', sid: sessionId, delivery: 'full', message: message('Updated finding', 8) } });
            });
            await vi.waitFor(() => expect(hook.getCurrent().preview).toEqual({ state: 'available', text: 'Updated finding' }));
            expect(h.httpRequests).toHaveLength(readsBeforePush);
            await hook.rerender({ hydrateTranscript: true, active: false });
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(h.homeB.id)).not.toContain(sessionId);
            expect(hook.getCurrent().preview.state).toBe('unavailable');
        } finally { await hook.unmount(); }
    });
});
