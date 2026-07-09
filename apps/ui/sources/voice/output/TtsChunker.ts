import { isHardTerminatorDot } from '@/voice/shared/sentenceBoundary';

export type TtsChunker = Readonly<{
    push: (textDelta: string) => string[];
    flush: () => string[];
}>;

function clampChunkChars(raw: unknown): number {
    const candidate =
        typeof raw === 'string'
            ? Number(raw.trim())
            : raw;
    const n = typeof candidate === 'number' && Number.isFinite(candidate) ? Math.floor(candidate) : 200;
    return Math.max(32, Math.min(2000, n));
}

export function resolveStreamingTtsChunkChars(raw: unknown): number {
    return clampChunkChars(raw);
}

/**
 * Aggressive first-chunk bound: how many characters the very first chunk is
 * allowed to grow to before we force a word-boundary cut. Kept small so
 * time-to-first-audio stays low even when the assistant opens with a long
 * uninterrupted clause. Derived from the steady-state bound but capped.
 */
const FIRST_CHUNK_MAX_CHARS = 48;
/** Word budget for the first chunk when no early punctuation is present. */
const FIRST_CHUNK_MAX_WORDS = 6;

/** Index just past the earliest hard sentence terminator within `limit`, or -1. */
function firstTerminatorIndex(text: string, limit: number): number {
    const scopedLen = Math.min(text.length, limit);
    for (let i = 0; i < scopedLen; i += 1) {
        const c = text[i];
        if (c === '\n') {
            return i + 1;
        }
        if (c === '!' || c === '?') {
            return i + 1;
        }
        if (c === '.' && isHardTerminatorDot(text, i)) {
            return i + 1;
        }
    }
    return -1;
}

/** Index just past the earliest clause boundary (comma/semicolon/colon), or -1. */
function firstClauseBoundaryIndex(text: string, limit: number): number {
    const scopedLen = Math.min(text.length, limit);
    for (let i = 0; i < scopedLen; i += 1) {
        const c = text[i];
        if (c === ',' || c === ';' || c === ':') {
            return i + 1;
        }
    }
    return -1;
}

/** Index just past the Nth whitespace-delimited word within `limit`, or -1. */
function wordBudgetIndex(text: string, limit: number, maxWords: number): number {
    const scopedLen = Math.min(text.length, limit);
    let words = 0;
    let i = 0;
    // Skip leading whitespace.
    while (i < scopedLen && /\s/.test(text[i])) i += 1;
    while (i < scopedLen) {
        // Consume a word.
        while (i < scopedLen && !/\s/.test(text[i])) i += 1;
        words += 1;
        if (words >= maxWords) {
            return i;
        }
        // Consume the gap.
        while (i < scopedLen && /\s/.test(text[i])) i += 1;
    }
    return -1;
}

/**
 * Last hard sentence terminator within `maxChars`, else last clause boundary,
 * else last whitespace, else the bound itself. Used for steady-state cuts where
 * we prefer the *latest* natural boundary that fits the larger budget.
 */
function lastBoundaryIndex(text: string, maxChars: number): number {
    const limit = Math.min(text.length, maxChars);

    for (let i = limit - 1; i >= 0; i -= 1) {
        const c = text[i];
        if (c === '\n' || c === '!' || c === '?') {
            return i + 1;
        }
        if (c === '.' && isHardTerminatorDot(text, i)) {
            return i + 1;
        }
    }

    for (let i = limit - 1; i >= 0; i -= 1) {
        const c = text[i];
        if (c === ',' || c === ';' || c === ':') {
            return i + 1;
        }
    }

    for (let i = limit - 1; i >= 0; i -= 1) {
        if (/\s/.test(text[i])) {
            return i + 1;
        }
    }

    return limit;
}

/**
 * Aggressive first-chunk cut index: prefer the earliest sentence terminator,
 * then the earliest clause boundary, then a small word budget. Returns -1 when
 * the buffer cannot yet justify an early cut (so we wait for more deltas).
 */
function firstChunkCutIndex(text: string): number {
    const bound = Math.min(text.length, FIRST_CHUNK_MAX_CHARS);

    const terminator = firstTerminatorIndex(text, bound);
    if (terminator > 0) return terminator;

    const clause = firstClauseBoundaryIndex(text, bound);
    if (clause > 0) return clause;

    const wordCut = wordBudgetIndex(text, bound, FIRST_CHUNK_MAX_WORDS);
    if (wordCut > 0) return wordCut;

    // Buffer already overflowed the first-chunk bound with a single long token:
    // fall back to the bound so audio still starts.
    if (text.length >= FIRST_CHUNK_MAX_CHARS) return bound;

    return -1;
}

export function createTtsChunker(chunkChars: number): TtsChunker {
    const bounded = clampChunkChars(chunkChars);
    let buffer = '';
    let firstChunkEmitted = false;

    const drain = (force: boolean): string[] => {
        const chunks: string[] = [];

        while (buffer.trim().length > 0) {
            // The first chunk uses the aggressive small bound to minimise
            // time-to-first-audio; steady-state uses the larger configured bound.
            if (!firstChunkEmitted) {
                const cut = force ? buffer.length : firstChunkCutIndex(buffer);
                if (cut <= 0) {
                    break;
                }
                const nextChunk = buffer.slice(0, cut).trim();
                buffer = buffer.slice(cut).trimStart();
                if (!nextChunk) {
                    if (!force) break;
                    continue;
                }
                chunks.push(nextChunk);
                firstChunkEmitted = true;
                continue;
            }

            if (!force && buffer.length < bounded) {
                break;
            }

            const isFinalSmallChunk = force && buffer.length <= bounded;
            const cut = isFinalSmallChunk ? buffer.length : lastBoundaryIndex(buffer, bounded);
            const nextChunk = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut).trimStart();

            if (!nextChunk) {
                if (!force) break;
                continue;
            }
            chunks.push(nextChunk);

            if (!force && buffer.length < bounded) {
                break;
            }
        }

        return chunks;
    };

    return {
        push: (textDelta: string) => {
            if (typeof textDelta !== 'string' || textDelta.length === 0) {
                return [];
            }
            buffer += textDelta;
            return drain(false);
        },
        flush: () => drain(true),
    };
}
