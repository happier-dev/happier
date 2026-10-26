import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'android' as 'ios' | 'android' | 'web',
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) => values?.[platformState.os] ?? values?.default,
            },
        });
    },
    storage: async (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));

type NativeContextMenuItem = Readonly<{
    text: string;
    onPress: (event: Readonly<{ text: string; selection: Readonly<{ start: number; end: number }> }>) => void;
}>;

const userMessage = { kind: 'user-text', localId: 'local-1', id: 'u1', text: 'Use the request cache' } as unknown as Message;
const agentMessage = { kind: 'agent-text', localId: null, id: 'a1', createdAt: 1, text: 'The cache key is wrong.', isThinking: false } as unknown as Message;
const thinkingMessage = { kind: 'agent-text', localId: null, id: 't1', createdAt: 1, text: 'Considering options.', isThinking: true } as unknown as Message;

async function renderMessages(
    messages: readonly Message[],
    onQuote: ((text: string) => void) | null,
    rowProps: Readonly<{ historical?: boolean; metadata?: Metadata | null }> = {},
) {
    vi.resetModules();
    const { MessageView } = await import('./MessageView');
    const { TranscriptQuoteProvider } = await import('./quote/TranscriptQuoteContext');
    return await renderScreen(
        <TranscriptQuoteProvider value={onQuote}>
            {messages.map((message) => (
                <MessageView
                    key={message.id}
                    message={message}
                    metadata={rowProps.metadata ?? null}
                    sessionId="s1"
                    historical={rowProps.historical}
                />
            ))}
        </TranscriptQuoteProvider>,
    );
}

function contextMenuItemsOf(node: { props: Record<string, unknown> }): readonly NativeContextMenuItem[] | undefined {
    return node.props.contextMenuItems as readonly NativeContextMenuItem[] | undefined;
}

describe('MessageView (transcript quote)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('offers Quote in the native selection menu of user and assistant prose and hands over the selected text', async () => {
        platformState.os = 'android';
        const onQuote = vi.fn();
        const screen = await renderMessages([userMessage, agentMessage], onQuote);

        const runs = screen.findAllByType('EnrichedMarkdownText');
        expect(runs).toHaveLength(2);
        for (const run of runs) {
            expect(contextMenuItemsOf(run)?.map((item) => item.text)).toEqual(['transcript.quote.action']);
        }

        await act(async () => {
            contextMenuItemsOf(runs[1]!)![0]!.onPress({ text: 'cache key', selection: { start: 4, end: 13 } });
        });
        expect(onQuote).toHaveBeenCalledWith('cache key');
    });

    it('offers no Quote while the composer cannot take one, and never on thinking', async () => {
        platformState.os = 'android';
        const withoutComposer = await renderMessages([userMessage, agentMessage], null);
        for (const run of withoutComposer.findAllByType('EnrichedMarkdownText')) {
            expect(contextMenuItemsOf(run)).toBeUndefined();
        }
        standardCleanup();

        const withThinking = await renderMessages([thinkingMessage], vi.fn());
        for (const run of withThinking.findAllByType('EnrichedMarkdownText')) {
            expect(contextMenuItemsOf(run)).toBeUndefined();
        }
    });

    it('never offers Quote on rolled-back history or a discarded message', async () => {
        platformState.os = 'android';
        const historical = await renderMessages([userMessage, agentMessage], vi.fn(), { historical: true });
        for (const run of historical.findAllByType('EnrichedMarkdownText')) {
            expect(contextMenuItemsOf(run)).toBeUndefined();
        }
        standardCleanup();

        const discardedMetadata = { path: '/repo', host: 'host', discardedCommittedMessageLocalIds: ['local-1'] } as unknown as Metadata;
        const discarded = await renderMessages([userMessage], vi.fn(), { metadata: discardedMetadata });
        for (const run of discarded.findAllByType('EnrichedMarkdownText')) {
            expect(contextMenuItemsOf(run)).toBeUndefined();
        }
        standardCleanup();

        platformState.os = 'web';
        const webHistorical = await renderMessages([userMessage, agentMessage], vi.fn(), { historical: true });
        expect(webHistorical.findAll((node) => node.props?.testID === 'transcript-quote-source:s1')).toHaveLength(0);
    });

    it('marks quotable message bodies for the web selection control instead of a native menu', async () => {
        platformState.os = 'web';
        const screen = await renderMessages([userMessage, agentMessage], vi.fn());

        const markedBodies = new Set(screen
            .findAll((node) => node.props?.testID === 'transcript-quote-source:s1')
            .map((node) => node.props.markdown)
            .filter((markdown) => typeof markdown === 'string'));
        expect(markedBodies).toEqual(new Set(['Use the request cache', 'The cache key is wrong.']));
        for (const run of screen.findAllByType('EnrichedMarkdownText')) {
            expect(contextMenuItemsOf(run)).toBeUndefined();
        }
    });
});
