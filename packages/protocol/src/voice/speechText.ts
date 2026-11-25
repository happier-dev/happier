import type { VoiceSpeechSynthesisInputLimits } from './speech.js';

type SpeechFence = Readonly<{ marker: '`' | '~'; length: number }>;
type SpeechLine =
  | Readonly<{ kind: 'start'; indent: number }>
  | Readonly<{ kind: 'marker'; indent: number; marker: '`' | '~'; length: number }>
  | Readonly<{ kind: 'prose' | 'code' | 'closing' }>;

/** Parser context plus only an undecidable inline-link candidate; never the full reply or fenced code.
 * The output ingestor admits each event against its turn payload budget before extending this state.
 */
export type VoiceSpeechTextState = Readonly<{
  fence: SpeechFence | null;
  line: SpeechLine;
  emphasis: readonly string[];
  previousCharacter: string;
  inlineCodeDelimiter: number;
  pendingLink: string;
}>;

type SpeechEmphasisContext = { emphasis: string[]; previousCharacter: string; inlineCodeDelimiter: number; pendingLink: string };

type SpeechMarkupToken = Readonly<{ start: number; end: number }> & (
  | Readonly<{ kind: 'code'; delimiterAfter: number }>
  | Readonly<{ kind: 'link'; label: string }>
  | Readonly<{ kind: 'pending_link' }>
);

/** Speech recognizes simple inline links/images and opaque inline code, not full Markdown. */
function nextSpeechMarkupToken(text: string, cursor: number, inlineCodeDelimiter: number): SpeechMarkupToken | null {
  const markers = inlineCodeDelimiter ? /`+/gu : /`+|!?\[/gu;
  markers.lastIndex = cursor;
  for (let match = markers.exec(text); match; match = markers.exec(text)) {
    const start = match.index;
    if (match[0][0] === '`') {
      const length = match[0].length;
      return { kind: 'code', start, end: start + length, delimiterAfter: inlineCodeDelimiter === length ? 0 : inlineCodeDelimiter || length };
    }
    const labelStart = start + match[0].length;
    const labelEnd = text.indexOf(']', labelStart);
    if (labelEnd === -1) return { kind: 'pending_link', start, end: labelStart };
    if (labelEnd === labelStart && match[0] !== '![') continue;
    if (labelEnd + 1 === text.length) return { kind: 'pending_link', start, end: labelStart };
    if (text[labelEnd + 1] !== '(') continue;
    const end = text.indexOf(')', labelEnd + 2);
    if (end === -1) return { kind: 'pending_link', start, end: labelStart };
    return { kind: 'link', start, end: end + 1, label: text.slice(labelStart, labelEnd) };
  }
  return null;
}

function removeSpeechEmphasis(text: string, context: SpeechEmphasisContext, followingCharacter: string): string {
  const normalized = text.replace(/\*{1,2}|_{1,2}|~~/g, (marker: string, offset: number) => {
    const before = text[offset - 1] ?? context.previousCharacter;
    const after = text[offset + marker.length] ?? followingCharacter;
    const active = context.emphasis.indexOf(marker);
    if (marker.startsWith('*')
      && /\d[ \t]*$/u.test(`${context.previousCharacter}${text.slice(0, offset)}`)
      && /^[ \t]*[+-]?(?:\d|\.\d)/u.test(text.slice(offset + marker.length))) return marker;
    const token = text.slice(offset + marker.length).match(/^\S*/u)?.[0] ?? '';
    const closesInToken = token.replace(/[.,!?;:)]+$/u, '').endsWith(marker);
    const glob = marker.startsWith('*') && !closesInToken
      && (/^(?:[/\\]|\.[\p{L}\p{N}_?*\[])/u.test(token) || (marker === '*' && /\.[\p{L}\p{N}_]/u.test(token)));
    if (glob) return marker;
    if (active !== -1 && !/\s/u.test(before)) {
      context.emphasis.splice(active, 1);
      return '';
    }
    if (active === -1 && !/\w/u.test(before) && after && !/\s/u.test(after)) {
      context.emphasis.push(marker);
      return '';
    }
    return marker;
  });
  context.previousCharacter = text.at(-1) ?? context.previousCharacter;
  return normalized;
}

function normalizeSpeechProse(prose: string, context: SpeechEmphasisContext, atLineStart: boolean, followingCharacter: string): string {
  const removeBlockMarker = (marker: string, offset: number) => offset === 0 && !atLineStart ? marker : '';
  const text = prose
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/gi, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, removeBlockMarker)
    .replace(/^[ \t]*>[ \t]?/gm, removeBlockMarker)
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, removeBlockMarker)
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, removeBlockMarker);
  return removeSpeechEmphasis(text, context, followingCharacter);
}

function normalizeSpeechMarkup(
  prose: string,
  context: SpeechEmphasisContext,
  final: boolean,
  atLineStart = !context.previousCharacter || context.previousCharacter === '\n',
): string {
  const text = context.pendingLink + prose;
  context.pendingLink = '';
  let spoken = '';
  let cursor = 0;
  const append = (end: number) => {
    const part = text.slice(cursor, end);
    if (context.inlineCodeDelimiter) {
      spoken += part;
      context.previousCharacter = part.at(-1) ?? context.previousCharacter;
    } else {
      spoken += normalizeSpeechProse(part, context, cursor === 0 ? atLineStart : text[cursor - 1] === '\n', text[end] ?? '');
    }
  };
  while (cursor < text.length) {
    // Active code owns delimiter detection; link-looking content remains literal.
    const token = nextSpeechMarkupToken(text, cursor, context.inlineCodeDelimiter);
    if (!token) break;
    if (token.kind === 'pending_link') {
      if (!final) {
        append(token.start);
        context.pendingLink = text.slice(token.start);
        cursor = text.length;
        break;
      }
      append(token.end);
      cursor = token.end;
      continue;
    }
    append(token.start);
    if (token.kind === 'link') spoken += normalizeSpeechMarkup(token.label, context, true, false);
    else {
      if (context.inlineCodeDelimiter === token.delimiterAfter) spoken += text.slice(token.start, token.end);
      context.inlineCodeDelimiter = token.delimiterAfter;
    }
    cursor = token.end;
  }
  append(text.length);
  return spoken;
}

/**
 * Derives speech without changing source events or transcript text. Fence context survives wire
 * segmentation, including a delimiter split across events; code contents are discarded as read.
 */
export function normalizeVoiceSpeechTextChunk(
  markdown: string,
  state: VoiceSpeechTextState | null = null,
  final = false,
): Readonly<{ text: string; state: VoiceSpeechTextState }> {
  let fence = state?.fence ?? null;
  let line: SpeechLine = state?.line ?? { kind: 'start', indent: 0 };
  const context: SpeechEmphasisContext = {
    emphasis: [...state?.emphasis ?? []],
    previousCharacter: state?.previousCharacter ?? '',
    inlineCodeDelimiter: state?.inlineCodeDelimiter ?? 0,
    pendingLink: state?.pendingLink ?? '',
  };
  let prose = '';
  const input = markdown.replace(/\r\n?/g, '\n') + (final ? '\n' : '');
  for (const char of input) {
    if (char === '\n') {
      if (line.kind === 'marker') {
        if (!fence && line.length >= 3) fence = { marker: line.marker, length: line.length };
        else if (fence && line.marker === fence.marker && line.length >= fence.length) fence = null;
        else if (!fence) prose += `${' '.repeat(line.indent)}${line.marker.repeat(line.length)}`;
      } else if (line.kind === 'closing') fence = null;
      if (!fence) prose += '\n';
      line = { kind: 'start', indent: 0 };
      continue;
    }
    if (line.kind === 'start') {
      if (char === ' ' && line.indent < 3) {
        line = { kind: 'start', indent: line.indent + 1 };
      } else if (char === '`' || char === '~') {
        line = { kind: 'marker', indent: line.indent, marker: char, length: 1 };
      } else if (fence) {
        line = { kind: 'code' };
      } else {
        prose += `${' '.repeat(line.indent)}${char}`;
        line = { kind: 'prose' };
      }
      continue;
    }
    if (line.kind === 'marker') {
      if (char === line.marker) {
        line = { ...line, length: line.length + 1 };
      } else if (!fence && line.length >= 3) {
        fence = { marker: line.marker, length: line.length };
        line = { kind: 'code' };
      } else if (!fence) {
        prose += `${' '.repeat(line.indent)}${line.marker.repeat(line.length)}${char}`;
        line = { kind: 'prose' };
      } else if (line.marker === fence.marker && line.length >= fence.length && !char.trim()) {
        line = { kind: 'closing' };
      } else {
        line = { kind: 'code' };
      }
      continue;
    }
    if (line.kind === 'closing') {
      if (char.trim()) line = { kind: 'code' };
    } else if (line.kind === 'prose') prose += char;
  }
  const text = normalizeSpeechMarkup(prose, context, final);
  return { text, state: { fence, line, ...context } };
}

/** Complete-text speech uses the same policy as streamed speech effects. */
export function toSpeechText(markdown: string): string {
  return normalizeVoiceSpeechTextChunk(markdown, null, true).text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Semantic speech boundaries shared by clients and daemon synthesis. */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'fig', 'no', 'al',
]);
const CLOSING_PUNCTUATION = /[.!?\u2026"'\u2019\u201d\uff09)\]]/u;

function isUrlToken(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1;
  return /(?:[a-z][a-z\d+.-]*:\/\/|www\.)/iu.test(text.slice(start, index));
}

export function isHardTerminatorDot(text: string, index: number): boolean {
  if (text[index] !== '.') return false;
  const next = text[index + 1];
  if (next !== undefined && !/\s|[.!?\u2026"'\u2019\u201d\uff09)\]]/u.test(next)) return false;
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
  if (!/[,;:\uff0c\uff1b\uff1a]/u.test(text[index] ?? '')) return false;
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
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const cut = previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
  const marker = text[cut - 1];
  if (marker === '*' || marker === '_' || marker === '~' || marker === '`') {
    let start = cut;
    while (start > 0 && text[start - 1] === marker) start -= 1;
    if (start > 0) return start;
  }
  return cut;
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
export function batchSpeechTextForSynthesis(
  text: string,
  limits: VoiceSpeechSynthesisInputLimits,
  options?: Readonly<{ readAloudChunkChars?: number }>,
): string[] {
  const readAloudChunkChars = options?.readAloudChunkChars;
  // The latency target is soft at one code point. The synthesis declaration still sets the hard ceiling.
  const maxCharacters = Math.min(limits.maxInputCharacters ?? Infinity,
    readAloudChunkChars === undefined ? Infinity : Math.max(2, readAloudChunkChars));
  const batches: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let end = 0;
    let bytes = 0;
    for (const character of remaining) {
      const point = character.codePointAt(0)!;
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (end + character.length > maxCharacters
        || (limits.maxInputUtf8Bytes !== undefined && bytes + size > limits.maxInputUtf8Bytes)) break;
      end += character.length;
      bytes += size;
    }
    if (end === 0) throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
    if (end < remaining.length) {
      const preferFirstSentence = readAloudChunkChars !== undefined && batches.length === 0;
      let sentence = 0;
      let clause = 0;
      let word = 0;
      for (let index = 0; index < end; index += 1) {
        if (isSpeechSentenceBoundary(remaining, index)) {
          const boundary = speechSentenceEnd(remaining, index);
          if (boundary <= end) {
            sentence = boundary;
            if (preferFirstSentence) break;
          }
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
