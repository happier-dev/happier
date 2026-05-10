export function normalizeAccountSettingsVersion(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < 0) return null;
  return value;
}

export function normalizeAccountSettingsVersionHint(value: unknown): number | null {
  return normalizeAccountSettingsVersion(value);
}

export function isAccountSettingsVersionAtLeast(
  current: number | null | undefined,
  minimum: number | null | undefined,
): boolean {
  const normalizedMinimum = normalizeAccountSettingsVersion(minimum);
  if (normalizedMinimum === null) return true;
  const normalizedCurrent = normalizeAccountSettingsVersion(current);
  if (normalizedCurrent === null) return false;
  return normalizedCurrent >= normalizedMinimum;
}

export function readAccountSettingsVersionFromHint(hint: unknown): number | null {
  if (!hint || typeof hint !== 'object') return null;
  return normalizeAccountSettingsVersion((hint as { settingsVersion?: unknown }).settingsVersion);
}
