import { buildLaunchdPath } from '@/daemon/service/darwin';
import { buildServicePath } from '@happier-dev/cli-common/service';

export function ensureDaemonPath(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execPath: string;
}>): Readonly<{ changed: boolean; path: string }> {
  const current = typeof params.env.PATH === 'string' ? params.env.PATH : '';
  const homeDir = typeof params.env.HOME === 'string' ? params.env.HOME.trim() : '';

  const next = (() => {
    if (params.platform === 'darwin') {
      return buildLaunchdPath({ execPath: params.execPath, basePath: current, homeDir });
    }
    if (params.platform === 'linux') {
      return buildServicePath({ execPath: params.execPath, basePath: current, homeDir });
    }
    return current;
  })();

  const changed = next !== current;
  if (changed) {
    params.env.PATH = next;
  }
  return { changed, path: next };
}
