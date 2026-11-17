/** Canonical Markdown-to-plain preview, shared by transcript previews and Run summaries. */
export function stripMarkdown(text: string, options?: Readonly<{
  /** Indexed conversation snippets prefix original message bodies with these roles. */
  omitRolePrefixes?: boolean;
  /** Search can match the number itself; previews must retain that searchable text. */
  preserveOrderedListNumbers?: boolean;
}>): string {
  const literals: string[] = [];
  const protectLiteral = (literal: string) => {
    literals.push(literal);
    return `\u0000${literals.length - 1}\u0000`;
  };

  // Code contents are literal, including pipes and Markdown emphasis/link syntax.
  // Protect input NULs too: formatting can join them into a restoration token.
  let literalPattern = /(^|[^`])(`+)(?!`)([\s\S]*?[^`])\2(?!`)/g;
  if (text.includes('\u0000')) literalPattern = new RegExp(`${literalPattern.source}|\\u0000`, 'g');
  const protectedText = text.replace(literalPattern,
    (_match, prefix: string, _delimiter: string, code: string | undefined) => {
      if (code === undefined) return protectLiteral('\u0000');
      return `${prefix === '\u0000' ? protectLiteral(prefix) : prefix}${protectLiteral(code)}`;
    });
  const previewText = options?.omitRolePrefixes
    ? protectedText.replace(/^(?:User|Assistant):[ \t]+/gm, '')
    : protectedText;
  return previewText
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // Underscore emphasis never opens or closes inside a word (CommonMark), so PROBE_OK_2 and snake_case stay whole.
    .replace(/(^|[^\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^---+$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, (marker) => options?.preserveOrderedListNumbers ? marker : '')
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => literals[Number(index)]!)
    .replace(/\s+/g, ' ')
    .trim();
}

/** First prose paragraph, without headings or fenced code; the consuming surface owns truncation. */
export function firstMarkdownProse(text: string): string {
  const lines = text.split(/\r?\n/);
  const paragraph: string[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim().replace(/^(?:>\s*)+/, '');
    const fenceMarker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (fenceMarker?.[0] === fence[0] && fenceMarker.length >= fence.length) fence = undefined;
      continue;
    }
    const isHeading = /^#{1,6}(?:\s|$)/.test(line)
      || (line.length > 0 && /^\s*(?:=+|-+)\s*$/.test(lines[index + 1] ?? ''));
    const isRule = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|=+)$/.test(line);
    if (!line || fenceMarker || isHeading || isRule) {
      if (paragraph.length > 0) break;
      if (fenceMarker) fence = fenceMarker;
      continue;
    }
    const prose = stripMarkdown(line.replace(/^\d+[.)]\s+/, ''));
    if (prose) paragraph.push(prose);
  }
  return paragraph.join(' ');
}
