import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';

import { useTranscriptSelectionEligibleMessageIds } from './useTranscriptSelectionEligibleMessageIds';

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'kind'>): Message {
    return {
        createdAt: 1,
        localId: null,
        text: 'text',
        ...overrides,
    } as Message;
}

function writeSessionMessages(
    messages: readonly Message[],
    options?: Readonly<{ ids?: readonly string[] }>,
): void {
    storage.setState((state) => ({
        ...state,
        sessionMessages: {
            ...state.sessionMessages,
            s1: {
                isLoaded: true,
                messageIdsOldestFirst: [...(options?.ids ?? messages.map((entry) => entry.id))],
                messagesById: Object.fromEntries(messages.map((entry) => [entry.id, entry])),
                messagesMap: Object.fromEntries(messages.map((entry) => [entry.id, entry])),
                messagesVersion: Date.now(),
            } as never,
        },
    }));
}

function streamingMeta(state: 'streaming' | 'complete' | 'interrupted' | null | 'unknown') {
    return {
        happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentState: state,
            segmentLocalId: 'seg-1',
            updatedAtMs: 1,
        },
    };
}

afterEach(() => {
    standardCleanup();
});

describe('useTranscriptSelectionEligibleMessageIds', () => {
    it('returns selectable transcript ids while excluding discarded, tool, and actively streaming messages', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({ id: 'user', kind: 'user-text', text: 'hello' }),
                message({ id: 'discarded', kind: 'user-text', localId: 'local-discarded', text: 'discarded' }),
                message({ id: 'tool', kind: 'tool-call' } as Partial<Message> & Pick<Message, 'id' | 'kind'>),
                message({ id: 'streaming', kind: 'agent-text', text: 'partial', meta: streamingMeta('streaming') }),
                message({ id: 'complete', kind: 'agent-text', text: 'done' }),
            ]);
            const metadata = { discardedCommittedMessageLocalIds: ['local-discarded'] } as Metadata;

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toEqual(['user', 'complete']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('excludes hidden thinking messages from selectable ids', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...settingsDefaults,
                    ...state.settings,
                    sessionThinkingDisplayMode: 'hidden',
                },
            }));
            writeSessionMessages([
                message({ id: 'thinking', kind: 'agent-text', text: '*Thinking...*\n\n*private reasoning*', isThinking: true }),
                message({ id: 'answer', kind: 'agent-text', text: 'done' }),
            ]);

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toEqual(['answer']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('excludes assistant stream segments with unknown state until they become terminal', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({ id: 'null-state', kind: 'agent-text', text: 'partial null', meta: streamingMeta(null) }),
                message({ id: 'unknown-state', kind: 'agent-text', text: 'partial unknown', meta: streamingMeta('unknown') }),
                message({ id: 'complete', kind: 'agent-text', text: 'done', meta: streamingMeta('complete') }),
            ]);

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toEqual(['complete']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the eligible id reference stable across active streaming text updates', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({ id: 'user', kind: 'user-text', text: 'hello' }),
                message({ id: 'streaming', kind: 'agent-text', text: 'partial', meta: streamingMeta('streaming') }),
            ]);

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const before = hook.getCurrent();

            await act(async () => {
                writeSessionMessages([
                    message({ id: 'user', kind: 'user-text', text: 'hello' }),
                    message({ id: 'streaming', kind: 'agent-text', text: 'partial with more tokens', meta: streamingMeta('streaming') }),
                ]);
            });

            expect(hook.getCurrent()).toBe(before);
            expect(hook.getCurrent()).toEqual(['user']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('falls back to messagesById ordering when transcript ids have not hydrated yet', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({ id: 'later', kind: 'agent-text', seq: 2, createdAt: 2, text: 'later' }),
                message({ id: 'earlier', kind: 'user-text', seq: 1, createdAt: 1, text: 'earlier' }),
            ], { ids: [] });

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toEqual(['earlier', 'later']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses transcript block order in the messagesById fallback when transcript ids have not hydrated yet', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({
                    id: 'z-first',
                    kind: 'agent-text',
                    seq: 10,
                    transcriptBlockIndex: 0,
                    createdAt: 2_000,
                    text: 'First block',
                }),
                message({
                    id: 'a-second',
                    kind: 'agent-text',
                    seq: 10,
                    transcriptBlockIndex: 1,
                    createdAt: 2_000,
                    text: 'Second block',
                }),
            ], { ids: [] });

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toEqual(['z-first', 'a-second']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('preserves cached eligible ids while transcript messages are transiently unloaded', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({ id: 'm1', kind: 'user-text', text: 'hello' }),
            ]);

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const loadedIds = hook.getCurrent();
            expect(loadedIds).toEqual(['m1']);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        s1: {
                            isLoaded: false,
                            messageIdsOldestFirst: [],
                            messagesById: {},
                            messagesMap: {},
                            messagesVersion: Date.now(),
                        } as never,
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(loadedIds);
            expect(hook.getCurrent()).toEqual(['m1']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates when a reused active streaming assistant message object becomes complete', async () => {
        const previousState = storage.getState();
        try {
            const reusedMessage = message({
                id: 'streaming',
                kind: 'agent-text',
                text: 'partial',
                meta: streamingMeta('streaming'),
            });
            writeSessionMessages([reusedMessage]);

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            expect(hook.getCurrent()).toEqual([]);

            await act(async () => {
                (reusedMessage as { text?: string }).text = 'complete answer';
                reusedMessage.meta = streamingMeta('complete') as Message['meta'];
                writeSessionMessages([reusedMessage]);
            });

            expect(hook.getCurrent()).toEqual(['streaming']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates when an active streaming assistant message becomes complete', async () => {
        const previousState = storage.getState();
        try {
            writeSessionMessages([
                message({ id: 'streaming', kind: 'agent-text', text: 'partial', meta: streamingMeta('streaming') }),
            ]);

            const hook = await renderHook(
                () => useTranscriptSelectionEligibleMessageIds('s1', { enabled: true, metadata: null }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            expect(hook.getCurrent()).toEqual([]);

            await act(async () => {
                writeSessionMessages([
                    message({ id: 'streaming', kind: 'agent-text', text: 'complete answer', meta: streamingMeta('complete') }),
                ]);
            });

            expect(hook.getCurrent()).toEqual(['streaming']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
