/**
 * Projection bounds are shared contract values, not source-local numbers.
 *
 * The Triage contract owns the display-text, fact-value, and fact-count limits. This
 * source deliberately declares none of its own: inventing a tighter local cap would
 * create a second decision-maker for the same concept and would mark ordinary complete
 * issues as truncated for no reason. The caller supplies the shared values, and every
 * projection applies them through `projectTriageDisplayTextV1` at the same owner — this
 * module holds no truncation of its own to re-export.
 */

export type PosthogProjectionBounds = Readonly<{
    /** Shared display-text limit, in UTF-8 bytes. */
    textUtf8Bytes: number;
    /** Shared per-fact-value limit, in UTF-8 bytes. */
    factValueUtf8Bytes: number;
    /** Shared projected fact-count limit. */
    maxFacts: number;
}>;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
    return encoder.encode(value).length;
}
