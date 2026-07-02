function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolvePiConnectedServiceCandidatePersistedSessionFile(input: Readonly<{
  metadata: unknown;
}>): string | null {
  if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
    return null;
  }
  return normalizeOptionalString((input.metadata as { piSessionFile?: unknown }).piSessionFile);
}
