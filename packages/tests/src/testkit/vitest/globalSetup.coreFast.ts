import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ensureCliDistSnapshotEntrypoint } from '../process/cliDist';
import { repoRootDir } from '../paths';

export default async function globalSetupCoreFast(): Promise<void> {
  const rootDir = repoRootDir();
  const setupDir = resolve(rootDir, '.project', 'tmp', 'vitest-global-setup', 'core-fast');
  await mkdir(setupDir, { recursive: true });

  await ensureCliDistSnapshotEntrypoint(
    {
      testDir: setupDir,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: process.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? 'symlink',
      },
    },
    {
      snapshotDir: resolve(rootDir, '.project', 'tmp', 'cli-dist-snapshot'),
      repoRoot: rootDir,
      skipDistIntegrityCheck: true,
      skipSourceFreshnessCheck: true,
    },
  );
}
