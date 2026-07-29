import { describe, expect, it } from 'vitest';

import {
    deriveTranscriptNavigationRuntimeAnchors,
    resolveTranscriptNavigationAnchorIdForJumpTarget,
} from './transcriptNavigationRuntimeAnchors';

describe('transcriptNavigationRuntimeAnchors', () => {
    it('matches entries to rendered row source indices by route id before seq/block fallback', () => {
        const anchors = deriveTranscriptNavigationRuntimeAnchors({
            entries: [
                {
                    id: 'session-1:user-turn:7',
                    sessionId: 'session-1',
                    seq: 7,
                    routeMessageId: 'local:u1',
                    transcriptBlockIndex: 0,
                    kind: 'user-turn',
                    role: 'user',
                    label: 'Install dependencies',
                    promptPreview: 'Install dependencies',
                    responsePreview: null,
                    createdAtMs: 1,
                    pinned: false,
                    pinnedAtMs: null,
                    loaded: true,
                },
                {
                    id: 'session-1:pinned:local:a1',
                    sessionId: 'session-1',
                    seq: 7,
                    routeMessageId: 'local:a1',
                    transcriptBlockIndex: 1,
                    kind: 'pinned-assistant',
                    role: 'assistant',
                    label: 'Done',
                    promptPreview: 'Install dependencies',
                    responsePreview: 'Done',
                    createdAtMs: 2,
                    pinned: true,
                    pinnedAtMs: 10,
                    loaded: true,
                },
            ],
            renderedSources: [
                {
                    sourceIndex: 0,
                    messageIds: ['u1'],
                    messages: [{
                        messageId: 'u1',
                        routeMessageId: 'local:u1',
                        seq: 7,
                        transcriptBlockIndex: 0,
                        role: 'user',
                    }],
                },
                {
                    sourceIndex: 1,
                    messageIds: ['a1'],
                    messages: [{
                        messageId: 'a1',
                        routeMessageId: 'local:a1',
                        seq: 7,
                        transcriptBlockIndex: 1,
                        role: 'assistant',
                    }],
                },
            ],
        });

        expect(anchors.map((anchor) => ({
            id: anchor.id,
            kind: anchor.kind,
            sourceIndex: anchor.sourceIndex,
            messageIds: anchor.messageIds,
        }))).toEqual([
            {
                id: 'session-1:user-turn:7',
                kind: 'user-turn',
                sourceIndex: 0,
                messageIds: ['u1'],
            },
            {
                id: 'session-1:pinned:local:a1',
                kind: 'pinned-assistant',
                sourceIndex: 1,
                messageIds: ['a1'],
            },
        ]);
    });

    // A tool-group header row carries EVERY message id in the group, so a
    // first-match scan hands each pinned tool the group's source index and a
    // second pinned tool in the same group resolves to the identical anchor —
    // the rail then shows one marker where two turns exist.
    it('resolves a pinned tool to its own row rather than its group header', () => {
        const anchors = deriveTranscriptNavigationRuntimeAnchors({
            entries: [
                {
                    id: 'session-1:pinned:tool-a',
                    sessionId: 'session-1',
                    seq: 4,
                    routeMessageId: 'local:tool-a',
                    transcriptBlockIndex: null,
                    kind: 'pinned-tool',
                    role: 'tool',
                    label: 'Read file',
                    promptPreview: 'Prompt',
                    responsePreview: 'Read file',
                    createdAtMs: 1,
                    pinned: true,
                    pinnedAtMs: 1,
                    loaded: true,
                },
                {
                    id: 'session-1:pinned:tool-b',
                    sessionId: 'session-1',
                    seq: 5,
                    routeMessageId: 'local:tool-b',
                    transcriptBlockIndex: null,
                    kind: 'pinned-tool',
                    role: 'tool',
                    label: 'Write file',
                    promptPreview: 'Prompt',
                    responsePreview: 'Write file',
                    createdAtMs: 2,
                    pinned: true,
                    pinnedAtMs: 2,
                    loaded: true,
                },
            ],
            renderedSources: [
                {
                    sourceIndex: 3,
                    messageIds: ['tool-a', 'tool-b'],
                    messages: [
                        { messageId: 'tool-a', routeMessageId: 'local:tool-a', seq: 4, transcriptBlockIndex: null, role: 'tool' },
                        { messageId: 'tool-b', routeMessageId: 'local:tool-b', seq: 5, transcriptBlockIndex: null, role: 'tool' },
                    ],
                },
                {
                    sourceIndex: 4,
                    messageIds: ['tool-a'],
                    messages: [
                        { messageId: 'tool-a', routeMessageId: 'local:tool-a', seq: 4, transcriptBlockIndex: null, role: 'tool' },
                    ],
                },
                {
                    sourceIndex: 5,
                    messageIds: ['tool-b'],
                    messages: [
                        { messageId: 'tool-b', routeMessageId: 'local:tool-b', seq: 5, transcriptBlockIndex: null, role: 'tool' },
                    ],
                },
            ],
        });

        expect(anchors.map((anchor) => ({ id: anchor.id, sourceIndex: anchor.sourceIndex }))).toEqual([
            { id: 'session-1:pinned:tool-a', sourceIndex: 4 },
            { id: 'session-1:pinned:tool-b', sourceIndex: 5 },
        ]);
    });

    it('matches route-backed entries by seq, block index, and role so same-route flattened blocks do not collapse', () => {
        const anchors = deriveTranscriptNavigationRuntimeAnchors({
            entries: [
                {
                    id: 'session-1:pinned:assistant-block-1',
                    sessionId: 'session-1',
                    seq: 10,
                    routeMessageId: 'server:assistant-message',
                    transcriptBlockIndex: 1,
                    kind: 'pinned-assistant',
                    role: 'assistant',
                    label: 'First assistant block',
                    promptPreview: 'Prompt',
                    responsePreview: 'First assistant block',
                    createdAtMs: 10,
                    pinned: true,
                    pinnedAtMs: 10,
                    loaded: true,
                },
                {
                    id: 'session-1:pinned:assistant-block-2',
                    sessionId: 'session-1',
                    seq: 10,
                    routeMessageId: 'server:assistant-message',
                    transcriptBlockIndex: 2,
                    kind: 'pinned-assistant',
                    role: 'assistant',
                    label: 'Second assistant block',
                    promptPreview: 'Prompt',
                    responsePreview: 'Second assistant block',
                    createdAtMs: 20,
                    pinned: true,
                    pinnedAtMs: 20,
                    loaded: true,
                },
            ],
            renderedSources: [
                {
                    sourceIndex: 0,
                    messageIds: ['assistant-block-1'],
                    messages: [{
                        messageId: 'assistant-block-1',
                        routeMessageId: 'server:assistant-message',
                        seq: 10,
                        transcriptBlockIndex: 1,
                        role: 'assistant',
                    }],
                },
                {
                    sourceIndex: 1,
                    messageIds: ['assistant-block-2'],
                    messages: [{
                        messageId: 'assistant-block-2',
                        routeMessageId: 'server:assistant-message',
                        seq: 10,
                        transcriptBlockIndex: 2,
                        role: 'assistant',
                    }],
                },
            ],
        });

        expect(anchors.map((anchor) => ({
            id: anchor.id,
            sourceIndex: anchor.sourceIndex,
            messageIds: anchor.messageIds,
        }))).toEqual([
            {
                id: 'session-1:pinned:assistant-block-1',
                sourceIndex: 0,
                messageIds: ['assistant-block-1'],
            },
            {
                id: 'session-1:pinned:assistant-block-2',
                sourceIndex: 1,
                messageIds: ['assistant-block-2'],
            },
        ]);
    });

    describe('resolveTranscriptNavigationAnchorIdForJumpTarget', () => {
        const anchors = [
            {
                id: 'turn-4',
                kind: 'user-turn' as const,
                sourceIndex: 2,
                messageIds: ['u4'],
                role: 'user' as const,
                routeMessageId: 'local:u4',
                seq: 4,
                transcriptBlockIndex: 0,
            },
            {
                id: 'block-2',
                kind: 'pinned-assistant' as const,
                sourceIndex: 6,
                messageIds: ['a9'],
                role: 'assistant' as const,
                routeMessageId: 'server:a9',
                seq: 9,
                transcriptBlockIndex: 2,
            },
            {
                id: 'block-3',
                kind: 'pinned-assistant' as const,
                sourceIndex: 7,
                messageIds: ['a9b'],
                role: 'assistant' as const,
                routeMessageId: 'server:a9',
                seq: 9,
                transcriptBlockIndex: 3,
            },
        ];

        it('maps a route-message-id target back to the anchor the landing put the reader on', () => {
            expect(resolveTranscriptNavigationAnchorIdForJumpTarget({
                anchors,
                target: {
                    kind: 'route-message-id',
                    routeMessageId: 'server:a9',
                    seqHint: 9,
                    transcriptBlockIndex: 3,
                    role: 'assistant',
                },
            })).toBe('block-3');
        });

        it('lands a bare-seq target on the earliest rendered row sharing that seq', () => {
            expect(resolveTranscriptNavigationAnchorIdForJumpTarget({
                anchors,
                target: { kind: 'seq', seq: 9 },
            })).toBe('block-2');
        });

        it('reports no anchor when the target identifies nothing rendered', () => {
            expect(resolveTranscriptNavigationAnchorIdForJumpTarget({
                anchors,
                target: { kind: 'seq', seq: 99 },
            })).toBeNull();
        });
    });
});
