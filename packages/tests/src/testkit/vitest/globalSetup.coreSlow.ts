import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ensureCliDistSnapshotEntrypoint, ensureCliSharedDepsBuilt } from '../process/cliDist';
import { shouldUseCliSourceEntrypoint } from '../process/cliLaunchSpec';
import { repoRootDir } from '../paths';

export default async function globalSetupCoreSlow(): Promise<void> {
  const rootDir = repoRootDir();
  const setupDir = resolve(rootDir, '.project', 'tmp', 'vitest-global-setup', 'core-slow');
  await mkdir(setupDir, { recursive: true });

  if (shouldUseCliSourceEntrypoint(process.env)) {
    await ensureCliSharedDepsBuilt({ testDir: setupDir, env: process.env }, { repoRoot: rootDir });
    return;
  }

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
      // This prewarm exists to keep per-test timeouts focused on test behavior. Mirror daemon E2E usage.
      skipDistIntegrityCheck: true,
      skipSourceFreshnessCheck: true,
    },
  );
}
