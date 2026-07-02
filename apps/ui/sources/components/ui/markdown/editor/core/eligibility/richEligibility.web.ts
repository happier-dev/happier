/**
 * Web rich-eligibility resolver.
 *
 * Injects the web HTML round-trip adapter (`core/tiptap/markdownRoundTrip.web`,
 * a throwaway `@tiptap/core` editor) into the pure evaluator so HTML-containing
 * markdown can be admitted when it round-trips losslessly within budget.
 *
 * This is the ONLY `core/eligibility/` file allowed to reach into `core/tiptap/`
 * (it is resolved by Metro for web only, so `@tiptap/*` never enters the native
 * graph — R18). The signature mirrors `richEligibility.native.ts` exactly so the
 * platform split is type-consistent.
 */

import { getRichMarkdownRoundTripOutput } from '../tiptap/markdownRoundTrip.web';
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
 * Resolves rich-eligibility on web (with the HTML round-trip adapter injected).
 */
export function resolveRichEligibility(
    raw: string,
    opts: ResolveRichEligibilityOptions,
): MarkdownRichEligibility {
    return evaluateMarkdownRichEligibility(raw, {
        ...opts,
        htmlRoundTrip: getRichMarkdownRoundTripOutput,
    });
}
