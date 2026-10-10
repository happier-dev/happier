import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUniversalPluginUiArtifacts } from '../../../packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts';
import { generateBundledPluginUiArtifacts } from './generateBundledPluginUiArtifacts.mjs';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';

/** Reuse the universal UI artifact compiler and inventory owner, without publishing
 * package dist, compiler projections, or the inventory used by a live Expo. */
export async function prepareSourcePluginUiArtifacts({ repoRoot, outputDir, plugins, resolveSourceImport, artifactOutputDirs = {} }) {
  const artifactRoots = {};
  const pluginManifests = {};
  await mkdir(outputDir, { recursive: true });
  for (const { directory, manifest } of plugins) {
    const manifestPath = join(outputDir, `${directory}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { artifactsRoot } = await buildUniversalPluginUiArtifacts(
      join(repoRoot, 'packages/plugins', directory), manifestPath,
      { outputDir: artifactOutputDirs[directory] ?? join(outputDir, directory, 'happier-plugin-ui'), exportConditions: ['happier-source'], resolveSourceImport },
    );
    artifactRoots[directory] = artifactsRoot;
    pluginManifests[directory] = manifest;
  }
  return generateBundledPluginUiArtifacts({
    repoRoot, outputPath: join(outputDir, 'inventory.js'), artifactRoots,
    pluginManifests, publicationMode: 'artifact',
  });
}

// Native construction invokes this same compiler/inventory owner as source QA,
// with package-local outputs. Only build tooling uses the source preload.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const options = JSON.parse(input);
  const packages = await readWorkspacePackages(options.repoRoot);
  await prepareSourcePluginUiArtifacts({...options,resolveSourceImport(specifier) {
    return packages.has(packageNameOfSpecifier(specifier)) ? resolveWorkspaceSource(packages,specifier) : undefined;
  }});
}
