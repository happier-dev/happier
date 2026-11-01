import { readFenceLayout } from '@/voice/output/codeFences';
import { nextSpeechMarkupToken } from '@/voice/output/speechMarkup';

/** Delimiter context only; no assistant text is buffered. */
export type SpeechTextContext = { emphasis: string[]; previousCharacter?: string; inlineCodeDelimiter?: number };

export function createSpeechTextContext(): SpeechTextContext {
  return { emphasis: [], previousCharacter: '', inlineCodeDelimiter: 0 };
}

function removeSpeechEmphasis(text: string, context: SpeechTextContext, precedingCharacter: string, followingCharacter: string): string {
  const normalized = text.replace(/\*{1,2}|_{1,2}|~~/g, (marker: string, offset: number) => {
    const before = text[offset - 1] ?? precedingCharacter;
    const after = text[offset + marker.length] ?? followingCharacter;
    const active = context.emphasis.indexOf(marker);
    if (marker.startsWith('*')
      && /\d[ \t]*$/u.test(`${context.previousCharacter ?? ''}${text.slice(0, offset)}`)
      && /^[ \t]*[+-]?(?:\d|\.\d)/u.test(text.slice(offset + marker.length))) return marker;
    // Wildcard paths and identifier/operator punctuation are literal speech input.
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

function removeFencedCode(text: string): string {
  const { closed, openStart } = readFenceLayout(text);
  let out = '';
  let cursor = 0;
  for (const span of closed) {
    out += `${text.slice(cursor, span.start)}\n`;
    cursor = span.end;
  }
  return openStart === null ? out + text.slice(cursor) : `${out}${text.slice(cursor, openStart)}\n`;
}

function normalizeSpeechProse(text: string, context: SpeechTextContext, atLineStart: boolean, followingCharacter: string): string {
  const removeBlockMarker = (marker: string, offset: number) => offset === 0 && !atLineStart ? marker : '';
  // Bare URLs are read as their domain.
  text = text.replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/gi, '$1');

  // Block-level markers at the start of a line.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, removeBlockMarker);
  text = text.replace(/^[ \t]*>[ \t]?/gm, removeBlockMarker);
  // Horizontal rules before list markers, so `- - -` is not read as a list item.
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, removeBlockMarker);
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, removeBlockMarker);

  // Retain only delimiter context when one emphasis span crosses streamed chunks.
  return removeSpeechEmphasis(text, context, atLineStart ? '' : context.previousCharacter ?? '', followingCharacter);
}

function normalizeSpeechMarkup(text: string, context: SpeechTextContext, atLineStart: boolean): string {
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
    // Active code owns delimiter detection; link-looking content stays literal even when
    // it contains the backtick that closes this code span.
    const token = nextSpeechMarkupToken(text, cursor, context.inlineCodeDelimiter ?? 0);
    if (!token) break;
    if (token.kind === 'pending_link') {
      append(token.end);
      cursor = token.end;
      continue;
    }
    append(token.start);
    if (token.kind === 'link') spoken += normalizeSpeechMarkup(token.label, context, false);
    else {
      if (context.inlineCodeDelimiter === token.delimiterAfter) spoken += text.slice(token.start, token.end);
      context.inlineCodeDelimiter = token.delimiterAfter;
    }
    cursor = token.end;
  }
  append(text.length);
  return spoken;
}

/** Canonical spoken-text policy for whole replies and streamed chunks at speakAssistantText. */
export function toSpeechText(markdown: string, context = createSpeechTextContext()): string {
  const text = removeFencedCode(markdown.replace(/\r\n?/g, '\n'));
  return normalizeSpeechMarkup(text, context, true)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
