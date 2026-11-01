/** Whether the Session already has a title that automatic initialization must preserve. */
export function hasSessionTitleInMetadata(sessionMetadata: unknown): boolean {
  const metadata = sessionMetadata && typeof sessionMetadata === 'object' && !Array.isArray(sessionMetadata)
    ? sessionMetadata as Record<string, unknown>
    : null;
  const summary = metadata?.summary;
  const summaryText = summary && typeof summary === 'object' && !Array.isArray(summary) && 'text' in summary
    ? summary.text
    : null;
  // summary.text is the title writer's current shape; name also covers legacy named Sessions.
  return [summaryText, metadata?.name].some((title) => typeof title === 'string' && title.trim().length > 0);
}
