import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listBundledPluginUiArtifactExports } from '../../ui/scripts/generateBundledPluginUiArtifacts.mjs';
import { readIndexedBundledDeclarationManifest } from '../src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { bundledPluginManifestAssetRelativePath } from './build-owned/bundledPlugins/manifestAssetPath.mjs';

/** Source CLI locators read workspace package roots. Materialize their graphs
 * from the CLI's own bundled declarations through the shared source compiler.
 * Return per-plugin failures so optional hosts can keep healthy graphs available. */
export async function prepareSourceCliPluginUiArtifacts({ repoRoot, workspaceNames, pluginFailures = [] }) {
  const excluded = new Set(pluginFailures.map(failure => failure.packageName));
  const plugins = [];
  const artifactOutputDirs = {};
  for (const workspaceName of workspaceNames) {
    if (!workspaceName.startsWith('plugins-') || excluded.has(`@happier-dev/${workspaceName}`)) continue;
    const directory = workspaceName.slice('plugins-'.length);
    const root = resolve(repoRoot, 'packages/plugins', directory);
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    if (listBundledPluginUiArtifactExports(packageJson).length === 0) continue;
    plugins.push({ directory, loadManifest: () => readIndexedBundledDeclarationManifest(
      resolve(repoRoot, 'apps/cli', bundledPluginManifestAssetRelativePath(directory)),
    ) });
    artifactOutputDirs[directory] = resolve(root, 'dist/happier-plugin-ui');
  }
  if (plugins.length === 0) return null;
  await import('../../../packages/cli-common/registerSourceRuntime.mjs');
  const { prepareSourcePluginUiArtifacts } = await import('../../ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  return await prepareSourcePluginUiArtifacts({ repoRoot, plugins, artifactOutputDirs,
    outputDir: resolve(repoRoot, '.project/tmp/source-cli-plugin-ui') });
}
