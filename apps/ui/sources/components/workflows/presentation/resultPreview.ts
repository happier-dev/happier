/**
 * Single owner of workflow agent result/summary normalization (U-9/#11/U-20).
 *
 * Provider-produced agent results arrive as opaque strings: sometimes a JSON payload, sometimes
 * markdown-ish prose, sometimes a huge dump. Both the transcript workflow card and the work-state
 * popover render agent detail through the SAME renderer, so normalization lives here (one owner)
 * instead of being re-derived per surface.
 *
 * Contract: a raw string becomes `{ kind, display }` — JSON-ish payloads are pretty-printed
 * (2-space), everything else is trimmed text. Normalization preserves the complete value;
 * collapsed reading is a presentation concern via `clampPreviewLines` and the preview viewport.
 */

export type NormalizedResultPreview = Readonly<{
    kind: 'json' | 'text';
    display: string;
}>;

export function normalizeResultPreview(raw: string): NormalizedResultPreview {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { kind: 'text', display: '' };

    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (looksJson) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed !== null && typeof parsed === 'object') {
                return { kind: 'json', display: JSON.stringify(parsed, null, 2) };
            }
        } catch {
            // Not valid JSON — fall through to text handling.
        }
    }

    return { kind: 'text', display: trimmed };
}

export type ClampedPreviewLines = Readonly<{
    text: string;
    clamped: boolean;
    hiddenLines: number;
}>;

/** Default per-preview line budget before the collapsed body shows a "Show more" affordance. */
export const RESULT_PREVIEW_MAX_LINES = 6;

/**
 * Presentation-owned line clamp: keep the first `maxLines` lines and report how many were hidden so
 * the UI can offer a local "Show more" expand without re-parsing the payload.
 */
export function clampPreviewLines(text: string, maxLines: number = RESULT_PREVIEW_MAX_LINES): ClampedPreviewLines {
    const lines = text.split('\n');
    if (lines.length <= maxLines) return { text, clamped: false, hiddenLines: 0 };
    return {
        text: lines.slice(0, maxLines).join('\n'),
        clamped: true,
        hiddenLines: lines.length - maxLines,
    };
}
