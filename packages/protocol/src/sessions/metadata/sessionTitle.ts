/** A Happier Session title survives native Agent conversation replacement. */
export function readSessionTitleInMetadata(sessionMetadata: unknown): string | null {
  const metadata = sessionMetadata && typeof sessionMetadata === 'object' && !Array.isArray(sessionMetadata)
    ? sessionMetadata as Record<string, unknown>
    : null;
  const summary = metadata?.summary;
  const summaryText = summary && typeof summary === 'object' && !Array.isArray(summary) && 'text' in summary
    ? summary.text
    : null;
  // summary.text is current; name covers retained named Sessions.
  for (const title of [summaryText, metadata?.name]) {
    if (typeof title === 'string' && title.trim().length > 0) return title.trim();
  }
  return null;
}

export function hasSessionTitleInMetadata(sessionMetadata: unknown): boolean {
  return readSessionTitleInMetadata(sessionMetadata) !== null;
}
