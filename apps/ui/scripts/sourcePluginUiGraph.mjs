import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { packageNameOfSpecifier, resolveWorkspaceSource } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { sourcePluginUiBuildOptions } from '../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { listBundledPluginUiArtifactExports } from './generateBundledPluginUiArtifacts.mjs';
import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from '../../../packages/protocol/src/plugins/ui/hostRuntimeExternals.ts';

// Ask the source compiler's resolver for its file graph, rather than treating
// every source file in an SDK dependency as an input of every plugin UI.
export async function readSourcePluginUiGraph({ repoDir, compiler, pluginDirectory, packages, resolveSourceImport, inventory = false }) {
  const owner = packages.get(`@happier-dev/plugins-${pluginDirectory}`);
  const entries = compiler ? [
    inventory ? 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs'
      : 'packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts',
  ].map(path => resolve(repoDir, path)).filter(existsSync) : owner ? [
    // The caller fingerprints the evaluated manifest value separately. Its
    // authoring graph does not become executable code in a UI artifact.
    ...(inventory && owner.manifest.exports?.['./manifest']
      ? [resolveWorkspaceSource(packages, `${owner.manifest.name}/manifest`)] : []),
    ...listBundledPluginUiArtifactExports(owner.manifest).map(path =>
      resolveWorkspaceSource(packages, `${owner.manifest.name}${path.slice(1)}`)),
  ] : [];
  if (entries.length === 0) return [];
  const { build } = await import('esbuild');
  const options = await sourcePluginUiBuildOptions({ repoRoot: repoDir, packages, resolveSourceImport });
  const hostExternals = new Set(compiler || inventory ? [] : PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS);
  const inputs = new Set();
  const sideEffectFree = new Set();
  const annotationInputs = new Set();
  const workspaceOwners = [...packages.values()].sort((a, b) => b.root.length - a.root.length);
  try {
    const result = await build({
      absWorkingDir: repoDir, entryPoints: entries, outdir: resolve(repoDir, '.source-plugin-ui-graph'),
      bundle: true, write: false, metafile: true, platform: 'node', format: 'esm',
      packages: 'external', conditions: options.exportConditions, logLevel: 'silent',
      plugins: [{ name: 'source-plugin-ui-inputs', setup(builder) {
        builder.onLoad({ filter: /.*/ }, async ({ path }) => {
          inputs.add(path);
          if (inventory) return;
          // Only the compiler's positive annotation permits omission: an
          // unannotated pure module can gain a top-level effect on the next edit.
          const resolved = await builder.resolve(path, { kind: 'import-statement', resolveDir: dirname(path) });
          if (resolved.sideEffects !== false) return;
          sideEffectFree.add(path);
          const workspace = workspaceOwners.find(owner => path.startsWith(`${owner.root}${sep}`));
          if (workspace) annotationInputs.add(resolve(workspace.root, 'package.json'));
        });
        builder.onResolve({ filter: /^[^./#]/ }, ({ path, kind, resolveDir, importer }) => {
          // Match the universal compiler before workspace source resolution:
          // the app supplies these modules when it evaluates the artifact.
          if (hostExternals.has(path)) return { path, external: true };
          // Hosts are not inputs of portable plugin UI. This is the same
          // exclusion as the containing source-input inventory.
          const dependency = packages.get(packageNameOfSpecifier(path));
          if (dependency && relative(repoDir, dependency.root).split(sep)[0] === 'apps') return { path, external: true };
          const source = options.resolveSourceImport(path);
          return source ? builder.resolve(source, { kind, resolveDir, importer }) : undefined;
        });
      } }],
    });
    if (!inventory) {
      // Eliminate annotated unused subtrees, retaining import/reexport ancestors
      // of live code: even a code-free wrapper can redirect a dependency.
      const observed = [...inputs];
      inputs.clear();
      for (const path of observed) if (!sideEffectFree.has(path)) inputs.add(path);
      for (const path of annotationInputs) inputs.add(path);
      const importers = new Map();
      for (const [path, input] of Object.entries(result.metafile.inputs)) {
        for (const dependency of input.imports) {
          if (dependency.external) continue;
          const key = resolve(repoDir, dependency.path);
          if (!importers.has(key)) importers.set(key, []);
          importers.get(key).push(resolve(repoDir, path));
        }
      }
      for (const output of Object.values(result.metafile.outputs)) {
        for (const [path, input] of Object.entries(output.inputs)) {
          if (input.bytesInOutput > 0) inputs.add(resolve(repoDir, path));
        }
      }
      const pending = [...inputs, ...entries];
      for (const path of pending) {
        inputs.add(path);
        for (const importer of importers.get(path) ?? []) {
          if (inputs.has(importer)) continue;
          inputs.add(importer);
          pending.push(importer);
        }
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
