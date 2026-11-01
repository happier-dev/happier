export type FenceSpan = Readonly<{ start: number; end: number }>;

export type FenceLayout = Readonly<{
  /** Complete fenced blocks, from the opening line start to the end of the closing line. */
  closed: FenceSpan[];
  /** Start of a fence that has not been closed yet, or null. */
  openStart: number | null;
}>;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Finds markdown fenced code blocks (``` or ~~~, CommonMark rules): a fence closes only on a line
 * holding the same marker character, at least as long as the opener, and nothing else. Shared by
 * the spoken-text normalizer and the TTS chunker so both agree on what is code.
 */
export function readFenceLayout(text: string): FenceLayout {
  const closed: FenceSpan[] = [];
  let open: { start: number; char: string; length: number } | null = null;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const marker = line.match(FENCE_LINE)?.[1];

    if (marker) {
      if (!open) {
        open = { start: lineStart, char: marker[0]!, length: marker.length };
      } else if (marker[0] === open.char && marker.length >= open.length && line.trim() === marker) {
        closed.push({ start: open.start, end: lineEnd });
        open = null;
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return { closed, openStart: open?.start ?? null };
}
