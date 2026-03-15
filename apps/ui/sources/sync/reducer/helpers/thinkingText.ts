export function normalizeThinkingChunk(chunk: string): string {
  let text = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Avoid pathological vertical spacing from repeated newlines.
  text = text.replace(/\n{3,}/g, '\n\n');

  const lines = text.split('\n');
  const isStructuredMarkdownLine = (line: string): boolean => {
    const trimmed = line.trimStart();
    return (
      trimmed.startsWith('- ') ||
      trimmed.startsWith('* ') ||
      /^\d+\.\s/.test(trimmed) ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('```')
    );
  };

  const isDelimiterToken = (token: string): boolean =>
    token === '`' || token === '**' || token === '*' || token === '_' || token === '__' || token === '~~';

  const isNoSpaceBeforeToken = (token: string): boolean => {
    // Punctuation should attach to the previous token (e.g. "Hello" + "," => "Hello,").
    return (
      token === ',' ||
      token === '.' ||
      token === ';' ||
      token === ':' ||
      token === '!' ||
      token === '?' ||
      token === ')' ||
      token === ']' ||
      token === '}' ||
      token === '%' ||
      token === '…' ||
      token.startsWith('.,') ||
      token.startsWith('..') ||
      token.startsWith('...') ||
      token.startsWith('!') ||
      token.startsWith('?') ||
      token.startsWith(',') ||
      token.startsWith('.') ||
      token.startsWith(';') ||
      token.startsWith(':') ||
      token.startsWith(')') ||
      token.startsWith(']') ||
      token.startsWith('}')
    );
  };

  const isNoSpaceAfterChar = (ch: string): boolean => {
    // Opening punctuation and markdown delimiters should attach to the next token.
    return ch === '(' || ch === '[' || ch === '{' || ch === '<' || ch === '`' || ch === '*' || ch === '_' || ch === '~';
  };

  const hasLaterNonEmpty = (startIndexExclusive: number): boolean => {
    for (let j = startIndexExclusive + 1; j < lines.length; j++) {
      if ((lines[j] ?? '').trim().length > 0) return true;
    }
    return false;
  };

  const collapseWordPerLine = (tokenLines: string[]): string => {
    const nonEmptyLines = tokenLines.filter((line) => line.trim().length > 0);
    const hasStructuredMarkdown = tokenLines.some((line) => isStructuredMarkdownLine(line));

    // Only collapse newlines when the chunk looks like a word-per-line delta stream.
    // This preserves intentional formatting like lists and blockquotes.
    const isWordPerLine =
      !hasStructuredMarkdown &&
      nonEmptyLines.length >= 1 &&
      nonEmptyLines.every((line) => {
        const trimmed = line.trim();
        // If the provider is intentionally including leading/trailing whitespace, preserve it.
        if (trimmed !== line) return false;
        // Exclude code-ish punctuation (e.g. `constx=1;`) which should preserve line breaks.
        if (/[=;{}[\]()<>]/.test(trimmed)) return false;
        return trimmed.length <= 40 && !/\s/.test(trimmed);
      });

    if (!isWordPerLine) {
      return tokenLines.join('\n');
    }

    // Reassemble token-per-line streams into readable text while preserving markdown delimiters.
    // Providers sometimes emit delimiters as standalone tokens (e.g. "**" or "`"), and a naive
    // newline→space collapse would break markdown ("** Heading **" instead of "**Heading**").
    let out = '';
    let prevToken: string | null = null;
    for (let i = 0; i < tokenLines.length; i++) {
      const rawLine = String(tokenLines[i] ?? '');
      const token = rawLine.trim();

      // Empty line: preserve paragraph breaks when they occur mid-stream, otherwise treat trailing
      // newline as a trailing space (to keep merge behavior stable).
      if (token.length === 0) {
        if (out && !out.endsWith('\n') && !out.endsWith(' ') && !out.endsWith('\n\n') && i === tokenLines.length - 1) {
          out += ' ';
        } else if (out && !out.endsWith('\n\n') && hasLaterNonEmpty(i)) {
          // Avoid turning paragraph breaks into spaces.
          // Trim a single trailing space before inserting a paragraph break.
          if (out.endsWith(' ')) out = out.slice(0, -1);
          out += '\n\n';
        } else if (out && i === tokenLines.length - 1 && !out.endsWith(' ') && !out.endsWith('\n')) {
          out += ' ';
        }
        prevToken = null;
        continue;
      }

      if (!out || out.endsWith('\n\n')) {
        out += token;
        prevToken = token;
        continue;
      }

      const lastChar = out.slice(-1);
      const shouldAttachToPrev =
        isNoSpaceBeforeToken(token) ||
        isDelimiterToken(token) ||
        (prevToken != null && isDelimiterToken(prevToken)) ||
        (lastChar ? isNoSpaceAfterChar(lastChar) : false);

      out += (shouldAttachToPrev ? '' : ' ') + token;
      prevToken = token;
    }

    return out;
  };

  // If the thinking chunk contains fenced code blocks, we still want to collapse "word-per-line"
  // deltas outside the fence, while preserving the fence content verbatim.
  let out = '';
  let buffer: string[] = [];
  let inFence = false;

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const next = collapseWordPerLine(buffer);
    if (!out) {
      out = next;
    } else if (out.endsWith('\n')) {
      out += next;
    } else {
      out += '\n' + next;
    }
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isFenceMarker = trimmed.startsWith('```');
    if (isFenceMarker) {
      flushBuffer();
      if (!out) {
        out = line;
      } else if (out.endsWith('\n')) {
        out += line;
      } else {
        out += '\n' + line;
      }
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      if (!out) {
        out = line;
      } else if (out.endsWith('\n')) {
        out += line;
      } else {
        out += '\n' + line;
      }
      continue;
    }

    buffer.push(line);
  }

  flushBuffer();
  return out;
}

export function unwrapThinkingText(text: string): string {
  // Legacy support: older UI versions wrapped reducer thinking text as markdown:
  // `*Thinking...*\n\n*${body}*`
  const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
  return match ? match[1] : text;
}

function findMaxOverlapSuffixPrefix(left: string, right: string, maxProbe: number): number {
  const max = Math.min(maxProbe, left.length, right.length);
  for (let size = max; size > 0; size--) {
    if (left.endsWith(right.slice(0, size))) return size;
  }
  return 0;
}

/**
 * Providers may emit "cumulative" thinking updates where each delta repeats
 * some (or all) of the previous text. Merge conservatively so we don't
 * duplicate paragraphs in the UI.
 */
export function mergeThinkingText(prevText: string, nextChunk: string): string {
  const prev = unwrapThinkingText(String(prevText ?? ''));
  const next = String(nextChunk ?? '');
  if (!next) return prev;
  if (!prev) return next;

  if (next.startsWith(prev)) {
    return next;
  }

  if (prev.endsWith(next)) {
    return prev;
  }

  // Heuristic: some providers resend the full "cumulative" thinking text, but with minor drift
  // (quote normalization, whitespace, etc.) that prevents a strict `startsWith(prev)` match.
  // If the next chunk is longer and clearly contains a substantial prefix of the previous text
  // near its start, prefer replacement to avoid duplicating paragraphs in the UI.
  if (next.length > prev.length) {
    const normalizeForCumulative = (s: string): string =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

    const prevNorm = normalizeForCumulative(prev);
    const nextNorm = normalizeForCumulative(next);
    const nextHead = nextNorm.slice(0, 800);

    if (prevNorm.length >= 40 && nextNorm.includes(prevNorm)) {
      return next;
    }

    const probeStarts = [0, 80, 160, 240];
    for (const start of probeStarts) {
      const probe = prevNorm.slice(start, start + 160).trim();
      if (probe.length < 40) continue;
      if (nextHead.includes(probe)) {
        return next;
      }
    }
  }

  // Remove prefix overlap (prev suffix == next prefix).
  const overlap = findMaxOverlapSuffixPrefix(prev, next, 4000);
  if (overlap > 0) {
    return prev + next.slice(overlap);
  }

  // Some providers stream deltas without carrying the boundary whitespace.
  // Insert a single space when the join would otherwise concatenate tokens.
  const prevLast = prev.slice(-1);
  const prevTrimmedEnd = prev.replace(/\s+$/g, '');
  const prevLastSignificant = prevTrimmedEnd.replace(/[)\]"'’”]+$/g, '').slice(-1) || prevTrimmedEnd.slice(-1) || prevLast;
  const nextFirst = next.slice(0, 1);
  const boundaryHasNoWhitespace =
    prevLast.length > 0 &&
    nextFirst.length > 0 &&
    !/\s/.test(prevLast) &&
    !/\s/.test(nextFirst);

  if (boundaryHasNoWhitespace) {
    const prevWantsSpaceAfter = /[.!?:;]/.test(prevLastSignificant);
    const nextLooksLikeNewWord = /[A-Z]/.test(nextFirst);
    const nextIsPunctuation = /[.,;:!?)}\]]/.test(nextFirst) || nextFirst === '…' || nextFirst === '%';
    const prevIsOpenPunctuationOrDelimiter = /[([{<`*_~]/.test(prevLast);
    if ((prevWantsSpaceAfter || nextLooksLikeNewWord) && !nextIsPunctuation && !prevIsOpenPunctuationOrDelimiter) {
      return prev + ' ' + next;
    }
  }

  return prev + next;
}
