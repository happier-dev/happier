/**
 * Native rich-eligibility resolver.
 *
 * Injects NO `htmlRoundTrip` adapter — there is no DOM in the RN JS bundle and
 * we must not import any `@tiptap/*` into the native graph (R18). HTML-containing
 * markdown is therefore conservatively blocked on native (R16); the rich editor
 * is offered only for clean markdown.
 *
 * PURE — NO `@tiptap/*` import.
 */

import {
    evaluateMarkdownRichEligibility,
    type MarkdownRichEligibility,
} from './markdownRichEligibility';

export type ResolveRichEligibilityOptions = Readonly<{
    language: string | null;
    maxBytes: number;
    htmlRoundTripMaxBytes: number;
}>;

/**
 * Resolves rich-eligibility on native (no HTML round-trip adapter).
 */
export function resolveRichEligibility(
    raw: string,
    opts: ResolveRichEligibilityOptions,
): MarkdownRichEligibility {
    return evaluateMarkdownRichEligibility(raw, { ...opts, htmlRoundTrip: undefined });
}
