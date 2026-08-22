import { resolve } from 'node:path';

import { resolveWorkspaceBundleLockPath } from '@happier-dev/cli-common/workspaceBundleLock';

export type VitestGlobalSetupLane = 'core-fast' | 'core-slow';

export type VitestGlobalSetupPaths = {
  setupDir: string;
  snapshotDir: string;
  lockPath: string;
};

function resolveE2eLogsRoot(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPIER_E2E_LOGS_DIR?.trim();
  return raw ? resolve(raw) : null;
}

export function resolveVitestGlobalSetupPaths(params: {
  rootDir: string;
  lane: VitestGlobalSetupLane;
  env: NodeJS.ProcessEnv;
}): VitestGlobalSetupPaths {
  const logsRoot = resolveE2eLogsRoot(params.env);
  if (logsRoot) {
    const setupDir = resolve(logsRoot, 'vitest-global-setup', params.lane);
    return {
      setupDir,
      snapshotDir: resolve(setupDir, 'cli-dist-snapshot'),
      lockPath: resolveWorkspaceBundleLockPath(params.rootDir),
    };
  }

  return {
    setupDir: resolve(params.rootDir, '.project', 'tmp', 'vitest-global-setup', params.lane),
    snapshotDir: resolve(params.rootDir, '.project', 'tmp', 'cli-dist-snapshot'),
    lockPath: resolveWorkspaceBundleLockPath(params.rootDir),
  };
}
