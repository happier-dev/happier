import { mkdir } from 'node:fs/promises';

import { ensureCliDistSnapshotEntrypoint } from '../process/cliDist';
import { shouldUseCliSourceEntrypoint } from '../process/cliLaunchSpec';
import { resolveVitestGlobalSetupPaths, type VitestGlobalSetupLane } from './globalSetupPaths';

type PrepareCliForGlobalSetupParams = Readonly<{
  rootDir: string;
  lane: VitestGlobalSetupLane;
  env: NodeJS.ProcessEnv;
}>;

export async function prepareCliForGlobalSetup(
  params: PrepareCliForGlobalSetupParams,
): Promise<void> {
  if (shouldUseCliSourceEntrypoint(params.env)) return;

  const paths = resolveVitestGlobalSetupPaths({
    rootDir: params.rootDir,
    lane: params.lane,
    env: params.env,
  });

  await mkdir(paths.setupDir, { recursive: true });
  await ensureCliDistSnapshotEntrypoint(
    {
      testDir: paths.setupDir,
      env: {
        ...params.env,
        CI: params.env.CI ?? '1',
        HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE:
          params.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? 'symlink',
      },
    },
    {
      snapshotDir: paths.snapshotDir,
      lockPath: paths.lockPath,
      repoRoot: params.rootDir,
      skipDistIntegrityCheck: true,
      skipSourceFreshnessCheck: true,
    },
  );
}
