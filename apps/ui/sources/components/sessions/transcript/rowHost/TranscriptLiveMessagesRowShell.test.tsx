import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createToolCallMessageFixture,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { createTranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { storage } from '@/sync/domains/state/storageStore';

import { TranscriptLiveMessagesRowShell } from './TranscriptLiveMessagesRowShell';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    standardCleanup();
});

function writeToolMessage(params: Readonly<{
    sessionId: string;
    message: ReturnType<typeof createToolCallMessageFixture>;
    revision: number;
}>): void {
    storage.setState((state) => {
        const previous = state.sessionMessages[params.sessionId];
        const messagesById = previous?.messagesById ?? {};
        messagesById[params.message.id] = params.message;
        return {
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [params.sessionId]: {
                    messageIdsOldestFirst: previous?.messageIdsOldestFirst ?? [params.message.id],
                    messagesById,
                    messagesMap: messagesById,
                    messageRevisionsById: {
                        ...(previous?.messageRevisionsById ?? {}),
                        [params.message.id]: params.revision,
                    },
                    reducerState: previous?.reducerState ?? ({} as never),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: (previous?.messagesVersion ?? 0) + 1,
                    lastAppliedAgentStateVersion: null,
                    isLoaded: true,
                },
            },
        };
    });
}

describe('TranscriptLiveMessagesRowShell', () => {
    it('refreshes content and its shell signature for in-place tool revisions while the list item stays stable', async () => {
        const previousState = storage.getState();
        try {
            const message = createToolCallMessageFixture({
                id: 'tool-1',
                createdAt: 1,
                tool: { state: 'running' } as never,
            });
            writeToolMessage({ sessionId: 'session-1', message, revision: 1 });
            const item: ChatTranscriptListItem = {
                kind: 'tool-group-tool',
                id: 'group-1#tool:tool-1',
                groupId: 'group-1',
                toolMessageId: 'tool-1',
                toolMessageIds: ['tool-1'],
                expanded: false,
                createdAt: 1,
                seq: null,
            };
            let renderCount = 0;
            const mutations: unknown[] = [];
            const buildSignature = vi.fn(() => {
                const revision = storage.getState().sessionMessages['session-1']?.messageRevisionsById?.['tool-1'] ?? 0;
                return {
                    itemId: item.id,
                    kind: item.kind,
                    structuralKey: `revision:${revision}`,
                    expansionKey: 'tools:collapsed',
                    rowState: revision < 4 ? 'tool-progress' : 'stable',
                    widthBucket: 'wide',
                    fontScaleKey: '1',
                    groupingMode: 'linear',
                    forkContextKey: 'main',
                } satisfies TranscriptItemHeightValiditySignature;
            });
            const screen = await renderScreen(
                <TranscriptLiveMessagesRowShell
                    item={item}
                    messageRefs={[{ sessionId: 'session-1', messageId: 'tool-1' }]}
                    initialMessages={[message]}
                    buildRowShellSignature={buildSignature}
                    measurementReconciler={createTranscriptMeasurementReconciler()}
                    onRowLayoutMutation={(mutation) => mutations.push(mutation)}
                    onRowMeasured={vi.fn()}
                >
                    {(messages) => {
                        renderCount += 1;
                        const toolMessage = messages[0];
                        return React.createElement('ToolRevisionProbe', {
                            state: toolMessage?.kind === 'tool-call' ? toolMessage.tool.state : 'missing',
                            permission: toolMessage?.kind === 'tool-call' ? toolMessage.tool.permission?.status : undefined,
                        });
                    }}
                </TranscriptLiveMessagesRowShell>,
            );
            expect(screen.findByType('ToolRevisionProbe').props.state).toBe('running');

            await act(async () => {
                message.tool.permission = { id: 'permission-1', status: 'pending' };
                writeToolMessage({ sessionId: 'session-1', message, revision: 2 });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
            expect(screen.findByType('ToolRevisionProbe').props.permission).toBe('pending');

            await act(async () => {
                message.tool.permission = { id: 'permission-1', status: 'approved' };
                message.tool.state = 'completed';
                writeToolMessage({ sessionId: 'session-1', message, revision: 4 });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
            expect(screen.findByType('ToolRevisionProbe').props.state).toBe('completed');
            expect(buildSignature).toHaveBeenCalledTimes(3);
            expect(mutations).toHaveLength(2);

            const countAfterRelevantUpdates = renderCount;
            await act(async () => {
                writeToolMessage({
                    sessionId: 'session-1',
                    message: createToolCallMessageFixture({ id: 'unrelated', createdAt: 2 }),
                    revision: 1,
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
            expect(renderCount).toBe(countAfterRelevantUpdates);
        } finally {
            await act(async () => {
                storage.setState(previousState);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
        }
    });

    it('subscribes one stable group row to tool revisions across origin sessions', async () => {
        const previousState = storage.getState();
        try {
            const first = createToolCallMessageFixture({ id: 'tool-a', createdAt: 1, tool: { state: 'completed' } as never });
            const second = createToolCallMessageFixture({ id: 'tool-b', createdAt: 2, tool: { state: 'running' } as never });
            writeToolMessage({ sessionId: 'origin-a', message: first, revision: 1 });
            writeToolMessage({ sessionId: 'origin-b', message: second, revision: 1 });
            const item: ChatTranscriptListItem = {
                kind: 'tool-group-header',
                id: 'group-mixed#header',
                groupId: 'group-mixed',
                toolMessageIds: ['tool-a', 'tool-b'],
                expanded: false,
                hiddenCount: 0,
                createdAt: 1,
            };
            const signature = {
                itemId: item.id,
                kind: item.kind,
                structuralKey: 'group',
                expansionKey: 'tools:collapsed',
                rowState: 'stable',
                widthBucket: 'wide',
                fontScaleKey: '1',
                groupingMode: 'linear',
                forkContextKey: 'main',
            } satisfies TranscriptItemHeightValiditySignature;
            const screen = await renderScreen(
                <TranscriptLiveMessagesRowShell
                    item={item}
                    messageRefs={[
                        { sessionId: 'origin-a', messageId: 'tool-a' },
                        { sessionId: 'origin-b', messageId: 'tool-b' },
                    ]}
                    initialMessages={[first, second]}
                    buildRowShellSignature={() => signature}
                    measurementReconciler={createTranscriptMeasurementReconciler()}
                    onRowLayoutMutation={vi.fn()}
                    onRowMeasured={vi.fn()}
                >
                    {(messages) => React.createElement('GroupRevisionProbe', {
                        states: messages.map((message) => message.kind === 'tool-call' ? message.tool.state : 'missing'),
                    })}
                </TranscriptLiveMessagesRowShell>,
            );
            expect(screen.findByType('GroupRevisionProbe').props.states).toEqual(['completed', 'running']);

            await act(async () => {
                second.tool.state = 'error';
                writeToolMessage({ sessionId: 'origin-b', message: second, revision: 2 });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
            expect(screen.findByType('GroupRevisionProbe').props.states).toEqual(['completed', 'error']);
        } finally {
            await act(async () => {
                storage.setState(previousState);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
        }
    });
});
