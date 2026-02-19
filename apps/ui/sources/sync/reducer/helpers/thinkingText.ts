export function normalizeThinkingChunk(chunk: string): string {
  let text = chunk.replace(/\r\n/g, '\n');

  // Avoid pathological vertical spacing from repeated newlines.
  text = text.replace(/\n{3,}/g, '\n\n');

  const lines = text.split('\n');
  const hasStructuredMarkdown = lines.some((line) => {
    const trimmed = line.trimStart();
    return (
      trimmed.startsWith('- ') ||
      trimmed.startsWith('* ') ||
      /^\d+\.\s/.test(trimmed) ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('```')
    );
  });

  // Only collapse newlines when the chunk looks like a word-per-line delta stream.
  // This preserves intentional formatting like lists and code blocks.
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const isWordPerLine =
    !hasStructuredMarkdown &&
    nonEmptyLines.length >= 1 &&
    nonEmptyLines.every((line) => {
      const trimmed = line.trim();
      // Exclude code-ish punctuation (e.g. `constx=1;`) which should preserve line breaks.
      if (/[=;{}[\]()<>]/.test(trimmed)) return false;
      return trimmed.length <= 40 && !/\s/.test(trimmed);
    });

  if (!isWordPerLine) return text;

  // Preserve paragraph breaks, but collapse single newlines into spaces for readability.
  return text.replace(/\n+/g, (m) => (m.length >= 2 ? '\n\n' : ' '));
}

export function unwrapThinkingText(text: string): string {
  // Legacy support: older UI versions wrapped reducer thinking text as markdown:
  // `*Thinking...*\n\n*${body}*`
  const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
  return match ? match[1] : text;
}
