import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/transcriptViewportAnchorResolution';

describe('transcriptViewportAnchorResolution', () => {
    it('resolves anchors by message id before falling back to item id', () => {
        const items = [
            { kind: 'message', id: 'stale-item', messageId: 'other-message' },
            { kind: 'tool-calls-group', id: 'new-item', toolMessageIds: ['message-1'] },
        ] as const;

        expect(resolveTranscriptViewportAnchorIndex({
            anchor: { messageId: 'message-1', itemId: 'stale-item' },
            items,
        })).toBe(1);
    });

    it('finds message ids inside turn rows', () => {
        const items = [
            {
                kind: 'turn',
                id: 'turn-1',
                turn: {
                    userMessageId: 'user-1',
                    content: [
                        { kind: 'message', messageId: 'assistant-1' },
                        { kind: 'tool_calls', toolMessageIds: ['tool-1'] },
                    ],
                },
            },
        ] as const;

        expect(resolveTranscriptViewportAnchorIndex({
            anchor: { messageId: 'tool-1', itemId: 'missing-item' },
            items,
        })).toBe(0);
    });

    it('creates the finest stable descriptor available for a turn row', () => {
        expect(resolveTranscriptViewportAnchorDescriptor({
            kind: 'turn',
            id: 'turn-1',
            turn: {
                userMessageId: null,
                content: [{ kind: 'tool_calls', toolMessageIds: ['tool-1'] }],
            },
        })).toEqual({
            kind: 'toolGroup',
            itemId: 'turn-1',
            messageId: 'tool-1',
        });
    });

    it('uses the shared clamped focus-line offset', () => {
        expect(resolveTranscriptViewportAnchorFocusOffsetPx(100)).toBe(64);
        expect(resolveTranscriptViewportAnchorFocusOffsetPx(600)).toBe(108);
        expect(resolveTranscriptViewportAnchorFocusOffsetPx(2000)).toBe(128);
    });
});
