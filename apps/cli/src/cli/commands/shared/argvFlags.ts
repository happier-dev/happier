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

export type CommandArgumentPolicy = Readonly<{
  usage: string;
  startIndex: number;
  booleanFlags?: readonly string[];
  valueFlags?: readonly string[];
  inlineValueFlags?: readonly string[];
  allowMissingValueFlags?: readonly string[];
  maxPositionals?: number;
}>;

function invalidCommandArguments(usage: string, reason: string): Error & { code: 'invalid_arguments' } {
  return Object.assign(new Error(`${reason}\n${usage}`), { code: 'invalid_arguments' as const });
}

export function assertCommandArguments(argv: readonly string[], policy: CommandArgumentPolicy): void {
  const booleanFlags = new Set(policy.booleanFlags ?? []);
  const valueFlags = new Set(policy.valueFlags ?? []);
  const inlineValueFlags = new Set(policy.inlineValueFlags ?? policy.valueFlags ?? []);
  const allowMissingValueFlags = new Set(policy.allowMissingValueFlags ?? []);
  let positionalOnly = false;
  let positionalCount = 0;
  for (let index = policy.startIndex; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--') { positionalOnly = true; continue; }
    if (positionalOnly || !argument.startsWith('-')) {
      positionalCount += 1;
      if (policy.maxPositionals !== undefined && positionalCount > policy.maxPositionals) {
        throw invalidCommandArguments(policy.usage, `Unexpected argument: ${argument}`);
      }
      continue;
    }
    if (!argument.startsWith('--')) throw invalidCommandArguments(policy.usage, `Unknown option: ${argument}`);
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    if (booleanFlags.has(flag)) {
      if (equalsIndex >= 0) throw invalidCommandArguments(policy.usage, `Option ${flag} does not accept a value.`);
      continue;
    }
    if (!valueFlags.has(flag)) throw invalidCommandArguments(policy.usage, `Unknown option: ${argument}`);
    if (equalsIndex >= 0) {
      if (!inlineValueFlags.has(flag)) throw invalidCommandArguments(policy.usage, `Option ${flag} does not accept an inline value.`);
      if (!argument.slice(equalsIndex + 1).trim()) throw invalidCommandArguments(policy.usage, `Option ${flag} requires a value.`);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      if (allowMissingValueFlags.has(flag)) continue;
      throw invalidCommandArguments(policy.usage, `Option ${flag} requires a value.`);
    }
    index += 1;
  }
}
