import { homedir as defaultHomedir } from 'node:os';
import { posix, win32 } from 'node:path';

function readEffectiveHomeDirectory(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
}>): string | null {
  const candidates = params.platform === 'win32'
    ? [
        params.env.USERPROFILE,
        params.env.HOMEDRIVE && params.env.HOMEPATH
          ? `${params.env.HOMEDRIVE}${params.env.HOMEPATH}`
          : undefined,
        params.env.HOME,
        params.homedir(),
      ]
    : [params.env.HOME, params.homedir()];
  const home = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof home === 'string' ? home.trim() : null;
}

function createCursorProjectDirectoryName(directory: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.normalize(path.resolve(directory))
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolves the provider-owned Cursor assets directory for one active workspace.
 * The returned path is only a declaration candidate; host media policy still
 * canonicalizes, authorizes, and revokes it for the runtime session.
 */
export function resolveCursorGeneratedMediaRoot(params: Readonly<{
  directory: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}>): string | null {
  const platform = params.platform ?? process.platform;
  const home = readEffectiveHomeDirectory({
    env: params.env ?? process.env,
    platform,
    homedir: params.homedir ?? defaultHomedir,
  });
  const projectDirectoryName = createCursorProjectDirectoryName(params.directory, platform);
  if (!home || !projectDirectoryName) return null;

  const path = platform === 'win32' ? win32 : posix;
  return path.join(home, '.cursor', 'projects', projectDirectoryName, 'assets');
}
