import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

import { readWorkspaceBuildInputs } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const excludedGeneratedPaths = [
  'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
  'src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
  'src/prompts/assets/generated/pluginDescriptors.ts',
];

// Artifact identity consumes the generator's authored-source inputs without
// executing authoring or loading its runtime.
function inspectGeneratorAuthoringSources(cliDir) {
  const sourceEntries = [
    'src/plugins/authoring/agentNativeHomeEnvironmentKeys.ts',
    'src/plugins/authoring/sourceModule.ts',
    'src/plugins/authoring/bundleDaemonRuntime.ts',
    'src/plugins/authoring/runtimeStagingSource.ts',
    'src/plugins/authoring/daemonOutputManifest.ts',
    'src/plugins/manifest/serialize.ts',
  ].filter((path) => existsSync(resolve(cliDir, path)));
  // Use authoring's esbuild resolver (including aliases). Package inputs are
  // supplied by the artifact owner's workspace closure.
  const metafile = sourceEntries.length === 0 ? { inputs: {} } : buildSync({
    absWorkingDir: cliDir,
    entryPoints: sourceEntries,
    bundle: true,
    write: false,
    outdir: 'dist/.authoring-input-inspection',
    metafile: true,
    platform: 'node',
    packages: 'external',
    // Generated leaves are downstream outputs, never inspection prerequisites.
    // Include extensionless imports so absent leaves need no file resolution.
    external: excludedGeneratedPaths.flatMap((path) => [
      resolve(cliDir, path),
      resolve(cliDir, path.slice(0, -extname(path).length)),
    ]),
    logLevel: 'silent',
    ...(existsSync(resolve(cliDir, 'tsconfig.json')) ? { tsconfig: 'tsconfig.json' } : {}),
  }).metafile;
  return { sourceEntries, metafile };
}

export function readGeneratorAuthoringSourceInputPaths(cliDir) {
  const { metafile } = inspectGeneratorAuthoringSources(cliDir);
  return [...new Set([
    ...readWorkspaceBuildInputs(cliDir).filter((path) => path.startsWith('scripts/')),
    ...Object.keys(metafile.inputs),
  ])].filter((path) => !excludedGeneratedPaths.includes(path)).sort();
}

export function resolveBundledPluginGeneratorInputPaths({ repoDir }) {
  const cliDir = join(repoDir, 'apps', 'cli');
  const generatorInput = 'scripts/build-owned/generateBundledPluginEntries.ts';
  const inputs = readGeneratorAuthoringSourceInputPaths(cliDir);
  return [
    ...inputs.filter((input) => input === generatorInput),
    ...inputs.filter((input) => input !== generatorInput),
  ].map((input) => resolve(cliDir, input));
}
