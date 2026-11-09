import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionMessagesFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { useResolvedSessionMessageRouteId, useSessionMessageRouteId } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from '@happier-dev/session-core/messages';

afterEach(standardCleanup);

describe('Session message route subscriptions', () => {
    it('keeps both route consumers quiet across unrelated arrivals and publishes real mapping changes', async () => {
        const previous = storage.getState();
        const sessionId = 's-route-locality';
        const resolvedCounts = createRenderCommitCounter();
        const builtCounts = createRenderCommitCounter();
        const target: Message = { id: 'target', kind: 'agent-text', localId: null, createdAt: 1, text: 'target' };
        const transcript = createSessionMessagesFixture({
            messageIdsOldestFirst: [target.id], messagesById: { [target.id]: target }, isLoaded: true,
        });
        transcript.reducerState.messageIds.set('original', target.id);
        storage.setState({ sessionMessages: { ...previous.sessionMessages, [sessionId]: transcript } });
        const resolved = await renderHook(() => {
            useRenderCommitCounter(resolvedCounts);
            return useResolvedSessionMessageRouteId(sessionId, 'server:original');
        });
        const built = await renderHook(() => {
            useRenderCommitCounter(builtCounts);
            return useSessionMessageRouteId(sessionId, target.id);
        });
        try {
            expect(resolved.getCurrent()).toBe(target.id);
            expect(built.getCurrent()).toBe('server:original');
            resolvedCounts.reset(); builtCounts.reset();
            for (let index = 0; index < 100; index += 1) {
                await act(async () => {
                    const session = storage.getState().sessionMessages[sessionId];
                    const message: Message = { id: `unrelated-${index}`, kind: 'agent-text',
                        localId: null, createdAt: index + 2, text: 'unrelated arrival' };
                    const messagesById = { ...session.messagesById, [message.id]: message };
                    storage.setState({ sessionMessages: { ...storage.getState().sessionMessages,
                        [sessionId]: { ...session, messageIdsOldestFirst: [...session.messageIdsOldestFirst, message.id],
                            messagesById, messagesMap: messagesById, messagesVersion: session.messagesVersion + 1 },
                    } });
                });
            }
            expect({ resolved: resolvedCounts.read(), built: builtCounts.read() }).toEqual({
                resolved: { renders: 0, commits: 0 }, built: { renders: 0, commits: 0 },
            });

            // Reducer maps can change in place; retain the real store notification
            // while checking the new mapping, rather than comparing map identity.
            await act(async () => {
                const session = storage.getState().sessionMessages[sessionId];
                session.reducerState.messageIds.set('original', 'replacement');
                session.reducerState.messageIds.set('new-original', target.id);
                storage.setState({ sessionMessages: { ...storage.getState().sessionMessages,
                    [sessionId]: { ...session, messagesVersion: session.messagesVersion + 1 },
                } });
            });
            expect(resolved.getCurrent()).toBe('replacement');
            expect(built.getCurrent()).toBe('server:new-original');
            expect({ resolved: resolvedCounts.read(), built: builtCounts.read() }).toEqual({
                resolved: { renders: 1, commits: 1 }, built: { renders: 1, commits: 1 },
            });
        } finally {
            await resolved.unmount(); await built.unmount();
            storage.setState(previous);
        }
    });

    it('resolves late hydration and follows route and Session changes without retaining stale ids', async () => {
        const previous = storage.getState();
        const message: Message = { id: 'late-message', kind: 'agent-text', localId: null,
            createdAt: 1, text: 'hydrated', realID: 'late-original' };
        const first = createSessionMessagesFixture({
            messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, isLoaded: true,
        });
        storage.setState({ sessionMessages: {} });
        let selectedSession = 's-late-route';
        let selectedRoute = 'server:late-original';
        const hook = await renderHook(() => useResolvedSessionMessageRouteId(selectedSession, selectedRoute));
        try {
            expect(hook.getCurrent()).toBeNull();
            await act(async () => {
                storage.setState({ sessionMessages: { [selectedSession]: first } });
            });
            // Assistant blocks can carry their stable server identity outside the
            // reducer's processed-message map. Exercise the canonical fallback.
            expect(hook.getCurrent()).toBe(message.id);
            selectedRoute = '';
            await hook.rerender();
            expect(hook.getCurrent()).toBeNull();
            selectedRoute = 'server:late-original';
            selectedSession = 's-other-route';
            await hook.rerender();
            expect(hook.getCurrent()).toBeNull();
            await act(async () => {
                storage.setState({ sessionMessages: { [selectedSession]: first } });
            });
            expect(hook.getCurrent()).toBe(message.id);
            await act(async () => { storage.setState({ sessionMessages: {} }); });
            expect(hook.getCurrent()).toBeNull();
        } finally {
            await hook.unmount();
            storage.setState(previous);
        }
    });
});
