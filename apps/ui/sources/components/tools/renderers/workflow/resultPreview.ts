/**
 * Single owner of workflow agent result/summary normalization (U-9/#11/U-20).
 *
 * Provider-produced agent results arrive as opaque strings: sometimes a JSON payload, sometimes
 * markdown-ish prose, sometimes a huge dump. Both the transcript workflow card and the work-state
 * popover render agent detail through the SAME renderer, so normalization lives here (one owner)
 * instead of being re-derived per surface.
 *
 * Contract: a raw string becomes `{ kind, display, truncated }` — JSON-ish payloads are compactly
 * pretty-printed (2-space), everything else is trimmed text, and the overall length is capped so a
 * runaway payload can never fill the popover. Per-line clamping (with a "Show more" affordance) is a
 * separate, presentation-owned concern via `clampPreviewLines`.
 */

export type NormalizedResultPreview = Readonly<{
    kind: 'json' | 'text';
    display: string;
    truncated: boolean;
}>;

/** Hard character cap on the normalized display, guarding against runaway payloads. */
export const RESULT_PREVIEW_MAX_CHARS = 2000;

function clampChars(value: string, maxChars: number): { display: string; truncated: boolean } {
    if (value.length <= maxChars) return { display: value, truncated: false };
    // Trim to the cap and append an ellipsis marker so the truncation is visible.
    return { display: `${value.slice(0, maxChars).trimEnd()}…`, truncated: true };
}

export function normalizeResultPreview(raw: string, maxChars: number = RESULT_PREVIEW_MAX_CHARS): NormalizedResultPreview {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { kind: 'text', display: '', truncated: false };

    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (looksJson) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed !== null && typeof parsed === 'object') {
                const pretty = JSON.stringify(parsed, null, 2);
                const { display, truncated } = clampChars(pretty, maxChars);
                return { kind: 'json', display, truncated };
            }
        } catch {
            // Not valid JSON — fall through to text handling.
        }
    }

    const { display, truncated } = clampChars(trimmed, maxChars);
    return { kind: 'text', display, truncated };
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
