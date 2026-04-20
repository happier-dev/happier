import { posix, win32 } from 'node:path';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export const MACHINE_RPC_WORKING_DIRECTORY_ENV = 'HAPPIER_MACHINE_RPC_WORKING_DIRECTORY';

export type FilesystemAccessPolicy =
  | Readonly<{ kind: 'osUser' }>
  | Readonly<{ kind: 'restrictedRoots'; roots: readonly string[] }>;

export const OS_USER_FILESYSTEM_ACCESS_POLICY: FilesystemAccessPolicy = { kind: 'osUser' };

export class FilesystemAccessPolicyConfigurationError extends Error {
  readonly invalidRoots: readonly string[];

  constructor(message: string, invalidRoots: readonly string[]) {
    super(message);
    this.name = 'FilesystemAccessPolicyConfigurationError';
    this.invalidRoots = invalidRoots;
  }
}

type ResolveFilesystemAccessPolicyInput = Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>;

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

export function isFilesystemPathAbsolute(pathValue: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathApi(platform).isAbsolute(pathValue);
}

export function normalizeFilesystemPathForPolicy(
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApi(platform);
  return api.normalize(api.resolve(pathValue));
}

export function filesystemPathComparisonKey(
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeFilesystemPathForPolicy(pathValue, platform);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function resolveFilesystemAccessPolicy(
  input: ResolveFilesystemAccessPolicyInput = {},
): FilesystemAccessPolicy {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const raw = typeof env[MACHINE_RPC_WORKING_DIRECTORY_ENV] === 'string'
    ? String(env[MACHINE_RPC_WORKING_DIRECTORY_ENV])
    : '';

  if (raw.trim().length === 0) {
    return OS_USER_FILESYSTEM_ACCESS_POLICY;
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  const invalidEntries: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const expanded = expandHomeDirPath(trimmed, env);
    if (!isFilesystemPathAbsolute(expanded, platform)) {
      invalidEntries.push(trimmed);
      continue;
    }
    const normalized = normalizeFilesystemPathForPolicy(expanded, platform);
    const key = filesystemPathComparisonKey(normalized, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(normalized);
  }

  if (invalidEntries.length > 0 || roots.length === 0) {
    throw new FilesystemAccessPolicyConfigurationError(
      `${MACHINE_RPC_WORKING_DIRECTORY_ENV} must contain only absolute directories`,
      invalidEntries.length > 0 ? invalidEntries : raw.split(',').map((entry) => entry.trim()).filter(Boolean),
    );
  }

  return { kind: 'restrictedRoots', roots };
}
