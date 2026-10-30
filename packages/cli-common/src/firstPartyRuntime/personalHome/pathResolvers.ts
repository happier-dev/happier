import { fileURLToPath } from 'node:url';
import { posix, win32 } from 'node:path';

import { expandHomeDirPath } from '../../path/expandHomeDirPath.js';

/**
 * Resolves the on-disk root used by the server's local private-files backend.
 *
 * This deliberately lives in cli-common so the runtime layout and the server
 * adapter consume one contract without either package importing the other's
 * implementation. Current HAPPIER names are authoritative; HAPPY aliases are
 * read only when the corresponding current name is absent.
 */
export function resolvePersonalHomePrivateFilesDir(params: Readonly<{
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}>): string {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const explicit = expandHomeDirPath(
    resolveManagedServerLightPathEnvValue(
      env,
      'HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR',
      'HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR',
    ).trim(),
    env,
    platform,
  );
  const api = platform === 'win32' ? win32 : posix;
  const root = explicit || api.join(params.dataDir, 'private-files');
  return api.resolve(root);
}

export function resolveManagedServerLightPathEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  currentName:
    | 'HAPPIER_SERVER_LIGHT_DATA_DIR'
    | 'HAPPIER_SERVER_LIGHT_FILES_DIR'
    | 'HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR'
    | 'HAPPIER_SERVER_LIGHT_DB_DIR',
  legacyName:
    | 'HAPPY_SERVER_LIGHT_DATA_DIR'
    | 'HAPPY_SERVER_LIGHT_FILES_DIR'
    | 'HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR'
    | 'HAPPY_SERVER_LIGHT_DB_DIR',
): string {
  const current = env[currentName];
  return String(current !== undefined ? current : env[legacyName] ?? '');
}

/**
 * Converts the light server's Prisma SQLite URL to an absolute filesystem path.
 * Personal Home only supports SQLite; a different URL is rejected rather than
 * silently backing up a path that the managed runtime does not use.
 */
export function resolvePersonalHomeSqliteDatabasePath(params: Readonly<{
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}>): string {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const api = platform === 'win32' ? win32 : posix;
  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  const rawPath = databaseUrl.startsWith('file:') ? readFileUrlPath(databaseUrl, platform) : '';
  if (databaseUrl && !databaseUrl.startsWith('file:')) {
    throw new Error('Personal Home requires a local SQLite DATABASE_URL');
  }
  return api.resolve(rawPath || api.join(params.dataDir, 'happier-server-light.sqlite'));
}

function readFileUrlPath(databaseUrl: string, platform: NodeJS.Platform): string {
  const withoutQuery = databaseUrl.replace(/[?#].*$/u, '');
  try {
    const value = withoutQuery.slice('file:'.length);
    if (platform === 'win32' && /^[A-Za-z]:[\\/]/u.test(value)) { try { return decodeURIComponent(value); } catch { return value; } }
    const relative = value && !value.startsWith('/') && !value.startsWith('//') && !/^[A-Za-z]:[\\/]/u.test(value);
    if (relative) return value;
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'file:') return '';
    return fileURLToPath(parsed);
  } catch {
    const value = withoutQuery.slice('file:'.length);
    if (!value) return '';
    if (platform === 'win32' && /^\/+[A-Za-z]:[\\/]/u.test(value)) return value.replace(/^\/+/u, '');
    if (value.startsWith('//')) return value.replace(/^\/+/u, '/');
    return value;
  }
}
