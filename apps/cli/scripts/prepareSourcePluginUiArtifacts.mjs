import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listBundledPluginUiArtifactExports } from '../../ui/scripts/generateBundledPluginUiArtifacts.mjs';

/** Source CLI locators read workspace package roots. Materialize their graphs
 * through the same compiler used by retained daemon and native CLI roots. */
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
    plugins.push({ directory, loadManifest: async () => JSON.parse(
      await readFile(resolve(root, '.happier-plugin/plugin.json'), 'utf8'),
    ) });
    artifactOutputDirs[directory] = resolve(root, 'dist/happier-plugin-ui');
  }
  if (plugins.length === 0) return null;
  await import('../../../packages/cli-common/registerSourceRuntime.mjs');
  const { prepareSourcePluginUiArtifacts } = await import('../../ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  const result = await prepareSourcePluginUiArtifacts({ repoRoot, plugins, artifactOutputDirs,
    outputDir: resolve(repoRoot, '.project/tmp/source-cli-plugin-ui') });
  if (result.pluginFailures.length > 0) {
    // Do not let the containing preparation stamp an unavailable graph as ready.
    // The next preparation request must run the compiler again after correction.
    throw Object.assign(new Error('Source Plugin UI artifact preparation failed'), {
      code: 'plugin_ui_artifact_invalid',
    });
  }
  return result;
}
