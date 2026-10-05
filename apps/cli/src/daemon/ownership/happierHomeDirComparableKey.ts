import { normalizeHomeDir } from '@happier-dev/cli-common/happierRuntime';

export { happierHomeDirsMatch } from '@happier-dev/cli-common/happierRuntime';

export function resolveHappierHomeDirComparableKey(
  homeDir: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return normalizeHomeDir(homeDir, platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux');
}
