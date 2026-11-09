import { describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@happier-dev/session-core/messages';
import { resolveCommittedMessageRef } from '../messageActions/resolveCommittedMessageRef';
import { readTranscriptPassageSelection, readNativeTranscriptPassageQuote, resolveTranscriptPassageSource } from './transcriptPassageSelection';

const message: UserTextMessage = {
    kind: 'user-text', id: 'display-row', localId: null, createdAt: 1, text: 'A **repeated** passage. A **repeated** passage.',
    messageActionReference: { v: 1, sessionId: 'session-1', messageId: 'committed-1', observedRevision: 'rev-1' },
};

describe('committed transcript passage selection', () => {
    it('uses committed identity for user and assistant prose and refuses other sessions or uncommitted rows', () => {
        expect(resolveCommittedMessageRef({ message, sessionId: 'session-1', serverId: 'home-1' }))
            .toEqual({ kind: 'session', session: { serverId: 'home-1', sessionId: 'session-1' }, messageId: 'committed-1' });
        expect(resolveCommittedMessageRef({ message, sessionId: 'other', serverId: 'home-1' })).toBeNull();
        expect(resolveCommittedMessageRef({ message: { ...message, messageActionReference: undefined }, sessionId: 'session-1', serverId: 'home-1' })).toBeNull();
    });

    it('refuses historical, read-only, discarded, structured and streaming surfaces', () => {
        const input = { message, sessionId: 'session-1', serverId: 'home-1', canSendMessages: true, text: message.text };
        expect(resolveTranscriptPassageSource(input)).not.toBeNull();
        for (const change of [{ historical: true }, { canSendMessages: false }, { discarded: true }, { structured: true }, { streaming: true }, { text: '' }]) {
            expect(resolveTranscriptPassageSource({ ...input, ...change })).toBeNull();
        }
        expect(resolveTranscriptPassageSource({ ...input, message: { ...message, kind: 'agent-text', isThinking: true } })).toBeNull();
    });

    it('keeps the selected rendered event text, including legacy native events without renderedText', () => {
        expect(readNativeTranscriptPassageQuote({ text: 'repeated passage', start: 23, end: 39 })).toBe('repeated passage');
        expect(readNativeTranscriptPassageQuote({ renderedText: 'first second', text: 'second', start: 6, end: 12 })).toBe('second');
        expect(readNativeTranscriptPassageQuote({ renderedText: 'first second', text: 'first', start: 6, end: 12 })).toBeNull();
        expect(readNativeTranscriptPassageQuote(undefined)).toBeNull();
    });

    it('captures only one eligible prose body and rejects cross-message selections', () => {
        const source = resolveCommittedMessageRef({ message, sessionId: 'session-1', serverId: 'home-1' })!;
        const list = { nodeType: 1, id: 'chat:session-1:list' };
        const first = { nodeType: 1, parentElement: list, dataset: { happierTranscriptPassage: JSON.stringify(source) } };
        const second = { ...first };
        const node = { parentElement: first };
        const rect = { left: 1, top: 2, width: 3, height: 4 };
        const selection = { isCollapsed: false, rangeCount: 1, toString: () => 'exact **rendered** quote',
            getRangeAt: () => ({ startContainer: node, endContainer: node, getClientRects: () => [rect], getBoundingClientRect: () => rect }) };
        expect(readTranscriptPassageSelection(selection, 'chat:session-1:')?.source).toEqual(source);
        expect(readTranscriptPassageSelection(selection, 'chat:session-1:')?.text).toBe('exact **rendered** quote');
        expect(readTranscriptPassageSelection({ ...selection, getRangeAt: () => ({ ...selection.getRangeAt(), endContainer: { parentElement: second } }) }, 'chat:session-1:')).toBeNull();
        expect(readTranscriptPassageSelection(selection, 'chat:other:')).toBeNull();
    });
});
