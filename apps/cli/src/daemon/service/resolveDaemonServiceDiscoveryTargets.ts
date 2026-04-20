import type { DaemonServiceMode } from './plan';
import { resolveLinuxSystemUserPaths } from './resolveLinuxSystemUserPaths';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

export function resolveDaemonServiceDiscoveryTargets(params: Readonly<{
  platform: SupportedPlatform;
  mode: DaemonServiceMode | undefined;
  userHomeDir: string;
  happierHomeDir: string;
}>): readonly Readonly<{
  mode: DaemonServiceMode;
  userHomeDir: string;
  happierHomeDir: string;
}>[] {
  const discoveryModes: readonly DaemonServiceMode[] = params.platform === 'linux' ? ['user', 'system'] : ['user'];
  if (params.platform !== 'linux' || params.mode !== 'system') {
    return discoveryModes.map((mode) => ({
      mode,
      userHomeDir: params.userHomeDir,
      happierHomeDir: params.happierHomeDir,
    }));
  }

  const sudoUser = String(process.env.SUDO_USER ?? '').trim();
  const invokerPaths = sudoUser
    ? (() => {
        try {
          return resolveLinuxSystemUserPaths({ systemUser: sudoUser });
        } catch {
          return null;
        }
      })()
    : null;

  return discoveryModes.map((mode) => ({
    mode,
    userHomeDir: mode === 'user' ? (invokerPaths?.userHomeDir ?? params.userHomeDir) : params.userHomeDir,
    happierHomeDir: mode === 'user' ? (invokerPaths?.happierHomeDir ?? params.happierHomeDir) : params.happierHomeDir,
  }));
}
