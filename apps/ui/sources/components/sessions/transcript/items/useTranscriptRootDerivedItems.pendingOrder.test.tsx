import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useTranscriptRootDerivedItems } = await import('./useTranscriptRootDerivedItems');

describe('main transcript Pending ordering', () => {
    it.each(['linear', 'turns'] as const)('docks retry custody with the queue in one tail section through the real %s derivation', async (groupingMode) => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'user', localId: 'retry-local', createdAt: 1, seq: 1, text: 'Please start' },
            { kind: 'agent-text', id: 'failure', localId: null, createdAt: 2, seq: 2, text: 'Agent could not start' },
        ];
        const blocked: PendingMessage = { id: 'retry', localId: 'retry-local', createdAt: 1, updatedAt: 2,
            text: 'Please start', rawRecord: {}, source: 'server_pending', pendingDeliveryStatus: 'blocked' };
        const queued: PendingMessage = { id: 'next', localId: 'next-local', createdAt: 3, updatedAt: 3,
            text: 'Next question', rawRecord: {}, source: 'server_pending', pendingDeliveryStatus: 'server_queued' };
        const params: Parameters<typeof useTranscriptRootDerivedItems>[0] = {
            sessionId: `pending-order-${groupingMode}`, groupingMode, messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
            pendingMessages: [blocked, queued], discardedPendingMessages: [], pendingUserActionRequests: [],
            fork: null, forkAwareMessageDescriptors: null, forkedTranscriptEnabled: false,
            groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools', sessionTurns: null, triggerRuns: [],
            externalSessionOperationPresentation: null, externalSessionOperationProgress: null, externalSessionOperationDismissal: null,
            pluginTranscriptActivities: [], dismissedPluginTranscriptActivityIds: new Set(), isPluginTranscriptActivityActionAvailable: () => true,
        };
        const hook = await renderHook((input: typeof params) => useTranscriptRootDerivedItems(input), { initialProps: params });
        const items = hook.getCurrent().groupedItems;
        expect(items.map((item) => item.kind)).toEqual([groupingMode === 'turns' ? 'turn' : 'message', 'pending-queue']);
        expect(items[0]).toMatchObject(groupingMode === 'turns'
            ? { turn: { userMessageId: null, content: [{ kind: 'message', messageId: 'failure' }] } }
            : { messageId: 'failure' });
        expect(items[1]).toMatchObject({ kind: 'pending-queue', pendingMessages: [blocked, queued] });

        await hook.rerender({ ...params, pendingMessages: [{ ...blocked, pendingDeliveryStatus: 'server_delivering' }, queued] });
        const delivering = hook.getCurrent().groupedItems;
        expect(delivering[0]).toMatchObject(groupingMode === 'turns' ? { kind: 'turn', turn: { userMessageId: 'user' } } : { kind: 'message', messageId: 'user' });
        expect(delivering.filter((item) => item.kind === 'pending-queue')).toMatchObject([{ pendingMessages: [queued] }]);
        await hook.unmount();
    });
});
