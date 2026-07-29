export type MachineHomeDirPlatform = 'posix' | 'win32';

export type NormalizeMachineHomeDirOptions = Readonly<{
  homeDir?: string | null;
  platform?: MachineHomeDirPlatform;
}>;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function inferPlatform(value: string, fallback?: string | null): MachineHomeDirPlatform {
  const fallbackValue = readTrimmedString(fallback);
  if (fallbackValue) {
    return /^[a-zA-Z]:[\\/]/.test(fallbackValue)
      || /^[\\/]{2}[^\\/]/.test(fallbackValue)
      || fallbackValue.includes('\\')
      ? 'win32'
      : 'posix';
  }

  const candidate = `${value}\n${fallback ?? ''}`;
  return /^[a-zA-Z]:[\\/]/.test(candidate)
    || /^[\\/]{2}[^\\/]/.test(candidate)
    || candidate.includes('\\')
    ? 'win32'
    : 'posix';
}

function normalizeSeparators(value: string, platform: MachineHomeDirPlatform): string {
  if (platform === 'posix') {
    return value.replace(/[\\/]+/g, '/');
  }

  const isUnc = /^[\\/]{2}[^\\/]/.test(value);
  const normalized = value.replace(/[\\/]+/g, '\\');
  return isUnc ? `\\\\${normalized.replace(/^\\+/, '')}` : normalized;
}

function stripTrailingSeparators(value: string, platform: MachineHomeDirPlatform): string {
  if (platform === 'posix') {
    if (value === '/') return value;
    return value.replace(/\/+$/g, '') || '/';
  }

  if (/^[a-zA-Z]:\\$/.test(value)) return value;
  return value.replace(/\\+$/g, '');
}

function normalizeWithoutTildeExpansion(value: string, platform: MachineHomeDirPlatform): string {
  const withNormalizedSeparators = normalizeSeparators(value, platform);
  const withoutTrailingSeparators = stripTrailingSeparators(withNormalizedSeparators, platform);
  return platform === 'win32' ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function expandTilde(
  value: string,
  options: NormalizeMachineHomeDirOptions,
  platform: MachineHomeDirPlatform,
): string {
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) return value;

  const homeDir = readTrimmedString(options.homeDir);
  if (!homeDir || homeDir === '~' || homeDir.startsWith('~/') || homeDir.startsWith('~\\')) return '';

  const normalizedHome = normalizeWithoutTildeExpansion(homeDir, platform);
  if (!normalizedHome) return '';
  if (value === '~') return normalizedHome;

  const suffix = value.slice(2);
  const separator = platform === 'win32' ? '\\' : '/';
  return `${normalizedHome}${separator}${suffix}`;
}

export function normalizeMachineHomeDir(
  value: string | null | undefined,
  options: NormalizeMachineHomeDirOptions = {},
): string {
  const trimmed = readTrimmedString(value);
  if (!trimmed) return '';

  const platform = options.platform ?? inferPlatform(trimmed, options.homeDir);
  const expanded = expandTilde(trimmed, options, platform);
  if (!expanded) return '';

  return normalizeWithoutTildeExpansion(expanded, platform);
}

export function compareMachineHomeDirs(
  left: string | null | undefined,
  right: string | null | undefined,
  options: NormalizeMachineHomeDirOptions = {},
): boolean {
  const normalizedLeft = normalizeMachineHomeDir(left, options);
  const normalizedRight = normalizeMachineHomeDir(right, options);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}
