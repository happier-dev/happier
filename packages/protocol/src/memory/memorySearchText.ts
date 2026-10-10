/** Shared SQLite tokenizer contract for local memory and plaintext Home search. */
export const MEMORY_SEARCH_FTS_TOKENIZER = "unicode61 remove_diacritics 0 tokenchars ''_-$''";
const UNSPACED_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const WORDS = /[\p{L}\p{N}\p{M}_$-]+/gu;
const SNIPPET_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });
export type TokenizeMemoryTextOptions = Readonly<{ minLength?: number }>;

export function segmentMemorySearchCjkRuns(text: string): string {
  return text.replace(UNSPACED_RUN, (run) => {
    const chars = Array.from(run);
    return ` ${[...chars, ...chars.slice(1).map((char, index) => chars[index]! + char)].join(' ')} `;
  });
}

function splitIdentifier(word: string): string[] {
  return word.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[_$\s-]+/u).filter(Boolean);
}
function tokensForWord(word: string): string[] {
  return segmentMemorySearchCjkRuns(word).split(/\s+/u).filter(Boolean).map((term) => term.toLowerCase());
}

/** Frequency-preserving columns; identifiers retain their whole spelling and their parts. */
export function memorySearchTextColumns(text: string): Readonly<{ body: string; identifiers: string }> {
  const body: string[] = [];
  const identifiers: string[] = [];
  for (const word of String(text ?? '').normalize('NFKC').match(WORDS) ?? []) {
    const parts = splitIdentifier(word);
    if (parts.length === 0) continue;
    body.push(...tokensForWord(word));
    if (parts.length > 1 || /[_$-]/u.test(word)) identifiers.push(word.toLowerCase(), ...parts.flatMap(tokensForWord));
  }
  return { body: body.join(' '), identifiers: identifiers.join(' ') };
}

export function tokenizeMemoryText(text: string, options?: TokenizeMemoryTextOptions): string[] {
  const columns = memorySearchTextColumns(text);
  const minLength = Number.isFinite(options?.minLength) ? Math.max(1, Math.trunc(options!.minLength!)) : 1;
  return [...new Set(`${columns.body} ${columns.identifiers}`.split(/\s+/u).filter((term) => term && (
    Array.from(term).length >= minLength || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term)
  )))];
}

/** Every query part is required, including parts of an identifier. */
export function memorySearchQueryGroups(query: string): readonly Readonly<{ whole: string | null; parts: readonly string[] }>[] {
  return (String(query ?? '').normalize('NFKC').match(WORDS) ?? [])
    .map((word) => ({
      whole: splitIdentifier(word).length > 1 || /[_$-]/u.test(word) ? word.toLowerCase() : null,
      parts: [...new Set(splitIdentifier(word).flatMap(tokensForWord))],
    }));
}

/** Original-text excerpt centred on the first match; offsets survive NFKC expansion. */
export function createMemorySearchSnippet(text: string, query: string, maxChars: number): string {
  const terms = tokenizeMemoryText(query);
  const chars = Array.from(text);
  let haystack = '';
  const sourceOffsets: number[] = [];
  let sourceIndex = 0;
  // Graphemes compose both accents and Hangul Jamo. Case expansion lengths
  // retain original offsets; whole-text lowercasing preserves final sigma.
  for (const part of SNIPPET_SEGMENTER.segment(text)) {
    const normalized = part.segment.normalize('NFKC');
    haystack += normalized;
    for (let unit = 0; unit < normalized.toLowerCase().length; unit += 1) sourceOffsets.push(sourceIndex);
    sourceIndex += Array.from(part.segment).length;
  }
  haystack = haystack.toLowerCase();
  let foundAt = -1;
  for (const term of terms) {
    const index = haystack.indexOf(term);
    if (index >= 0 && (foundAt < 0 || index < foundAt)) foundAt = index;
  }
  const matchPoint = foundAt < 0 ? 0 : sourceOffsets[foundAt] ?? 0;
  const size = Math.max(1, Math.trunc(maxChars));
  const start = Math.min(Math.max(0, chars.length - size), Math.max(0, matchPoint - Math.floor(size / 3)));
  const end = Math.min(chars.length, start + size);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}
