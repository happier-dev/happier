import { join, resolve, sep } from 'node:path';

import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

const DARWIN_BACKGROUND_SERVICE_PROTECTED_HOME_DIR_NAMES = ['Desktop', 'Documents', 'Downloads'] as const;

function trimTrailingSeparators(value: string): string {
  if (value === sep) return value;
  return value.replace(new RegExp(`${sep}+$`), '');
}

function isPathWithinDirectory(path: string, directory: string): boolean {
  const normalizedPath = trimTrailingSeparators(resolve(path));
  const normalizedDirectory = trimTrailingSeparators(resolve(directory));
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}${sep}`);
}

export function resolveDarwinBackgroundServiceSpawnDirectoryFailure(params: Readonly<{
  directory: string;
  startupSource: DaemonStartupSource;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>): string | null {
  if ((params.platform ?? process.platform) !== 'darwin') {
    return null;
  }
  if (params.startupSource !== 'background-service') {
    return null;
  }

  const homeDir = expandHomeDirPath('~', params.env);
  const matchedProtectedRoot = DARWIN_BACKGROUND_SERVICE_PROTECTED_HOME_DIR_NAMES
    .map((name) => join(homeDir, name))
    .find((protectedRoot) => isPathWithinDirectory(params.directory, protectedRoot));

  if (!matchedProtectedRoot) {
    return null;
  }

  return [
    `macOS background-service daemons cannot safely start a session inside protected home directories such as '${matchedProtectedRoot}'.`,
    `The requested working directory '${params.directory}' is inside that protected area and may hang before startup due to macOS Files & Folders privacy restrictions.`,
    'Choose a workspace outside Desktop/Documents/Downloads, or run a terminal-launched daemon/session after granting the necessary macOS access.',
  ].join(' ');
}
