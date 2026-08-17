import type { RemendOptions } from 'remend';

export const STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS = 4096;
export const STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS = 32;

/**
 * Destination remend gives a link whose URL has not finished streaming.
 *
 * A link label that streams as plain paragraph text is re-parented into a Link node the
 * moment `)` arrives, which remounts the reveal span wrapping it and restarts its opacity
 * keyframe (MEASURED 2026-08-03: 12/12 link labels re-animated on real Codex streams,
 * against 0/38 bold tokens — bold is immune because `**` closes eagerly). Closing the link
 * eagerly with this placeholder keeps the label inside its Link node from first paint, so
 * completion only changes the href.
 *
 * The placeholder is not a destination: it must never be opened or handed to a caller.
 */
export const STREAMING_INCOMPLETE_LINK_HREF = 'streamdown:incomplete-link';

export function isStreamingIncompleteLinkHref(url: string | null | undefined): boolean {
    return String(url ?? '').trim() === STREAMING_INCOMPLETE_LINK_HREF;
}

export const STREAMING_MARKDOWN_REMEND_OPTIONS = {
    inlineKatex: false,
    katex: true,
    linkMode: 'protocol',
    htmlTags: false,
} satisfies RemendOptions;

/**
 * remend short-circuits its remaining handlers as soon as the link handler closes an
 * incomplete link with the placeholder, so emphasis, inline code and math opened before
 * that link stay unterminated and paint literal syntax. The repair is finished with a
 * second pass over the now-closed document; link repair is off so it cannot short-circuit
 * again, and it only runs on the chunks that actually end in a placeholder.
 */
export const STREAMING_MARKDOWN_REMEND_OPTIONS_WITHOUT_LINKS = {
    ...STREAMING_MARKDOWN_REMEND_OPTIONS,
    links: false,
    images: false,
} satisfies RemendOptions;
