import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  if (shouldUseCliSourceEntrypoint(params.env)) {
    const pluginIds = params.env.HAPPIER_E2E_SOURCE_PLUGIN_ARTIFACTS?.split(',').filter(Boolean) ?? [];
    if (pluginIds.length > 0) {
      const [{ BUNDLED_FIRST_PARTY_PLUGIN_METADATA }, { prepareSourceCliPluginUiArtifacts }] = await Promise.all([
        import('../../../../../apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests'),
        import('../../../../../apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs'),
      ]);
      const workspaceNames = pluginIds.map(pluginId => {
        const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(plugin => plugin.pluginId === pluginId);
        if (!metadata) throw new Error(`Unknown source plugin artifact: ${pluginId}`);
        return `plugins-${metadata.pluginPackageId}`;
      });
      // Account execution needs package-local compiled graphs even when the CLI runs from source.
      const result = await prepareSourceCliPluginUiArtifacts({ repoRoot: params.rootDir, workspaceNames });
      if (result?.pluginFailures.length) {
        const failures = result.pluginFailures.map(({ packageName, diagnostic }) =>
          `${packageName}: ${diagnostic.code}: ${diagnostic.message}`);
        throw new Error(`Source CLI Plugin UI preparation failed:\n${failures.join('\n')}`);
      }
    }
    return;
  }

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
