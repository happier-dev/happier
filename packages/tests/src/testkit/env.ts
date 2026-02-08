export function envFlag(name: string | string[], defaultValue = false): boolean {
  const names = Array.isArray(name) ? name : [name];
  for (const key of names) {
    const alt = resolveHappierHappyAlias(key);
    const raw = process.env[key] ?? (alt ? process.env[alt] : undefined);
    if (raw == null) continue;
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'y') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'n') return false;
    // Unrecognized value; fall through to the next candidate key (or the default).
    continue;
  }
  return defaultValue;
}

function resolveHappierHappyAlias(name: string): string | null {
  if (name.startsWith('HAPPIER_')) return `HAPPY_${name.slice('HAPPIER_'.length)}`;
  if (name.startsWith('HAPPY_')) return `HAPPIER_${name.slice('HAPPY_'.length)}`;
  return null;
}
