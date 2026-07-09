/**
 * Sentence segmentation for incremental TTS synthesis.
 *
 * Splits text into sentence-level segments on hard terminators (`.?!` and
 * newlines) while guarding against decimals (`3.14`) and known abbreviations
 * (`e.g.`, `Dr.`) so we never start a new synth job mid-number or mid-title.
 * Used by the native Kokoro runtime to synthesize and yield sentence-by-sentence
 * instead of one whole-text blob, cutting time-to-first-audio for long replies.
 *
 * The hard-terminator decision is the canonical one shared with the streaming
 * `TtsChunker` via `@/voice/shared/sentenceBoundary`, so both agree on what
 * counts as a sentence boundary.
 */

import { isHardTerminatorDot } from '@/voice/shared/sentenceBoundary';

export function segmentSentencesForSynthesis(text: string): string[] {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return [];
    }

    const segments: string[] = [];
    let segmentStart = 0;

    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        const isTerminator =
            c === '\n'
            || c === '!'
            || c === '?'
            || (c === '.' && isHardTerminatorDot(text, i));
        if (!isTerminator) {
            continue;
        }

        // Extend across any run of terminator chars and trailing closing quotes/brackets.
        let end = i + 1;
        while (end < text.length && /[.!?…"'’”)\]]/.test(text[end])) {
            end += 1;
        }
        const segment = text.slice(segmentStart, end).trim();
        if (segment.length > 0) {
            segments.push(segment);
        }
        segmentStart = end;
        i = end - 1;
    }

    const tail = text.slice(segmentStart).trim();
    if (tail.length > 0) {
        segments.push(tail);
    }

    return segments;
}
