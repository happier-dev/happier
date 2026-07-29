import { ProviderCliError } from './types';

const RAW_SECRET_FLAGS = new Set(['--api-key', '--token', '--secret', '--password']);
const BOOLEAN_FLAGS = new Set([
  '--available',
  '--automatic-name',
  '--clear-endpoint',
  '--custom',
  '--json',
]);

function optionArguments(args: readonly string[]): readonly string[] {
  const terminatorIndex = args.indexOf('--');
  return terminatorIndex < 0 ? args : args.slice(0, terminatorIndex);
}

export function assertNoRawSecretArguments(args: readonly string[]): void {
  for (const value of args) {
    const flag = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (RAW_SECRET_FLAGS.has(flag)) {
      throw new ProviderCliError(
        'raw_secret_argv_forbidden',
        'Raw secrets are forbidden in command arguments; use --saved-secret-id or interactive no-echo entry',
      );
    }
  }
}

export function readRawFlag(args: readonly string[], flag: string): string | null {
  const options = optionArguments(args);
  const occurrences = options.flatMap((value, index) =>
    value === flag || value.startsWith(`${flag}=`) ? [{ value, index }] : []);
  if (occurrences.length > 1) throw new ProviderCliError('duplicate_flag', `${flag} may be specified only once`);
  const occurrence = occurrences[0];
  if (!occurrence) return null;
  if (occurrence.value.startsWith(`${flag}=`)) {
    return occurrence.value.slice(flag.length + 1);
  }
  const value = options[occurrence.index + 1];
  if (value === undefined || value.startsWith('--')) throw new ProviderCliError('invalid_arguments', `${flag} requires a value`);
  return value;
}

export function readFlag(args: readonly string[], flag: string): string | null {
  const value = readRawFlag(args, flag);
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized) throw new ProviderCliError('invalid_arguments', `${flag} requires a value`);
  return normalized;
}

export function assertOnlyAllowedFlags(args: readonly string[], allowedFlags: ReadonlySet<string>): void {
  for (const value of optionArguments(args)) {
    if (!value.startsWith('--')) continue;
    const flag = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (!allowedFlags.has(flag)) {
      throw new ProviderCliError('invalid_arguments', `Unsupported provider option '${flag}'`);
    }
    if (BOOLEAN_FLAGS.has(flag) && value !== flag) {
      throw new ProviderCliError('invalid_arguments', `${flag} does not accept a value`);
    }
  }
}

export function hasFlag(args: readonly string[], flag: string): boolean {
  return optionArguments(args).includes(flag);
}

export function positionalArgs(args: readonly string[]): string[] {
  const values: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!optionsEnded && value === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith('--')) {
      if (!value.includes('=') && !BOOLEAN_FLAGS.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}
