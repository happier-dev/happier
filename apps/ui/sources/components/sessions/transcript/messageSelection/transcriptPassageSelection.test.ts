// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@happier-dev/session-core/messages';
import { resolveCommittedMessageRef } from '../messageActions/resolveCommittedMessageRef';
import { readTranscriptPassageSelection, readNativeTranscriptPassageQuote, resolveTranscriptPassageSource } from './transcriptPassageSelection';

const message: UserTextMessage = {
    kind: 'user-text', id: 'display-row', localId: null, createdAt: 1, text: 'A **repeated** passage. A **repeated** passage.',
    messageActionReference: { v: 1, sessionId: 'session-1', messageId: 'committed-1', observedRevision: 'rev-1' },
};

const geometry = ['getBoundingClientRect', 'getClientRects'] as const;
const descriptors = geometry.map(key => Object.getOwnPropertyDescriptor(Range.prototype, key));
beforeEach(() => {
    // jsdom has no layout engine; the DOM Range and selection traversal remain real.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(1, 2, 3, 4) });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [new DOMRect(1, 2, 3, 4)] });
});
afterEach(() => geometry.forEach((key, index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else delete (Range.prototype as Partial<Range>)[key];
}));

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
        const list = document.createElement('div');
        list.id = 'chat:session-1:list';
        list.innerHTML = '<p>exact **rendered** quote</p><p>another message</p>';
        const first = list.firstElementChild as HTMLElement;
        const second = list.lastElementChild as HTMLElement;
        first.dataset.happierTranscriptPassage = JSON.stringify(source);
        second.dataset.happierTranscriptPassage = JSON.stringify(source);
        const range = document.createRange();
        range.selectNodeContents(first);
        const selection = { isCollapsed: false, rangeCount: 1, toString: () => 'exact **rendered** quote',
            getRangeAt: () => range };
        expect(readTranscriptPassageSelection(selection, 'chat:session-1:')?.source).toEqual(source);
        expect(readTranscriptPassageSelection(selection, 'chat:session-1:')?.text).toBe('exact **rendered** quote');
        expect(readTranscriptPassageSelection(selection, 'chat:other:')).toBeNull();
        // A browser block selection ends at the next message's beginning, without selecting it.
        range.setStart(first.firstChild!, 0);
        range.setEnd(second, 0);
        expect(readTranscriptPassageSelection(selection, 'chat:session-1:')?.source).toEqual(source);
        range.setEnd(second.firstChild!, 1);
        expect(readTranscriptPassageSelection(selection, 'chat:session-1:')).toBeNull();
    });
});
