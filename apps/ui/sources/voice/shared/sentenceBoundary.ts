/**
 * Canonical sentence-boundary detection shared across the voice TTS pipeline.
 *
 * Both the streaming chunker (`@/voice/output/TtsChunker`) and the Kokoro
 * sentence segmenter (`@/voice/kokoro/runtime/segmentSentences`) must agree on
 * exactly what counts as a sentence-terminating `.` — otherwise streaming
 * chunk cuts and per-sentence synth boundaries drift and produce audibly wrong
 * pauses (splitting mid-decimal or mid-abbreviation). This module is the single
 * owner of that decision; do not re-implement it.
 */

/**
 * Lower-cased abbreviations (without trailing dot) whose terminal `.` must not
 * be treated as a sentence boundary. Kept intentionally small and high-value:
 * splitting here produces audibly wrong pauses.
 */
const NON_TERMINAL_ABBREVIATIONS: ReadonlySet<string> = new Set([
    'e.g',
    'i.e',
    'etc',
    'vs',
    'mr',
    'mrs',
    'ms',
    'dr',
    'prof',
    'sr',
    'jr',
    'st',
    'fig',
    'no',
    'al',
]);

function isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
}

/**
 * Whether the `.` at `dotIndex` is a real sentence terminator, or part of a
 * decimal number / known abbreviation / single-letter initial that must not be
 * split on.
 */
export function isHardTerminatorDot(text: string, dotIndex: number): boolean {
    // Decimal guard: digit immediately on either side of the dot (e.g. 3.14).
    if (isDigit(text[dotIndex - 1]) && isDigit(text[dotIndex + 1])) {
        return false;
    }

    // Abbreviation guard: walk back over the preceding word (letters and inner
    // dots, as in "e.g") and compare against the known abbreviation set.
    let start = dotIndex - 1;
    while (start >= 0 && /[A-Za-z.]/.test(text[start])) {
        start -= 1;
    }
    const token = text.slice(start + 1, dotIndex).toLowerCase();
    if (NON_TERMINAL_ABBREVIATIONS.has(token)) {
        return false;
    }

    // Single-letter token followed by a dot is almost always an initial or the
    // first half of a dotted abbreviation ("e." in "e.g.", "U." in "U.S."):
    // never treat it as a sentence terminator.
    const lastSegment = token.split('.').pop() ?? token;
    if (lastSegment.length === 1 && /[a-z]/.test(lastSegment)) {
        return false;
    }

    return true;
}
