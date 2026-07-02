import { mkdir } from 'node:fs/promises';

import { ensureCliDistSnapshotEntrypoint } from '../process/cliDist';
import { repoRootDir } from '../paths';
import { resolveVitestGlobalSetupPaths } from './globalSetupPaths';

export default async function globalSetupCoreSlow(): Promise<void> {
  const rootDir = repoRootDir();
  const paths = resolveVitestGlobalSetupPaths({ rootDir, lane: 'core-slow', env: process.env });
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
      // This prewarm exists to keep per-test timeouts focused on test behavior. Mirror daemon E2E usage.
      skipDistIntegrityCheck: true,
      skipSourceFreshnessCheck: true,
    },
  );
}
