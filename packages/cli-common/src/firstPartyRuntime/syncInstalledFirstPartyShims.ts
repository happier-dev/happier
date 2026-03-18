import { copyFile, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';

export interface SyncInstalledFirstPartyShimsResult {
  shimPaths: string[];
}

export async function syncInstalledFirstPartyShims(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<SyncInstalledFirstPartyShimsResult> {
  const paths = resolveInstalledFirstPartyComponentPaths({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });

  await Promise.all(paths.shimPaths.map(async (shimPath) => {
    await mkdir(dirname(shimPath), { recursive: true });
    await rm(shimPath, { force: true, recursive: true });

    if (process.platform === 'win32') {
      await copyFile(paths.binaryPath, shimPath);
      return;
    }

    await symlink(relative(dirname(shimPath), paths.binaryPath), shimPath);
  }));

  return {
    shimPaths: paths.shimPaths,
  };
}
