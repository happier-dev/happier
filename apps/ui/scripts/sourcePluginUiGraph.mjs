import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { packageNameOfSpecifier, resolveWorkspaceSource } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { sourcePluginUiBuildOptions } from '../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { listBundledPluginUiArtifactExports } from './generateBundledPluginUiArtifacts.mjs';

// Ask the source compiler's resolver for its file graph, rather than treating
// every source file in an SDK dependency as an input of every plugin UI.
export async function readSourcePluginUiGraph({ repoDir, compiler, pluginDirectory, packages, resolveSourceImport }) {
  const owner = packages.get(`@happier-dev/plugins-${pluginDirectory}`);
  const entries = compiler ? [
    'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs',
  ].map(path => resolve(repoDir, path)).filter(existsSync) : owner ? [
    ...(owner.manifest.exports?.['./manifest'] ? [resolveWorkspaceSource(packages, `${owner.manifest.name}/manifest`)] : []),
    ...listBundledPluginUiArtifactExports(owner.manifest).map(path =>
      resolveWorkspaceSource(packages, `${owner.manifest.name}${path.slice(1)}`)),
  ] : [];
  if (entries.length === 0) return [];
  const { build } = await import('esbuild');
  const options = await sourcePluginUiBuildOptions({ repoRoot: repoDir, packages, resolveSourceImport });
  const inputs = new Set();
  try {
    const result = await build({
      absWorkingDir: repoDir, entryPoints: entries, outdir: resolve(repoDir, '.source-plugin-ui-graph'),
      bundle: true, write: false, metafile: true, platform: 'node', format: 'esm',
      packages: 'external', conditions: options.exportConditions, logLevel: 'silent',
      plugins: [{ name: 'source-plugin-ui-inputs', setup(builder) {
        builder.onLoad({ filter: /.*/ }, ({ path }) => { inputs.add(path); });
        builder.onResolve({ filter: /^[^./#]/ }, ({ path }) => {
          // Hosts are not inputs of portable plugin UI. This is the same
          // exclusion as the containing source-input inventory.
          const dependency = packages.get(packageNameOfSpecifier(path));
          if (dependency && relative(repoDir, dependency.root).split(sep)[0] === 'apps') return { path, external: true };
          const source = options.resolveSourceImport(path);
          return source ? { path: source } : undefined;
        });
      } }],
    });
    // Loaded but eliminated modules do not influence the compiler/artifact.
    // In particular, importing a pure dependency identity helper must not make
    // Stack's unrelated Expo lifecycle a compiler input.
    inputs.clear();
    for (const output of Object.values(result.metafile.outputs)) {
      for (const [path, input] of Object.entries(output.inputs)) {
        if (input.bytesInOutput > 0) inputs.add(resolve(repoDir, path));
      }
    }
  } catch (error) {
    // A broken plugin still contributes its observed inputs for repair. The
    // real compiler reports the failure within its per-plugin boundary; input
    // discovery must not prevent healthy sibling plugins from refreshing.
    if (!Array.isArray(error.errors)) throw error;
  }
  return [...inputs].map(path => relative(repoDir, resolve(repoDir, path)).split(sep).join('/'))
    .filter(path => !isAbsolute(path) && !path.startsWith('../') && !path.split('/').includes('node_modules'));
}
