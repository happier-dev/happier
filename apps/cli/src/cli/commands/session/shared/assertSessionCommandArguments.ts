type SessionCommandArgumentPolicy = Readonly<{
  usage: string;
  startIndex: number;
  booleanFlags?: readonly string[];
  valueFlags?: readonly string[];
  inlineValueFlags?: readonly string[];
  allowMissingValueFlags?: readonly string[];
  maxPositionals?: number;
}>;

function invalidSessionCommandArguments(
  usage: string,
  reason: string,
): Error & { code: 'invalid_arguments' } {
  const error = new Error(`${reason}\n${usage}`) as Error & { code: 'invalid_arguments' };
  error.code = 'invalid_arguments';
  return error;
}

/**
 * Command-local validation for session CLI surfaces. The shared positional
 * reader intentionally skips flags so it can be reused by varied commands;
 * callers using it reject flags they do not own before any Action.
 */
export function assertSessionCommandArguments(
  argv: readonly string[],
  policy: SessionCommandArgumentPolicy,
): void {
  const booleanFlags = new Set(policy.booleanFlags ?? []);
  const valueFlags = new Set(policy.valueFlags ?? []);
  const inlineValueFlags = new Set(policy.inlineValueFlags ?? policy.valueFlags ?? []);
  const allowMissingValueFlags = new Set(policy.allowMissingValueFlags ?? []);
  let positionalOnly = false;
  let positionalCount = 0;

  for (let index = policy.startIndex; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (positionalOnly) {
      positionalCount += 1;
      if (policy.maxPositionals !== undefined && positionalCount > policy.maxPositionals) {
        throw invalidSessionCommandArguments(policy.usage, `Unexpected argument: ${argument}`);
      }
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (!argument.startsWith('-')) {
      positionalCount += 1;
      if (policy.maxPositionals !== undefined && positionalCount > policy.maxPositionals) {
        throw invalidSessionCommandArguments(policy.usage, `Unexpected argument: ${argument}`);
      }
      continue;
    }
    if (!argument.startsWith('--')) {
      throw invalidSessionCommandArguments(policy.usage, `Unknown option: ${argument}`);
    }

    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    if (booleanFlags.has(flag)) {
      if (equalsIndex >= 0) {
        throw invalidSessionCommandArguments(policy.usage, `Option ${flag} does not accept a value.`);
      }
      continue;
    }
    if (!valueFlags.has(flag)) {
      throw invalidSessionCommandArguments(policy.usage, `Unknown option: ${argument}`);
    }

    if (equalsIndex >= 0) {
      if (!inlineValueFlags.has(flag)) {
        throw invalidSessionCommandArguments(policy.usage, `Option ${flag} does not accept an inline value.`);
      }
      if (argument.slice(equalsIndex + 1).trim().length === 0) {
        throw invalidSessionCommandArguments(policy.usage, `Option ${flag} requires a value.`);
      }
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      if (allowMissingValueFlags.has(flag)) continue;
      throw invalidSessionCommandArguments(policy.usage, `Option ${flag} requires a value.`);
    }
    index += 1;
  }
}
