import { mkdir } from 'node:fs/promises';

import { ensureCliDistSnapshotEntrypoint } from '../process/cliDist';
import { repoRootDir } from '../paths';
import { resolveVitestGlobalSetupPaths } from './globalSetupPaths';

export default async function globalSetupCoreFast(): Promise<void> {
  const rootDir = repoRootDir();
  const paths = resolveVitestGlobalSetupPaths({ rootDir, lane: 'core-fast', env: process.env });
  await mkdir(paths.setupDir, { recursive: true });

  await ensureCliDistSnapshotEntrypoint(
    {
      testDir: paths.setupDir,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: process.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? 'symlink',
      },
    },
    {
      snapshotDir: paths.snapshotDir,
      lockPath: paths.lockPath,
      repoRoot: rootDir,
      skipDistIntegrityCheck: true,
      skipSourceFreshnessCheck: true,
    },
  );
}
