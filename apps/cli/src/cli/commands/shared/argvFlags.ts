export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function readFlagValue(argv: readonly string[], flag: string): string | null {
  const idx = argv.findIndex((value) => value === flag);
  if (idx < 0) return null;
  const raw = argv[idx + 1];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readIntFlagValue(argv: readonly string[], flag: string): number | null {
  const raw = readFlagValue(argv, flag);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

export function readJsonFlagValue(argv: readonly string[], flag: string): unknown | null {
  const raw = readFlagValue(argv, flag);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

