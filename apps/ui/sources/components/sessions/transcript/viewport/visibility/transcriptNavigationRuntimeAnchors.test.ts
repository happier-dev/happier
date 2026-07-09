import { describe, expect, it } from 'vitest';

import {
    deriveTranscriptNavigationRuntimeAnchors,
    deriveWebTranscriptNavigationAnchorRows,
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

    it('maps visible web message rows back to navigation entry ids', () => {
        const rows = deriveWebTranscriptNavigationAnchorRows({
            anchors: [
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
            ],
            rows: [
                {
                    testId: 'transcript-anchor-message-a1',
                    topPx: 200,
                    bottomPx: 260,
                },
                {
                    testId: 'transcript-anchor-message-missing',
                    topPx: 300,
                    bottomPx: 360,
                },
            ],
        });

        expect(rows).toEqual([
            {
                anchorId: 'session-1:pinned:local:a1',
                topPx: 200,
                bottomPx: 260,
            },
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
});
