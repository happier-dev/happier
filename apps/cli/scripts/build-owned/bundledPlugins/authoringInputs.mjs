import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

import { readWorkspaceBuildInputs, readWorkspaceBuildFileDigest } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const excludedGeneratedPaths = [
  'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
  'src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
  'src/prompts/assets/generated/pluginDescriptors.ts',
];

// The publisher and Stack admission consume one authored-source closure.
// Resolve imports without executing authoring or loading the generator's runtime.
export function readGeneratorAuthoringSourceInputPaths(cliDir) {
  const sourceEntries = [
    'src/plugins/authoring/agentNativeHomeEnvironmentKeys.ts',
    'src/plugins/authoring/sourceModule.ts',
    'src/plugins/authoring/bundleDaemonRuntime.ts',
    'src/plugins/authoring/runtimeStagingSource.ts',
    'src/plugins/authoring/daemonOutputManifest.ts',
    'src/plugins/manifest/serialize.ts',
  ].filter((path) => existsSync(resolve(cliDir, path)));
  // Use authoring's esbuild resolver (including aliases). Package imports stay
  // external because dependency currentness owns their separately built frame.
  const sourceInputs = sourceEntries.length === 0 ? [] : Object.keys(buildSync({
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
  }).metafile.inputs);
  return [...new Set([
    ...readWorkspaceBuildInputs(cliDir).filter((path) => path.startsWith('scripts/')),
    ...sourceInputs,
  ])].filter((path) => !excludedGeneratedPaths.includes(path)).sort();
}

export function readGeneratorAuthoringSourceFingerprint(cliDir) {
  return JSON.stringify(readGeneratorAuthoringSourceInputPaths(cliDir)
    .map((path) => [path, readWorkspaceBuildFileDigest(resolve(cliDir, path))]));
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
