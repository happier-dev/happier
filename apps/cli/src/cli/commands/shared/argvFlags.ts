export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function hasFlagValue(argv: readonly string[], flag: string): boolean {
  return argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
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
  const idx = argv.findIndex((value) => value === flag || value.startsWith(`${flag}=`));
  if (idx < 0) return null;
  const argument = argv[idx]!;
  const raw = argument === flag
    ? argv[idx + 1]
    : argument.slice(flag.length + 1);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readFlagValueUnlessFlagToken(argv: readonly string[], flag: string): string | null {
  const value = readFlagValue(argv, flag);
  return value !== null && !value.startsWith('-') ? value : null;
}

export function readRepeatedFlagValues(
  argv: readonly string[],
  flag: string,
  options: Readonly<{ valueName?: string }> = {},
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const raw = argument === flag
      ? argv[index + 1]
      : argument.startsWith(`${flag}=`)
        ? argument.slice(flag.length + 1)
        : null;
    if (raw === null) continue;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || value.startsWith('-')) {
      throw new Error(`${flag} requires a ${options.valueName ?? 'value'}`);
    }
    values.push(value);
    if (argument === flag) index += 1;
  }
  return Object.freeze(values);
}

export function readIntFlagValue(
  argv: readonly string[],
  flag: string,
  options: Readonly<{ min?: number; max?: number }> = {},
): number | null {
  if (!hasFlagValue(argv, flag)) return null;
  const raw = readFlagValue(argv, flag);
  const parsed = raw !== null && /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed)
    || (options.min !== undefined && parsed < options.min)
    || (options.max !== undefined && parsed > options.max)
  ) {
    const error = new Error(`Invalid ${flag}: expected an integer within the supported range.`);
    (error as Error & { code?: string }).code = 'invalid_arguments';
    throw error;
  }
  return parsed;
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
