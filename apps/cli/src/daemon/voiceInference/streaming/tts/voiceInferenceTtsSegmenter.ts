import { createHash } from 'node:crypto';

export type VoiceInferenceTtsTextSegment = Readonly<{
  segmentId: string;
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
  textHash: string;
  isLastSegment: boolean;
}>;

export type SegmentTextForDaemonTtsOptions = Readonly<{
  preferredFirstSegmentMaxChars?: number;
  maxSegmentChars?: number;
}>;

const DEFAULT_FIRST_SEGMENT_MAX_CHARS = 160;
const DEFAULT_MAX_SEGMENT_CHARS = 260;
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
]);

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function previousToken(value: string, punctuationIndex: number): string {
  const before = value.slice(0, punctuationIndex).trimEnd();
  const match = before.match(/([A-Za-z](?:[A-Za-z]|\.)*)$/u);
  return match?.[1]?.toLowerCase() ?? '';
}

function isDecimalPoint(value: string, index: number): boolean {
  return /\d/u.test(value[index - 1] ?? '') && /\d/u.test(value[index + 1] ?? '');
}

function isSentenceBoundary(value: string, index: number): boolean {
  const char = value[index];
  if (char === '!' || char === '?' || char === ';' || char === ':') {
    return true;
  }
  if (char !== '.') {
    return false;
  }
  if (isDecimalPoint(value, index)) {
    return false;
  }
  return !ABBREVIATIONS.has(previousToken(value, index));
}

function findBreakAtOrBefore(value: string, maxEnd: number, minEnd: number): number {
  for (let index = Math.min(maxEnd, value.length - 1); index >= minEnd; index -= 1) {
    if (isSentenceBoundary(value, index)) {
      return index + 1;
    }
  }
  for (let index = Math.min(maxEnd, value.length - 1); index >= minEnd; index -= 1) {
    if (value[index] === ',') {
      return index + 1;
    }
  }
  for (let index = Math.min(maxEnd, value.length - 1); index >= minEnd; index -= 1) {
    if (/\s/u.test(value[index] ?? '')) {
      return index;
    }
  }
  return Math.min(maxEnd, value.length);
}

function findFirstSentenceBoundary(value: string, start: number, maxEnd: number): number | null {
  for (let index = start; index < Math.min(maxEnd, value.length); index += 1) {
    if (isSentenceBoundary(value, index)) {
      return index + 1;
    }
  }
  return null;
}

function trimRange(value: string, start: number, end: number): Readonly<{ start: number; end: number; text: string }> {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(value[trimmedStart] ?? '')) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/u.test(value[trimmedEnd - 1] ?? '')) {
    trimmedEnd -= 1;
  }
  return {
    start: trimmedStart,
    end: trimmedEnd,
    text: value.slice(trimmedStart, trimmedEnd),
  };
}

export function segmentTextForDaemonTts(
  text: string,
  options?: SegmentTextForDaemonTtsOptions,
): readonly VoiceInferenceTtsTextSegment[] {
  const source = text.replace(/\s+/gu, ' ').trim();
  if (!source) {
    return [];
  }

  const firstMax = Math.max(24, Math.trunc(options?.preferredFirstSegmentMaxChars ?? DEFAULT_FIRST_SEGMENT_MAX_CHARS));
  const maxSegmentChars = Math.max(firstMax, Math.trunc(options?.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS));
  const ranges: Array<Readonly<{ start: number; end: number; text: string }>> = [];
  let cursor = 0;

  while (cursor < source.length) {
    const remaining = source.length - cursor;
    const limit = ranges.length === 0 ? Math.min(firstMax, maxSegmentChars) : maxSegmentChars;
    const firstSentenceBoundary = findFirstSentenceBoundary(source, cursor, cursor + limit);
    if (firstSentenceBoundary !== null && firstSentenceBoundary < source.length) {
      const range = trimRange(source, cursor, firstSentenceBoundary);
      if (range.text) {
        ranges.push(range);
      }
      cursor = firstSentenceBoundary;
      continue;
    }
    if (remaining <= limit) {
      const range = trimRange(source, cursor, source.length);
      if (range.text) {
        ranges.push(range);
      }
      break;
    }

    const minEnd = cursor + Math.max(16, Math.floor(limit * 0.35));
    const breakEnd = findBreakAtOrBefore(source, cursor + limit, minEnd);
    const range = trimRange(source, cursor, breakEnd);
    if (range.text) {
      ranges.push(range);
    }
    cursor = Math.max(breakEnd, cursor + 1);
  }

  return ranges.map((range, index) => {
    const textHash = hashText(`${range.start}:${range.end}:${range.text}`);
    return {
      segmentId: `seg-${index}-${textHash}`,
      index,
      text: range.text,
      startOffset: range.start,
      endOffset: range.end,
      textHash,
      isLastSegment: index === ranges.length - 1,
    };
  });
}
