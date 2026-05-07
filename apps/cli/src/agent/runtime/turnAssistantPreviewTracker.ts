export type TurnAssistantPreviewTracker = Readonly<{
    reset: () => void;
    appendDelta: (delta: string | null | undefined) => void;
    replace: (fullText: string | null | undefined) => void;
    getPreview: () => string | null;
}>;

function normalizePreviewText(value: string): string | null {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

export function createTurnAssistantPreviewTracker(): TurnAssistantPreviewTracker {
    let fullText = '';

    return {
        reset() {
            fullText = '';
        },
        appendDelta(delta) {
            if (typeof delta !== 'string' || delta.length === 0) return;
            fullText += delta;
        },
        replace(nextFullText) {
            fullText = typeof nextFullText === 'string' ? nextFullText : '';
        },
        getPreview() {
            return normalizePreviewText(fullText);
        },
    };
}
