// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTranscriptQuoteSourceTestId, readTranscriptQuoteSelection } from './readTranscriptQuoteSelection';

function mountMessage(sessionId: string, paragraphs: readonly string[]): HTMLElement {
    const source = document.createElement('div');
    source.setAttribute('data-testid', buildTranscriptQuoteSourceTestId(sessionId));
    for (const text of paragraphs) {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        source.appendChild(paragraph);
    }
    document.body.appendChild(source);
    return source;
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selection.addRange(range);
    return selection;
}

describe('readTranscriptQuoteSelection', () => {
    const originalRect = Range.prototype.getBoundingClientRect;

    beforeEach(() => {
        Range.prototype.getBoundingClientRect = () => ({
            left: 40, top: 120, width: 200, height: 18, right: 240, bottom: 138, x: 40, y: 120, toJSON: () => ({}),
        });
    });

    afterEach(() => {
        Range.prototype.getBoundingClientRect = originalRect;
        window.getSelection()?.removeAllRanges();
        document.body.innerHTML = '';
    });

    it('returns the selected text and its window rect when the selection stays inside one quotable message', () => {
        const message = mountMessage('s1', ['Use the cache key', 'from the request']);
        const first = message.childNodes[0]!.firstChild!;

        const result = readTranscriptQuoteSelection(select(first, 8, first, 17), 's1');

        expect(result).toEqual({ text: 'cache key', rect: { left: 40, top: 120, width: 200, height: 18 } });
    });

    it('rejects a selection that crosses two messages', () => {
        const first = mountMessage('s1', ['first message']);
        const second = mountMessage('s1', ['second message']);

        const result = readTranscriptQuoteSelection(
            select(first.firstChild!.firstChild!, 0, second.firstChild!.firstChild!, 6),
            's1',
        );

        expect(result).toBeNull();
    });

    it('rejects selections outside this session transcript, collapsed selections and blank text', () => {
        const otherSession = mountMessage('s2', ['other session']);
        const text = otherSession.firstChild!.firstChild!;
        expect(readTranscriptQuoteSelection(select(text, 0, text, 5), 's1')).toBeNull();

        const own = mountMessage('s1', ['own   message']);
        const ownText = own.firstChild!.firstChild!;
        expect(readTranscriptQuoteSelection(select(ownText, 2, ownText, 2), 's1')).toBeNull();
        expect(readTranscriptQuoteSelection(select(ownText, 3, ownText, 6), 's1')).toBeNull();
        expect(readTranscriptQuoteSelection(null, 's1')).toBeNull();
    });
});
