export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function readCommandPositionals(
  argv: readonly string[],
  options: Readonly<{
    startIndex?: number;
    valueFlags?: readonly string[];
  }> = {},
): string[] {
  const positionals: string[] = [];
  const valueFlags = new Set(options.valueFlags ?? []);
  let positionalOnly = false;

  for (let index = options.startIndex ?? 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (positionalOnly) {
      positionals.push(value.trim());
      continue;
    }
    if (value === '--') {
      positionalOnly = true;
      continue;
    }
    if (value.startsWith('-')) {
      if (valueFlags.has(value)) index += 1;
      continue;
    }
    positionals.push(value.trim());
  }

  return positionals;
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
