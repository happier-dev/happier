/** @moduleRealm daemon */
import {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/cli-common/path';
import { realpath, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const realpathAsync = promisify(realpath);

export { resolveHomeDirFromEnvironment };

export function expandHomePath(raw: string, homeDir?: string): string {
  const trimmed = raw.trim();
  return homeDir === undefined
    ? expandHomeDirPath(trimmed)
    : expandHomeDirPath(trimmed, { HOME: homeDir, USERPROFILE: homeDir });
}

export function resolveConfiguredPath(raw: string, input: Readonly<{
  homeDir?: string;
  cwd?: string;
  relativeTo?: string;
}> = {}): string {
  const expanded = expandHomePath(raw, input.homeDir);
  if (isAbsolute(expanded)) return resolve(expanded);
  const base = input.relativeTo ? dirname(input.relativeTo) : input.cwd;
  return resolve(base ?? process.cwd(), expanded);
}

export async function canonicalizePath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpathAsync(resolved);
  } catch {
    return resolved;
  }
}

export function canonicalizePathSync(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
