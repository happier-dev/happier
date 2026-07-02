import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { resolveTranscriptSelectionToolbarMessages } from './resolveTranscriptSelectionToolbarMessages';

function message(input: Readonly<{ id: string; kind: Message['kind']; text: string; displayText?: string; meta?: unknown; isThinking?: boolean; localId?: string }>): Message {
    // Narrow fixture: the resolver only reads these stable message fields.
    return {
        id: input.id,
        kind: input.kind,
        text: input.text,
        displayText: input.displayText,
        meta: input.meta,
        isThinking: input.isThinking,
        localId: input.localId,
    } as unknown as Message;
}

describe('resolveTranscriptSelectionToolbarMessages', () => {
    it('returns selectable user and assistant messages in transcript order', () => {
        const resolved = resolveTranscriptSelectionToolbarMessages([
            message({ id: 'tool', kind: 'tool-call', text: 'ignored' }),
            message({ id: 'u1', kind: 'user-text', text: 'hello' }),
            message({ id: 'a1', kind: 'agent-text', text: 'hi' }),
        ]);

        expect(resolved).toEqual([
            { id: 'u1', role: 'user', text: 'hello' },
            { id: 'a1', role: 'assistant', text: 'hi' },
        ]);
    });

    it('skips hidden thinking messages', () => {
        const resolved = resolveTranscriptSelectionToolbarMessages([
            message({ id: 'thinking', kind: 'agent-text', text: '*Thinking...*\n\n*private reasoning*', isThinking: true }),
            message({ id: 'answer', kind: 'agent-text', text: 'done' }),
        ], null, { sessionThinkingDisplayMode: 'hidden' });

        expect(resolved).toEqual([{ id: 'answer', role: 'assistant', text: 'done' }]);
    });

    it('skips discarded and still-streaming assistant messages', () => {
        const resolved = resolveTranscriptSelectionToolbarMessages([
            message({ id: 'discarded', kind: 'user-text', text: 'discarded', localId: 'local-discarded' }),
            message({ id: 'streaming', kind: 'agent-text', text: 'partial', meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentState: 'streaming', segmentLocalId: 'seg-1', updatedAtMs: 1 } } }),
            message({ id: 'done', kind: 'agent-text', text: 'complete' }),
        ], { path: '/', host: 'localhost', discardedCommittedMessageLocalIds: ['local-discarded'] } as Metadata);

        expect(resolved).toEqual([{ id: 'done', role: 'assistant', text: 'complete' }]);
    });
});
