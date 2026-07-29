import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

export function resolveHomeDirFromEnvironment(
  processEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const envHome =
    platform === 'win32'
      ? (processEnv.USERPROFILE || processEnv.HOME)
      : processEnv.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

export function expandHomeDirPath(
  value: string,
  processEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApi(platform);
  if (value === '~') return resolveHomeDirFromEnvironment(processEnv, platform);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const relativePathSegments = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    return api.join(resolveHomeDirFromEnvironment(processEnv, platform), ...relativePathSegments);
  }
  return value;
}
