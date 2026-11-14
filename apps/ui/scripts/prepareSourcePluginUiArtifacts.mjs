import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUniversalPluginUiArtifacts } from '../../../packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts';
import { generateBundledPluginUiArtifacts, readBundledPluginUiArtifactsRetainedInventory,
  resolveBundledPluginUiArtifactsOutputPath, collectBundledPluginUiArtifactSources } from './generateBundledPluginUiArtifacts.mjs';
import { createBundledPluginPublicationFailure } from '../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { readWorkspacePackages, SOURCE_CONDITION } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { sourcePluginUiBuildOptions, SOURCE_PLUGIN_UI_IMPORT_CONDITIONS } from '../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { readSourcePluginUiBuildInputs, readSourcePluginUiBuildInputRecord, readSourcePluginUiInstalledIdentity,
  readSourcePluginUiInstalledImports } from '../../stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { readBuildInputIdentity } from '../../../scripts/workspaces/buildInputConvergence.mjs';
import { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '../../../packages/cli-common/packageBuildOutputTargets.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../../stack/scripts/utils/fs/json.mjs';

/** Everything shared by all plugins that can change a compiled Plugin UI: the
 * compiler's sources, the installed packages they import (by content), and the
 * esbuild version. Lockfile, install marker and host manifests are not inputs:
 * an unrelated dependency edit must not recompile every plugin. */
export async function readSourcePluginUiCompilerIdentity({ compilerRepo = fileURLToPath(new URL('../../../', import.meta.url)), retainedCompilerInputs } = {}) {
  const compilerPackages = await readWorkspacePackages(compilerRepo);
  const compilerPackageInputs = new Map();
  const compilerFiles = await readSourcePluginUiBuildInputs({ repoDir: compilerRepo, compiler: true,
    packages: compilerPackages, packageInputs: compilerPackageInputs, retainedInputs: retainedCompilerInputs });
  const installedImports = await readSourcePluginUiInstalledImports({ compiler: true, packageInputs: compilerPackageInputs });
  const compilerInputs = await readSourcePluginUiBuildInputRecord({ repoDir: compilerRepo, files: compilerFiles,
    installedImports, packages: compilerPackages, packageInputs: compilerPackageInputs });
  const compilerIdentity = await readBuildInputIdentity({ sourceDir: compilerRepo, files: compilerFiles });
  // Read the installed manifest, not require's module cache: long-lived
  // preparation processes outlive a dependency refresh.
  const esbuildVersion = JSON.parse(await readFile(createRequire(join(compilerRepo, 'packages/plugin-sdk/package.json'))
    .resolve('esbuild/package.json'), 'utf8')).version;
  return { compilerInputs, identity: [compilerIdentity, esbuildVersion,
    readSourcePluginUiInstalledIdentity({ repoDir: compilerRepo, installedImports })] };
}

/** Reuse the universal UI artifact compiler and inventory owner without publishing
 * package dist or compiler projections. Callers publish a consumer-owned inventory
 * beside retained input roots, never the shared source-tree projection. */
export async function prepareSourcePluginUiArtifacts({ repoRoot, outputDir, plugins, resolveSourceImport, sourceImportConditions: conditions = SOURCE_PLUGIN_UI_IMPORT_CONDITIONS, artifactOutputDirs = {}, artifactStoreDir, outputPath = join(outputDir, 'inventory.js'), retainedInventoryPath = outputPath }) {
  const artifactRoots = {};
  const pluginManifests = {};
  const outputDirs = { ...artifactOutputDirs };
  const compilationFailures = [];
  const retainedInventory = readBundledPluginUiArtifactsRetainedInventory(retainedInventoryPath);
  const producerInventory = readBundledPluginUiArtifactsRetainedInventory(resolveBundledPluginUiArtifactsOutputPath(repoRoot));
  const retainedRoots = retainedInventory.roots;
  const producerRoots = producerInventory.roots;
  const retainedRecords = new Map();
  for (const root of new Set([...retainedRoots.values(), ...producerRoots.values(), ...Object.values(artifactOutputDirs),
    ...plugins.map(({ directory }) => join(repoRoot, 'packages/plugins', directory, 'dist/happier-plugin-ui'))])) {
    retainedRecords.set(root, await readJsonIfExists(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD)));
  }
  const retainedCompilerInputs = [...retainedRecords.values()].find(record => record?.compilerInputs)?.compilerInputs;
  const { compilerInputs, identity: compilerIdentity } = await readSourcePluginUiCompilerIdentity({ retainedCompilerInputs });
  const packages = await readWorkspacePackages(repoRoot);
  const buildOptions = await sourcePluginUiBuildOptions({ repoRoot, packages, resolveSourceImport,
    sourceImportConditions: conditions });
  const successfulInputs = new Map();
  // The inventory retains the admitted declaration even when compiler-reuse
  // metadata is absent. Prefer its original manifest when that metadata exists;
  // the inventory producer still revalidates the complete candidate below.
  const retainedInputs = new Map();
  for (const inventory of [producerInventory, retainedInventory]) {
    for (const declaration of inventory.declarations.values()) {
      const root = inventory.roots.get(declaration.pluginId);
      if (root && declaration.packageName && declaration.normalizedManifest?.id) {
        retainedInputs.set(declaration.packageName, { root, manifest: declaration.normalizedManifest });
      }
    }
    for (const root of new Set(inventory.roots.values())) {
      const record = await readJsonIfExists(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
      if (record?.version === 2 && record.packageName && record.manifest?.id) {
        retainedInputs.set(record.packageName, { root, manifest: record.manifest });
      }
    }
  }
  await mkdir(outputDir, { recursive: true });
  const packageInputs = new Map();
  for (const { directory, manifest: suppliedManifest, loadManifest, uiArtifacts = true } of plugins) {
    let manifest;
    let candidates = [];
    const packageName = `@happier-dev/plugins-${directory}`;
    const projectRoot = join(repoRoot, 'packages/plugins', directory);
    const artifactOutputDir = artifactOutputDirs[directory] ?? join(outputDir, directory, 'happier-plugin-ui');
    try {
      manifest = loadManifest ? await loadManifest() : suppliedManifest;
      pluginManifests[directory] = manifest;
      if (!uiArtifacts) {
        if (!artifactStoreDir) outputDirs[directory] ??= artifactOutputDir;
        continue;
      }
      candidates = [...new Set([artifactOutputDir, retainedRoots.get(manifest.id),
        producerRoots.get(manifest.id), join(projectRoot, 'dist/happier-plugin-ui')].filter(Boolean))];
      // The compiler record includes the graph/resolver policy. Rediscover
      // per-plugin membership when that policy changes rather than carrying
      // an older, broader graph into every later source preparation.
      const retainedInputs = candidates.map(root => retainedRecords.get(root))
        .find(record => record?.compilerInputs?.identity === compilerInputs.identity)?.sourceInputs;
      const files = await readSourcePluginUiBuildInputs({ repoDir: repoRoot, pluginDirectory: directory, packages, packageInputs,
        resolveSourceImport: buildOptions.resolveSourceImport, retainedInputs, inputOptions: conditions });
      const installedImports = await readSourcePluginUiInstalledImports({ pluginDirectory: directory, packageInputs });
      const sourceInputs = await readSourcePluginUiBuildInputRecord({ repoDir: repoRoot, files, installedImports,
        packages, packageInputs, inputOptions: conditions });
      const options = [manifest, ...compilerIdentity, readSourcePluginUiInstalledIdentity({ repoDir: repoRoot, installedImports }), conditions, SOURCE_CONDITION, process.version, process.platform, process.arch];
      const inputFingerprint = await readBuildInputIdentity({ sourceDir: repoRoot, files, options });
      for (const root of candidates) {
        const record = await readJsonIfExists(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
        if (record?.version !== 2 || record.fingerprint !== inputFingerprint) continue;
        const retained = await collectBundledPluginUiArtifactSources(repoRoot, [], { [directory]: root }, { [directory]: manifest });
        if (retained.pluginFailures.length > 0) continue;
        artifactRoots[directory] = root;
        break;
      }
      if (artifactRoots[directory]) {
        successfulInputs.set(directory, { options, inputFingerprint, sourceInputs, reusedRoot: artifactRoots[directory] });
        continue;
      }
      const manifestPath = join(outputDir, `${directory}.json`);
      await writeFile(manifestPath, JSON.stringify(manifest));
      const { artifactsRoot } = await buildUniversalPluginUiArtifacts(projectRoot, manifestPath,
        { ...buildOptions, outputDir: artifactOutputDir });
      artifactRoots[directory] = artifactsRoot;
      successfulInputs.set(directory, { options, inputFingerprint, sourceInputs });
    } catch (error) {
      const retained = retainedInputs.get(packageName);
      if (retained) {
        // Retained bytes keep the declaration they were compiled against,
        // including when a valid new manifest has an uncompilable UI.
        manifest = retained.manifest;
        pluginManifests[directory] = manifest;
        candidates = [retained.root];
      }
      compilationFailures.push(createBundledPluginPublicationFailure({ repoRoot,
        packageName, pluginId: manifest?.id,
        code: 'plugin_ui_artifact_invalid', error }));
      // The compiler leaves prior publications intact. The inventory owner
      // selects only a candidate whose manifest and complete graph validate.
      artifactRoots[directory] = candidates;
      // Finite runtime construction collects these roots even when UI is
      // unavailable. Absence of a manifest keeps artifact admission closed.
      await mkdir(artifactOutputDir, { recursive: true });
    }
  }
  const result = await generateBundledPluginUiArtifacts({
    repoRoot, outputPath, artifactRoots, artifactOutputDirs: outputDirs, artifactStoreDir,
    pluginManifests, compilationFailures, publicationMode: 'source',
  });
  const publicationPackageInputs = new Map();
  for (const [directory, input] of successfulInputs) {
    if (result.pluginFailures.some((failure) => failure.packageName === `@happier-dev/plugins-${directory}`)) continue;
    // An interactive source edit during compilation does not make the served
    // graph unusable, but it cannot certify unchanged-input reuse next time.
    const files = await readSourcePluginUiBuildInputs({ repoDir: repoRoot, pluginDirectory: directory, packages,
      packageInputs: publicationPackageInputs, resolveSourceImport: buildOptions.resolveSourceImport,
      retainedInputs: input.sourceInputs, inputOptions: conditions });
    if (await readBuildInputIdentity({ sourceDir: repoRoot, files, options: input.options }) !== input.inputFingerprint) continue;
    const root = result.artifactRoots[directory] ?? artifactOutputDirs[directory] ?? artifactRoots[directory];
    // Borrowed producer roots stay read-only. Consumer-owned graphs can retain
    // their admitted manifest even when identical bytes were reused.
    if (input.reusedRoot && resolve(root) === input.reusedRoot && !artifactStoreDir && !artifactOutputDirs[directory]) continue;
    const record = await readJsonIfExists(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
    if (record?.version === 2 && record.fingerprint === input.inputFingerprint && record.manifest && record.packageName
      && record.sourceInputs?.identity === input.sourceInputs.identity && record.compilerInputs?.identity === compilerInputs.identity) continue;
    await writeJsonAtomic(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD), { version: 2, fingerprint: input.inputFingerprint,
      packageName: `@happier-dev/plugins-${directory}`, manifest: pluginManifests[directory], sourceInputs: input.sourceInputs, compilerInputs });
  }
  for (const diagnostic of result.diagnostics) {
    const unavailable = result.pluginFailures.some((failure) => failure.pluginId === diagnostic.pluginId);
    console.error(`[plugin:${diagnostic.pluginId}] ${diagnostic.code}: ${diagnostic.message} (${unavailable ? 'UI unavailable' : 'serving last-green UI; stale'})`);
  }
  const reused = [...successfulInputs.values()].filter(input => input.reusedRoot).length;
  console.error(`[source-ui] phase=plugin-ui-input-reuse visited=${plugins.length} compiled=${successfulInputs.size - reused} reused=${reused} failed=${compilationFailures.length}`);
  return result;
}

// Native construction invokes this same compiler/inventory owner as source QA,
// with package-local outputs. Only build tooling uses the source preload.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const options = JSON.parse(input);
  await prepareSourcePluginUiArtifacts(options);
}
