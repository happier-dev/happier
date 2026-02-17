export function parseOptionalBooleanEnv(raw: unknown): boolean | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return null;
}

export function parseBooleanEnv(raw: unknown, fallback: boolean): boolean {
  const parsed = parseOptionalBooleanEnv(raw);
  return parsed === null ? fallback : parsed;
}

