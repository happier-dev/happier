import { readFenceLayout, type FenceLayout, type FenceSpan } from '@/voice/output/codeFences';
import { nextSpeechMarkupToken } from '@/voice/output/speechMarkup';

export type TtsChunker = Readonly<{
    push: (textDelta: string) => string[];
    flush: () => string[];
}>;

function clampChunkChars(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 200;
    return Math.max(32, Math.min(2000, n));
}

export function resolveStreamingTtsChunkChars(raw: unknown): number {
    return clampChunkChars(raw);
}

type Span = FenceSpan;

function readProtectedLayout(text: string, fences: FenceLayout, force: boolean, initialCodeDelimiter = 0): FenceLayout & { inlineCodeDelimiter: number } {
    const closed = [...fences.closed];
    let openStart = fences.openStart;
    let cursor = 0;
    let inlineCodeDelimiter = initialCodeDelimiter;
    while (cursor < text.length) {
        const token = nextSpeechMarkupToken(text, cursor, inlineCodeDelimiter);
        if (!token || (fences.openStart !== null && token.start >= fences.openStart)) break;
        const fence = fences.closed.find((span) => token.start >= span.start && token.start < span.end);
        if (fence) {
            cursor = fence.end;
            continue;
        }
        if (token.kind === 'pending_link') {
            if (force) closed.push({ start: token.start, end: text.length });
            else openStart = token.start;
            break;
        }
        if (token.kind === 'link') closed.push({ start: token.start, end: token.end });
        else inlineCodeDelimiter = token.delimiterAfter;
        cursor = token.end;
    }
    return { closed, openStart, inlineCodeDelimiter };
}

function spanContaining(spans: readonly Span[], index: number): Span | null {
    return spans.find((span) => index > span.start && index < span.end) ?? null;
}

function isTerminalPunctuation(c: string | undefined): boolean {
    return c === '.' || c === '!' || c === '?';
}

/** CJK full-width terminators end a sentence without needing whitespace after them. */
function isFullWidthTerminator(c: string | undefined): boolean {
    return c === '。' || c === '！' || c === '？';
}

/**
 * True when a sentence ends right after `text[i]`. ASCII terminal punctuation only ends a sentence
 * when whitespace follows (or the text ends and `atEnd` is set), so decimals (`3.14`) and file
 * names (`file.ts`) stay intact. Dotted abbreviations such as `e.g.` / `i.e.` / `U.S.` are not
 * boundaries.
 */
function isSentenceEndAt(text: string, i: number, atEnd: boolean): boolean {
    const c = text[i];
    if (c === '\n' || isFullWidthTerminator(c)) return true;
    if (!isTerminalPunctuation(c)) return false;

    const next = text[i + 1];
    if (next === undefined) {
        if (!atEnd) return false;
    } else if (!/\s/.test(next)) {
        return false;
    }

    if (c !== '.') return true;
    let wordStart = i;
    while (wordStart > 0 && !/\s/.test(text[wordStart - 1] ?? '')) wordStart -= 1;
    const word = text.slice(wordStart, i);
    // `e.g` / `i.e` / `U.S` style abbreviations contain an inner dot between single letters.
    return !/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word);
}

function codePointBoundary(text: string, index: number): number {
    if (index <= 0 || index >= text.length) return index;
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

/** Keeps surrogate pairs and Markdown delimiter runs intact at a hard cut. */
function avoidSurrogateSplit(text: string, index: number): number {
    const end = codePointBoundary(text, index);
    if (end <= 0 || end >= text.length) return end;
    // Keep a Markdown delimiter together, with its following character available to the
    // speech normalizer. This also covers a hard cut immediately after an opening delimiter.
    const marker = /[*_~`]/u.test(text[end - 1] ?? '') ? text[end - 1] : text[end];
    if (marker === '*' || marker === '_' || marker === '~' || marker === '`') {
        let start = end;
        while (start > 0 && text[start - 1] === marker) start -= 1;
        // Chunks trim boundary whitespace. Keep literal identifier flanking with the delimiter,
        // rather than mistaking a leading underscore for emphasis in the next one.
        if (start > 1 && /\w/u.test(text[start - 1] ?? '')) start -= 1;
        if (start > 0) return start;
    }
    return end;
}

function isCuttable(text: string, index: number, fences: FenceLayout): boolean {
    if (fences.openStart !== null && index > fences.openStart) return false;
    return spanContaining(fences.closed, index) === null;
}

function lastBoundaryIndex(text: string, maxChars: number, fences: FenceLayout, atEnd: boolean, speechReady = false): number {
    const limit = Math.min(text.length, maxChars);

    for (let i = limit - 1; i >= 0; i -= 1) {
        if (isSentenceEndAt(text, i, atEnd && i === text.length - 1) && isCuttable(text, i + 1, fences)) {
            return i + 1;
        }
    }

    for (let i = limit - 1; i >= 0; i -= 1) {
        if (/\s/.test(text[i] ?? '') && isCuttable(text, i + 1, fences)) {
            return i + 1;
        }
    }

    const fence = spanContaining(fences.closed, limit);
    if (fence) return fence.start > 0 ? fence.start : fence.end + (isSentenceEndAt(text, fence.end, atEnd) ? 1 : 0);
    const cut = speechReady ? codePointBoundary(text, limit) : avoidSurrogateSplit(text, limit);
    return cut > 0 ? cut : limit + 1;
}

function firstSentenceEndIndex(text: string, maxChars: number, fences: FenceLayout): number | null {
    const limit = Math.min(text.length, maxChars);
    for (let i = 0; i < limit; i += 1) {
        if (isSentenceEndAt(text, i, true) && isCuttable(text, i + 1, fences)) {
            return i + 1;
        }
    }
    return null;
}

/**
 * Streaming chunker for assistant text deltas. Chunks end at sentence boundaries when possible and
 * keep fences and inline links intact for speech normalization. The size is a latency target:
 * an undecidable link or open fence stays in the existing pending buffer until close or flush.
 */
export function createTtsChunker(chunkChars: number): TtsChunker {
    const bounded = clampChunkChars(chunkChars);
    let buffer = '';
    let inlineCodeDelimiter = 0;

    const drain = (force: boolean): string[] => {
        const chunks: string[] = [];

        while (buffer.trim().length > 0) {
            const fences = readFenceLayout(buffer);
            if (force && fences.openStart !== null) {
                // The reply ended inside an unterminated fence: its contents are code, not speech.
                buffer = buffer.slice(0, fences.openStart);
                continue;
            }
            const protectedLayout = readProtectedLayout(buffer, fences, force, inlineCodeDelimiter);
            // While a fence is open, only the prose before it can be emitted.
            const readyLength = !force && protectedLayout.openStart !== null ? protectedLayout.openStart : buffer.length;
            if (readyLength === 0 || (!force && readyLength < bounded && protectedLayout.openStart === fences.openStart)) {
                break;
            }

            const isFinalSmallChunk = force && buffer.length <= bounded;
            const cut = isFinalSmallChunk ? buffer.length : lastBoundaryIndex(buffer, Math.min(bounded, readyLength), protectedLayout, force);
            if (cut <= 0) break;
            const nextChunk = buffer.slice(0, cut).trim();
            const emitted = buffer.slice(0, cut);
            inlineCodeDelimiter = readProtectedLayout(emitted, readFenceLayout(emitted), true, inlineCodeDelimiter).inlineCodeDelimiter;
            buffer = buffer.slice(cut).trimStart();

            if (nextChunk) {
                chunks.push(nextChunk);
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

const speechReadyLayout: FenceLayout = { closed: [], openStart: null };

function readUtf8Prefix(text: string, maxBytes: number, maxChars: number): { end: number; wordEnd: number } {
    let end = 0;
    let wordEnd = 0;
    let bytes = 0;
    for (const character of text) {
        const point = character.codePointAt(0)!;
        const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes + size > maxBytes || end + character.length > maxChars) break;
        bytes += size;
        end += character.length;
        if (/\s/u.test(character)) wordEnd = end;
    }
    return { end, wordEnd };
}

/** Batches normalized speech for providers that buffer the entire response before playback. */
export function batchSpeechForSynthesis(text: string, opts: {
    grouping?: { maxChars: number; mode: 'early-start' | 'sentence' };
    maxInputUtf8Bytes?: number;
}): string[] {
    const batches: string[] = [];
    const target = opts.grouping?.maxChars;
    const oneSentencePerBatch = opts.grouping?.mode === 'sentence';
    let remaining = text.trim();
    while (remaining) {
        const bytePrefix = opts.maxInputUtf8Bytes === undefined ? null : readUtf8Prefix(remaining, opts.maxInputUtf8Bytes, target ?? remaining.length);
        const hardEnd = bytePrefix?.end ?? remaining.length;
        if (hardEnd === 0) throw new Error('tts_input_byte_limit_too_small');
        const limit = Math.min(target ?? hardEnd, hardEnd);
        let cut = remaining.length;
        if (remaining.length > limit || oneSentencePerBatch) {
            if (target === undefined) {
                cut = bytePrefix?.wordEnd || hardEnd;
            } else {
                const first = oneSentencePerBatch || batches.length === 0
                    ? firstSentenceEndIndex(remaining, limit, speechReadyLayout)
                    : null;
                cut = first ?? (remaining.length <= limit ? remaining.length : lastBoundaryIndex(remaining, limit, speechReadyLayout, true, true));
            }
        }
        batches.push(remaining.slice(0, cut).trimEnd());
        remaining = remaining.slice(cut).trimStart();
    }
    return batches;
}
