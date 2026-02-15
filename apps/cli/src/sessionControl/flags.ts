export function wantsJson(argv: string[]): boolean {
  return argv.includes('--json');
}

export function wantsIncludeStructured(argv: string[]): boolean {
  return argv.includes('--include-structured') || argv.includes('--includeStructured');
}

export function readFlagValue(argv: string[], flag: string): string | null {
  const idx = argv.findIndex((value) => value === flag);
  if (idx < 0) return null;
  const next = argv[idx + 1];
  if (typeof next !== 'string') return null;
  const value = next.trim();
  return value.length > 0 ? value : null;
}

export function readPositiveIntFlag(argv: string[], flag: string): number | null {
  const raw = readFlagValue(argv, flag);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

