import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

import { readWorkspaceBuildInputs, readWorkspaceBuildFileDigest } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveWorkspaceDependencyBuildOrder } from '../../../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';

const excludedGeneratedPaths = [
  'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
  'src/plugins/projection/registry/sources/generatedBundledPlugins.ts',
  'src/prompts/assets/generated/pluginDescriptors.ts',
];

/**
 * @param {{ repoRoot: string; bundledWorkspaceNames: readonly string[]; canonicalWorkspacePackageNames: readonly string[] }} input
 * @returns {string[]}
 */
export function resolveGeneratorAuthoringWorkspaceNames({ repoRoot, bundledWorkspaceNames, canonicalWorkspacePackageNames }) {
  const { sourceEntries, metafile } = inspectGeneratorAuthoringSources(join(repoRoot, 'apps', 'cli'));
  const packageNames = new Set(['plugin-sdk', ...canonicalWorkspacePackageNames]);
  const pending = [...sourceEntries];
  const visited = new Set();
  while (pending.length > 0) {
    const inputPath = pending.pop();
    if (visited.has(inputPath)) continue;
    visited.add(inputPath);
    for (const imported of metafile.inputs[inputPath]?.imports ?? []) {
      if (imported.external && imported.path.startsWith('@happier-dev/')) {
        packageNames.add(imported.path.split('/')[1]);
      } else if (!imported.external && imported.kind !== 'dynamic-import') {
        pending.push(imported.path);
      }
    }
  }
  // The explicit source entries include the generator's separately loaded
  // authoring modules. Lazy host operations beneath those modules are not
  // authoring prerequisites (logger's daemon-log read loads persistence only
  // when invoked). Their source still participates in the fingerprint below.
  // Plugin manifests own their emitted runtime dependency closure, including
  // dynamically imported package entrypoints; never substitute the CLI's full
  // runtime inventory for either of these consumed closures.
  return resolveWorkspaceDependencyBuildOrder({
    repoRoot,
    seedPackageNames: [...packageNames, ...bundledWorkspaceNames.filter((name) => name.startsWith('plugins-'))],
    includeDevDependencies: false,
  }).filter((name) => !name.startsWith('plugins-'));
}

// The publisher and Stack admission consume one authored-source closure.
// Resolve imports without executing authoring or loading the generator's runtime.
function inspectGeneratorAuthoringSources(cliDir) {
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

export function readGeneratorAuthoringSourceFingerprint(cliDir) {
  return JSON.stringify(readGeneratorAuthoringSourceInputPaths(cliDir)
    .map((path) => [path, readWorkspaceBuildFileDigest(resolve(cliDir, path))]));
}

export function readGeneratorCliPreparationFingerprint(cliDir) {
  // CLI runtime edits do not affect plugin authoring. Keep its exact existing
  // import closure and compiler/package configuration, not the entire host.
  return JSON.stringify([
    readGeneratorAuthoringSourceFingerprint(cliDir),
    ...readWorkspaceBuildInputs(cliDir).filter((path) => path === 'package.json' || /^tsconfig.*\.json$/.test(path))
      .map((path) => [path, readWorkspaceBuildFileDigest(resolve(cliDir, path))]),
  ]);
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
