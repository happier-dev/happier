/** Find the first case-insensitive literal match in original-text coordinates. */
export function findExternalSessionContentMatchRange(text: string, query: string): Readonly<{ start: number; end: number }> | null {
  const needle = query.toLowerCase();
  if (!needle) return null;
  const folded = text.toLowerCase();
  const foldedStart = folded.indexOf(needle);
  if (foldedStart < 0) return null;
  if (folded.length === text.length && needle.length === query.length) {
    return { start: foldedStart, end: foldedStart + needle.length };
  }

  // Lowercasing can expand a native character (İ -> i + combining dot).
  // Map the folded span back instead of slicing at its shifted offsets.
  let start = 0;
  let end = 0;
  let foldedOffset = 0;
  for (const character of text) {
    if (foldedOffset <= foldedStart) start = end;
    end += character.length;
    foldedOffset += character.toLowerCase().length;
    if (foldedOffset >= foldedStart + needle.length) return { start, end };
  }
  return null;
}

export function createExternalSessionContentMatchSnippet(text: string, query: string): string | null {
  const match = findExternalSessionContentMatchRange(text, query);
  if (!match) return null;
  // Browser and palette share a three-line subtitle. This is its compact
  // plain-text presentation window, not a resource or configurable limit.
  // Keep the complete literal match; the invocation byte budget may narrow it.
  const context = Math.max(0, Math.floor((240 - (match.end - match.start)) / 2));
  let start = Math.max(0, match.start - context);
  let end = Math.min(text.length, match.end + context);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start -= 1;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end += 1;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
