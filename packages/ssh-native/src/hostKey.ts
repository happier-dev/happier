export function normalizeHostKeyFingerprintSha256(value: string): string | null {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.replace(/^sha256:/i, '').trim();
  if (!withoutPrefix) return null;

  const withoutPadding = withoutPrefix.replace(/=+$/u, '');
  return withoutPadding ? `SHA256:${withoutPadding}` : null;
}
