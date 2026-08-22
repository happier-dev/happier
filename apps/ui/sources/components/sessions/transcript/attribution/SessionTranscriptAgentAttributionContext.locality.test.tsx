import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { createAgentTransitionDividerMessageFixture, createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';
import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    SessionTranscriptAgentAttributionProvider,
    useHistoricalTranscriptAgentId,
    useSessionTranscriptAgentAttributionIndexForMessages,
} from './SessionTranscriptAgentAttributionContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function messagesById(messages: readonly Message[]): Readonly<Record<string, Message>> {
    return Object.fromEntries(messages.map((message) => [message.id, message]));
}

describe('SessionTranscriptAgentAttributionContext locality', () => {
    it('does not republish historical attribution for streamed non-divider updates, but does for changed divider boundaries', async () => {
        const fixture = createMixedAgentTranscriptFixture();
        const initialMessagesById = messagesById(fixture.messages);
        const observedHistoricalAgentIds: Array<string | null> = [];
        let historicalConsumerRenderCount = 0;

        const HistoricalConsumer = React.memo(() => {
            historicalConsumerRenderCount += 1;
            observedHistoricalAgentIds.push(useHistoricalTranscriptAgentId(30));
            return null;
        });

        function Harness(props: Readonly<{ messagesById: Readonly<Record<string, Message>> }>) {
            const index = useSessionTranscriptAgentAttributionIndexForMessages(props.messagesById);
            return (
                <SessionTranscriptAgentAttributionProvider value={index}>
                    <HistoricalConsumer />
                </SessionTranscriptAgentAttributionProvider>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Harness messagesById={initialMessagesById} />);
        });
        expect(historicalConsumerRenderCount).toBe(1);
        expect(observedHistoricalAgentIds).toEqual(['codex']);

        const streamedMessagesById = {
            ...initialMessagesById,
            'msg-30': { ...initialMessagesById['msg-30']!, text: 'streamed follow-up' },
        } as Readonly<Record<string, Message>>;
        await act(async () => {
            tree.update(<Harness messagesById={streamedMessagesById} />);
        });
        expect(historicalConsumerRenderCount).toBe(1);

        const changedDivider = createAgentTransitionDividerMessageFixture({
            fromAgentId: 'claude',
            toAgentId: 'gemini',
            id: 'msg-15',
            seq: 15,
            createdAt: 1_500,
        });
        const changedBoundaryMessagesById = {
            ...streamedMessagesById,
            [changedDivider.id]: changedDivider,
        } as Readonly<Record<string, Message>>;
        await act(async () => {
            tree.update(<Harness messagesById={changedBoundaryMessagesById} />);
        });
        expect(historicalConsumerRenderCount).toBe(2);
        expect(observedHistoricalAgentIds).toEqual(['codex', 'gemini']);

        const { 'msg-15': _removedDivider, ...withoutDividerMessagesById } = changedBoundaryMessagesById;
        await act(async () => {
            tree.update(<Harness messagesById={withoutDividerMessagesById} />);
        });
        expect(historicalConsumerRenderCount).toBe(3);
        expect(observedHistoricalAgentIds).toEqual(['codex', 'gemini', null]);

        await act(async () => {
            tree.update(<Harness messagesById={changedBoundaryMessagesById} />);
        });
        expect(historicalConsumerRenderCount).toBe(4);
        expect(observedHistoricalAgentIds).toEqual(['codex', 'gemini', null, 'gemini']);

        await act(async () => {
            tree.unmount();
        });
    });
});
