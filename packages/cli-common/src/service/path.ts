import { dirname, join, win32 as win32Path } from 'node:path';

const POSIX_FALLBACK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const DARWIN_DEFAULT_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin';
const WINDOWS_FALLBACK_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\';

function normalizePlatform(platform: string | null | undefined): NodeJS.Platform {
  const raw = String(platform ?? '').trim();
  return (raw || process.platform) as NodeJS.Platform;
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function defaultPathForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return DARWIN_DEFAULT_PATH;
  if (platform === 'win32') return WINDOWS_FALLBACK_PATH;
  return POSIX_FALLBACK_PATH;
}

function splitPath(pathValue: string, delimiter: string): string[] {
  return String(pathValue ?? '')
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function dirnameForPlatform(pathValue: string, platform: NodeJS.Platform): string {
  if (!pathValue) return '';
  return platform === 'win32' ? win32Path.dirname(pathValue) : dirname(pathValue);
}

function joinHomeBin(pathValue: string, platform: NodeJS.Platform): string[] {
  const homeDir = String(pathValue ?? '').trim();
  if (!homeDir) return [];
  if (platform === 'win32') {
    return [win32Path.join(homeDir, 'bin')];
  }
  return [join(homeDir, '.local', 'bin'), join(homeDir, 'bin')];
}

export function buildServicePath(params: Readonly<{
  execPath?: string;
  basePath?: string;
  homeDir?: string;
  defaultPath?: string;
  platform?: NodeJS.Platform;
}> = {}): string {
  const platform = normalizePlatform(params.platform);
  const delimiter = pathDelimiterForPlatform(platform);
  const execPath = String(params.execPath ?? '').trim();
  const basePath = String(params.basePath ?? process.env.PATH ?? '').trim();
  const defaults = splitPath(String(params.defaultPath ?? defaultPathForPlatform(platform)), delimiter);
  const fromExec = execPath ? [dirnameForPlatform(execPath, platform)] : [];
  const fromEnv = splitPath(basePath, delimiter);
  const fromHome = joinHomeBin(String(params.homeDir ?? '').trim(), platform);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...fromExec, ...fromEnv, ...fromHome, ...defaults]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(delimiter) || defaultPathForPlatform(platform);
}

export function mergeServiceEnvWithPath(params: Readonly<{
  env?: Record<string, string>;
  execPath?: string;
  basePath?: string;
  homeDir?: string;
  defaultPath?: string;
  platform?: NodeJS.Platform;
}> = {}): Record<string, string> {
  const env = { ...(params.env ?? {}) };
  const platform = normalizePlatform(params.platform);
  const pathLikeKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  const canonicalPathKey =
    platform === 'win32'
      ? (pathLikeKeys[0] ?? 'Path')
      : 'PATH';
  const existingPathValue =
    platform === 'win32'
      ? String((pathLikeKeys[0] ? env[pathLikeKeys[0]] : '') ?? '').trim()
      : String(env.PATH ?? env.Path ?? env.path ?? '').trim();

  for (const key of pathLikeKeys) {
    if (key !== canonicalPathKey) {
      delete env[key];
    }
  }

  if (existingPathValue) {
    env[canonicalPathKey] = existingPathValue;
    return env;
  }

  env[canonicalPathKey] = buildServicePath({
    execPath: params.execPath,
    basePath: params.basePath,
    homeDir: params.homeDir,
    defaultPath: params.defaultPath,
    platform,
  });
  return env;
}
