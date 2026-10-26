const TRANSCRIPT_QUOTE_SOURCE_TEST_ID_PREFIX = 'transcript-quote-source:';

/** Web DOM marker of a quotable message body, scoped to one Session transcript. */
export function buildTranscriptQuoteSourceTestId(sessionId: string): string {
    return `${TRANSCRIPT_QUOTE_SOURCE_TEST_ID_PREFIX}${sessionId}`;
}

export type TranscriptQuoteSelectionRect = Readonly<{ left: number; top: number; width: number; height: number }>;

export type TranscriptQuoteSelection = Readonly<{
    text: string;
    rect: TranscriptQuoteSelectionRect;
}>;

function closestQuoteSource(node: Node, testId: string): Element | null {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!element) return null;
    for (let current: Element | null = element; current; current = current.parentElement) {
        if (current.getAttribute('data-testid') === testId) return current;
    }
    return null;
}

/**
 * Reads the browser selection when it lies inside exactly one quotable message of `sessionId`.
 * `Selection.toString()` (unlike `Range.toString()`) keeps the line breaks between rendered blocks.
 */
export function readTranscriptQuoteSelection(
    selection: Selection | null,
    sessionId: string,
): TranscriptQuoteSelection | null {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const testId = buildTranscriptQuoteSourceTestId(sessionId);
    const source = closestQuoteSource(range.startContainer, testId);
    if (!source || closestQuoteSource(range.endContainer, testId) !== source) return null;
    const text = selection.toString().trim();
    if (text.length === 0) return null;
    const bounds = range.getBoundingClientRect();
    return {
        text,
        rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
    };
}
