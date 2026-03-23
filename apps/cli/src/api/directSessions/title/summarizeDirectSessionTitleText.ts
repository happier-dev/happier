const DEFAULT_MAX_CHARS = 120;

export function summarizeDirectSessionTitleText(
  value: string,
  opts?: Readonly<{ maxChars?: number }>,
): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const maxChars = Math.max(16, Math.trunc(opts?.maxChars ?? DEFAULT_MAX_CHARS));
  if (normalized.length <= maxChars) return normalized;

  const truncated = normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return truncated ? `${truncated}…` : normalized.slice(0, maxChars);
}
