import type { VoiceSpeechSynthesisInputLimits } from './speech.js';

/** Semantic speech boundaries shared by clients and daemon synthesis. */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'fig', 'no', 'al',
]);
const CLOSING_PUNCTUATION = /[.!?…"'’”）)\]]/u;

function isUrlToken(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1;
  return /(?:[a-z][a-z\d+.-]*:\/\/|www\.)/iu.test(text.slice(start, index));
}

export function isHardTerminatorDot(text: string, index: number): boolean {
  if (text[index] !== '.') return false;
  const next = text[index + 1];
  if (next !== undefined && !/\s|[.!?…"'’”）)\]]/u.test(next)) return false;
  let start = index - 1;
  while (start >= 0 && /[a-z.]/iu.test(text[start]!)) start -= 1;
  const token = text.slice(start + 1, index).toLowerCase();
  if (ABBREVIATIONS.has(token)) return false;
  const last = token.split('.').pop() ?? '';
  return !(last.length === 1 && /[a-z]/u.test(last));
}

export function isSpeechSentenceBoundary(text: string, index: number, options?: Readonly<{ streaming: boolean }>): boolean {
  const char = text[index];
  if (char === '\n' || char === '。' || char === '！' || char === '？') return true;
  if (char === '.') return isHardTerminatorDot(text, index)
    && (!options?.streaming || speechSentenceEnd(text, index) < text.length);
  if (char !== '!' && char !== '?') return false;
  return !isUrlToken(text, index);
}

export function isSpeechClauseBoundary(text: string, index: number, options?: Readonly<{ streaming: boolean }>): boolean {
  if (!/[,;:，；：]/u.test(text[index] ?? '')) return false;
  const next = text[index + 1];
  return ((next === undefined && !options?.streaming) || /\s/u.test(next ?? '')) && !isUrlToken(text, index);
}

export function speechSentenceEnd(text: string, index: number): number {
  let end = index + 1;
  while (end < text.length && CLOSING_PUNCTUATION.test(text[end]!)) end += 1;
  return end;
}

export function segmentSentencesForSynthesis(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isSpeechSentenceBoundary(text, index)) continue;
    const end = speechSentenceEnd(text, index);
    const segment = text.slice(start, end).trim();
    if (segment) segments.push(segment);
    start = end;
    index = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

export function speechTextEndAtOrBefore(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

/** The output event budget stays coalesced after the first useful sentence. */
export function resolveVoiceSpeechSegmentLength(text: string, options: Readonly<{
  force: boolean;
  firstSegment: boolean;
  /** Admitted speech latency preference, independent of provider input limits. */
  targetChars?: number;
}>): number {
  const target = options.targetChars ?? 320;
  const limit = text.length;
  if (options.force) return limit;
  for (let index = 0; index < limit; index += 1) {
    if (!isSpeechSentenceBoundary(text, index, { streaming: true })) continue;
    const end = speechSentenceEnd(text, index);
    if (end > limit) continue;
    if (options.firstSegment || end >= target) return end;
    index = end - 1;
  }
  if (text.length < target) return 0;
  for (let index = limit - 1; index >= target - 1; index -= 1) {
    if (/\s/u.test(text[index]!) || isSpeechClauseBoundary(text, index, { streaming: true })) return index + 1;
  }
  return 0;
}

/** Ordered synthesis batches; never split a UTF-16 surrogate pair. */
export function batchSpeechTextForSynthesis(text: string, limits: VoiceSpeechSynthesisInputLimits): string[] {
  const batches: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let end = 0;
    let bytes = 0;
    for (const character of remaining) {
      const point = character.codePointAt(0)!;
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if ((limits.maxInputCharacters !== undefined && end + character.length > limits.maxInputCharacters)
        || (limits.maxInputUtf8Bytes !== undefined && bytes + size > limits.maxInputUtf8Bytes)) break;
      end += character.length;
      bytes += size;
    }
    if (end === 0) throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
    if (end < remaining.length) {
      let sentence = 0;
      let clause = 0;
      let word = 0;
      for (let index = 0; index < end; index += 1) {
        if (isSpeechSentenceBoundary(remaining, index)) {
          const boundary = speechSentenceEnd(remaining, index);
          if (boundary <= end) sentence = boundary;
        } else if (isSpeechClauseBoundary(remaining, index)) clause = index + 1;
        else if (/\s/u.test(remaining[index]!)) word = index + 1;
      }
      end = sentence || clause || word || end;
    }
    const batch = remaining.slice(0, end).trim();
    if (batch) batches.push(batch);
    remaining = remaining.slice(end).trimStart();
  }
  return batches;
}
