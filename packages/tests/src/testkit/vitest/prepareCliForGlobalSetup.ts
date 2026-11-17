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
      const [{ BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS, BUNDLED_FIRST_PARTY_PLUGIN_METADATA },
        { buildUniversalPluginUiArtifacts }, { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource }] = await Promise.all([
        import('../../../../../apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests'),
        import('../../../../plugin-sdk/src/ui/build/buildUniversalUiArtifacts'),
        import('../../../../cli-common/sourceRuntimeEntries.mjs'),
      ]);
      const packages = await readWorkspacePackages(params.rootDir);
      for (const pluginId of pluginIds) {
        const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(plugin => plugin.pluginId === pluginId);
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(plugin => plugin.pluginId === pluginId);
        if (!metadata || !locator || !('manifestRelativePath' in locator)) throw new Error(`Unknown source plugin artifact: ${pluginId}`);
        // Account execution consumes compiled graphs even when the CLI itself runs from source.
        // Global setup runs before collection can retain a bundled declaration's graph.
        await buildUniversalPluginUiArtifacts(resolve(params.rootDir, 'packages/plugins', metadata.pluginPackageId),
          resolve(params.rootDir, 'apps/cli', locator.manifestRelativePath), {
            exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
              ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
          });
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
