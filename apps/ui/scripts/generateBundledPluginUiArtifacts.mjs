import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from '../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
import { readBundledPluginUiDeclarationSource, renderBundledPluginUiDeclarationSource } from './bundledPluginUiDeclarationSource.mjs';

import {
  createBundledPluginPublicationFailure,
  readBundledPluginPublicationFailures,
  writeBundledPluginPublicationFailures,
} from '../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_PACKAGE_PREFIX = '@happier-dev/plugins-';
const GENERATED_OUTPUT_RELATIVE_PATH = join(
  'apps',
  'ui',
  'sources',
  'sync',
  'domains',
  'plugins',
  'availability',
  'generatedBundledPluginUiArtifacts.js',
);

// This producer emits static JSON-quoted requires. Describe exactly that graph
// without executing an inventory; workspace startup owns file admission.
const INVENTORY_REQUIRE = /^(const BUNDLED_PLUGIN_UI_APP_ASSET_\d+ = )require\(("(?:[^"\\]|\\.)*")\);$/gm;
const INVENTORY_DECLARATION_IMPORT = /import\(("(?:[^"\\]|\\.)*")\)/g;
function readBundledPluginUiArtifactsInventory(inventoryPath) {
  let source;
  try {
    source = readFileSync(inventoryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!source.includes('export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS')) return null;
  const references = [...source.matchAll(INVENTORY_REQUIRE)];
  if (references.length !== [...source.matchAll(/^const BUNDLED_PLUGIN_UI_APP_ASSET_\d+ = require\(/gm)].length) return null;
  const require = createRequire(inventoryPath);
  const paths = [inventoryPath];
  try {
    for (const [, , encoded] of references) {
      const specifier = JSON.parse(encoded);
      paths.push(isAbsolute(specifier) ? specifier : require.resolve(specifier));
    }
  } catch {
    return null;
  }
  const declarationPaths = [...source.matchAll(INVENTORY_DECLARATION_IMPORT)].map(([, encoded]) => {
    const specifier = JSON.parse(encoded);
    return isAbsolute(specifier) ? specifier : resolve(dirname(inventoryPath), specifier);
  });
  // Empty compiler graphs have no asset row from which to recover their root.
  // Keep those existing reuse records reachable without adding runtime imports.
  const rootRecord = source.match(/^\/\/ BUNDLED_PLUGIN_UI_ARTIFACT_ROOTS = (.+);$/m);
  let artifactRoots = {};
  try {
    if (rootRecord) artifactRoots = Object.fromEntries(Object.entries(JSON.parse(rootRecord[1]))
      .filter(([, root]) => typeof root === 'string' && isAbsolute(root)));
  } catch { /* Optional compiler reuse metadata does not decide byte availability. */ }
  return { source, artifactRoots, references: paths.slice(1), declarationPaths, paths: Array.from(new Set([...paths, ...declarationPaths])) };
}

export function resolveBundledPluginUiArtifactsInputPaths(inventoryPath) {
  return readBundledPluginUiArtifactsInventory(inventoryPath)?.paths ?? null;
}

export function resolveBundledPluginUiArtifactsRetainedRoots(inventoryPath) {
  return readBundledPluginUiArtifactsRetainedInventory(inventoryPath).roots;
}

/** Recover the producer's admitted declarations with their candidate roots.
 * Compiler reuse metadata is optional; it does not own last-green availability. */
export function readBundledPluginUiArtifactsRetainedInventory(inventoryPath) {
  const retained = readBundledPluginUiArtifactsInventory(inventoryPath);
  const roots = new Map();
  const declarations = new Map();
  if (!retained) return { roots, declarations };
  for (const [pluginId, root] of Object.entries(retained.artifactRoots)) roots.set(pluginId, root);
  const retainRoot = (pluginId, relativePath, assetIndex) => {
    const path = retained.references[Number(assetIndex)];
    if (!path) return;
    const segments = relativePath.split('/');
    const root = resolve(dirname(path), ...segments.slice(1).map(() => '..'));
    if (resolve(root, ...segments) === path) roots.set(pluginId, root);
  };
  const rows = /pluginId: ("(?:[^"\\]|\\.)*"),[\s\S]*?files: Object.freeze\(\[\s*Object.freeze\(\{\s*relativePath: ("(?:[^"\\]|\\.)*"),\s*asset: BUNDLED_PLUGIN_UI_APP_ASSET_(\d+),/g;
  for (const [, pluginId, relativePath, assetIndex] of retained.source.matchAll(rows)) {
    retainRoot(JSON.parse(pluginId), JSON.parse(relativePath), assetIndex);
  }
  for (const [, json] of retained.source.matchAll(/^const BUNDLED_PLUGIN_UI_APP_DECLARATION_\d+ = (.+);$/gm)) {
    try {
      const declaration = JSON.parse(json);
      declarations.set(declaration.pluginId, declaration);
    } catch { return { roots, declarations }; }
  }
  for (const path of retained.declarationPaths) {
    try {
      const source = readFileSync(path, 'utf8');
      const declaration = readBundledPluginUiDeclarationSource(source);
      declarations.set(declaration.pluginId, declaration);
    } catch { return { roots, declarations }; }
  }
  const resources = /^  Object.freeze\(\{\n    pluginId: ("(?:[^"\\]|\\.)*"),\n    resourceId: ("(?:[^"\\]|\\.)*"),\n    releaseVersion: [^\n]+\n    digest: [^\n]+\n    asset: BUNDLED_PLUGIN_UI_APP_ASSET_(\d+),/gm;
  for (const [, encodedPluginId, encodedResourceId, assetIndex] of retained.source.matchAll(resources)) {
    const pluginId = JSON.parse(encodedPluginId);
    const resourceId = JSON.parse(encodedResourceId);
    const resource = declarations.get(pluginId)?.normalizedManifest?.contributes?.resources?.find(entry => entry.id === resourceId);
    if (resource?.path) retainRoot(pluginId, `packaged-resources/${resource.path}.bundle`, assetIndex);
  }
  return { roots, declarations };
}

/** Seed the existing consumer inventory from producer-owned retained bytes.
 * Absolute references preserve the artifact graph across inventory locations;
 * the normal compiler can later replace this same file atomically for Metro.
 */
export async function retainBundledPluginUiArtifactsInventory({ inventoryPath, outputPath }) {
  const retained = readBundledPluginUiArtifactsInventory(inventoryPath);
  if (!retained) return false;
  let index = 0;
  let declarationIndex = 0;
  const output = retained.source.replace(INVENTORY_REQUIRE, (_match, prefix) => `${prefix}require(${JSON.stringify(retained.references[index++])});`)
    .replace(INVENTORY_DECLARATION_IMPORT, () => `import(${JSON.stringify(retained.declarationPaths[declarationIndex++])})`);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp.${process.pid}`;
  await writeFile(temporaryPath, output, 'utf8');
  await rename(temporaryPath, outputPath);
  return true;
}

function parseJson(bytes, path) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`Invalid JSON at '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readRequiredString(record, key, label) {
  const value = record?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must declare a non-empty '${key}'`);
  }
  return value.trim();
}

function assertArtifactPath(artifactsRoot, relativePath, packageName) {
  const absolutePath = resolve(artifactsRoot, ...relativePath.split('/'));
  const rootPrefix = artifactsRoot.endsWith(sep) ? artifactsRoot : `${artifactsRoot}${sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error(
      `Bundled Plugin UI artifact path escapes its artifact root for '${packageName}': '${relativePath}'`,
    );
  }
  return absolutePath;
}

async function materializeArtifactGraph(destination, files, reuseContent) {
  const outputs = files.map(file => ({ ...file, path: assertArtifactPath(destination, file.relativePath, destination) }));
  for (const file of outputs) {
    if (reuseContent) {
      const existing = await readFile(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing?.equals(file.bytes)) continue;
      let missingRoot;
      for (let directory = dirname(file.path);; directory = dirname(directory)) {
        const info = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (info) break;
        missingRoot = directory;
      }
      if (missingRoot) {
        // Metro's fallback watcher reads a directory before attaching its watch.
        // Publish the entire first missing subtree at once, so its crawl cannot
        // observe an empty parent and then miss children created in that gap.
        // Reuse the existing excluded scratch prefix, on the same filesystem.
        const stage = await mkdtemp(join(dirname(missingRoot), '.happier-plugin-ui-stage-'));
        try {
          for (const output of outputs.filter(output => output.path.startsWith(`${missingRoot}${sep}`))) {
            const stagedPath = join(stage, relative(missingRoot, output.path));
            await mkdir(dirname(stagedPath), { recursive: true });
            await writeFile(stagedPath, output.bytes);
          }
          await rename(stage, missingRoot);
        } finally { await rm(stage, { recursive: true, force: true }); }
        continue;
      }
    }
    await mkdir(dirname(file.path), { recursive: true });
    const temporary = `${file.path}.tmp.${process.pid}`;
    await writeFile(temporary, file.bytes);
    await rename(temporary, file.path);
  }
}

export function listBundledPluginUiArtifactExports(packageJson) {
  return packageJson?.exports && typeof packageJson.exports === 'object'
    // The SDK compiler owns manifest references and conditional export
    // resolution, including authored happier-source Account entries.
    ? Object.keys(packageJson.exports).filter(key => key.startsWith('./happier-plugin-ui/')) : [];
}

export async function collectBundledPluginUiArtifactSources(repoRoot, initialPluginFailures = [], artifactRoots, pluginManifests = {}, artifactOutputDirs = {}, artifactStoreDir, writePackagedResources = false) {
  const {
    PluginUiArtifactsManifestV2Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
  } = await import('@happier-dev/protocol/plugins/ui');
  const uiPackageJsonPath = resolve(repoRoot, 'apps', 'ui', 'package.json');
  const uiPackageJson = parseJson(await readFile(uiPackageJsonPath, 'utf8'), uiPackageJsonPath);
  const uiDependencies = uiPackageJson?.dependencies && typeof uiPackageJson.dependencies === 'object'
    ? uiPackageJson.dependencies
    : {};
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  const pluginDirectories = artifactRoots ? [...new Set([...Object.keys(artifactRoots), ...Object.keys(pluginManifests)])].sort() : (await readdir(pluginsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const sources = [];
  const packagedResources = [];
  const declarations = new Map();
  const publishedArtifactRoots = {};
  const compilerRoots = {};
  const pluginFailures = [...initialPluginFailures];
  const excludedPackageNames = new Set(initialPluginFailures.map((failure) => failure.packageName));
  const coordinateOwners = new Map();

  for (const pluginDirectory of pluginDirectories) {
    const candidatePackageName = `${PLUGIN_PACKAGE_PREFIX}${pluginDirectory}`;
    if (excludedPackageNames.has(candidatePackageName)) continue;
    const packageRoot = resolve(pluginsRoot, pluginDirectory);
    const candidateRoots = artifactRoots
      ? (Object.hasOwn(artifactRoots, pluginDirectory)
        ? [...new Set([artifactRoots[pluginDirectory]].flat().filter(Boolean).map((root) => resolve(root)))]
        : [undefined])
      : [resolve(packageRoot, 'dist', 'happier-plugin-ui')];
    // Source preparation owns manifest/last-good selection. An explicit empty
    // candidate set means it could not select one; absent roots also cover
    // valid daemon-only declarations that need no UI compilation.
    if (candidateRoots.length === 0) continue;
    const packageJsonPath = resolve(packageRoot, 'package.json');
    const pluginManifestPath = resolve(packageRoot, '.happier-plugin', 'plugin.json');
    let packageJson;
    let pluginManifest;
    let packageName;
    let packageVersion;
    let pluginId = pluginManifests[pluginDirectory]?.id ?? `happier.${pluginDirectory}`;
    try {
      packageJson = parseJson(await readFile(packageJsonPath, 'utf8'), packageJsonPath);
      packageName = readRequiredString(packageJson, 'name', packageJsonPath);
      packageVersion = readRequiredString(packageJson, 'version', packageJsonPath);
      if (!packageName.startsWith(PLUGIN_PACKAGE_PREFIX)) {
        throw new Error(`Bundled Plugin UI package '${packageName}' must use the '${PLUGIN_PACKAGE_PREFIX}' prefix`);
      }
      pluginManifest = pluginManifests[pluginDirectory] ?? await readFile(pluginManifestPath, 'utf8')
        .then(bytes => parseJson(bytes, pluginManifestPath))
        .catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (pluginManifest) {
        pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
      }
    } catch (error) {
      pluginFailures.push(createBundledPluginPublicationFailure({ repoRoot, packageName: candidatePackageName,
        pluginId, code: 'plugin_ui_artifact_invalid', error }));
      continue;
    }
    for (const [candidateIndex, artifactsRoot] of candidateRoots.entries()) {
    try {
    let rawArtifactManifest;
    let artifactManifestError;
    if (artifactsRoot) {
      const artifactsManifestPath = resolve(artifactsRoot, 'ui-artifacts.json');
      try {
        rawArtifactManifest = parseJson(await readFile(artifactsManifestPath, 'utf8'), artifactsManifestPath);
      } catch (error) {
        artifactManifestError = error;
      }
    }
    const parsedManifest = rawArtifactManifest === undefined ? undefined : PluginUiArtifactsManifestV2Schema.safeParse(rawArtifactManifest);
    // Select compiler facts before projecting. Failed metadata candidates must
    // not erase an earlier graph declaration; only final unresolved metadata
    // needs an empty-graph declaration when none has been produced yet.
    if (parsedManifest?.success || !artifactsRoot
      || (candidateIndex === candidateRoots.length - 1 && !declarations.has(pluginId))) {
      const declaration = await projectBundledPluginUiDeclaration({ packageName, packageVersion,
        manifest: pluginManifest, artifactGraphs: parsedManifest?.success ? parsedManifest.data.entries : [] });
      if (declaration) declarations.set(declaration.pluginId, declaration);
    }
    if (artifactManifestError) {
      if (artifactManifestError.code === 'ENOENT') {
        const bundleExports = listBundledPluginUiArtifactExports(packageJson);
        if (bundleExports.length > 0 || artifactRoots) {
          pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
          throw new Error(
            `Bundled Plugin UI artifact manifest is missing for '${pluginId}' with declared UI artifact exports: ${bundleExports.join(', ')}`,
          );
        }
      } else {
        throw artifactManifestError;
      }
    }

    pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
    if (rawArtifactManifest !== undefined && !parsedManifest?.success) {
      throw new Error(`Invalid bundled Plugin UI artifact manifest for '${packageName}'`);
    }
    const entries = parsedManifest?.success ? parsedManifest.data.entries : [];
    // App dependency membership applies to executable UI graphs. Daemon-only
    // packages may emit empty manifests and still contribute packaged brands.
    if (!artifactRoots && entries.length > 0 && uiDependencies[packageName] !== packageVersion) {
      throw new Error(
        `apps/ui must depend on bundled Plugin UI package '${packageName}' at '${packageVersion}'`,
      );
    }

    let destination = artifactOutputDirs[pluginDirectory] && resolve(artifactOutputDirs[pluginDirectory]);
    const pluginSources = [];
    const pluginFiles = [];
    const pluginResources = [];
    const resourceFiles = new Map();
    const rawResources = pluginManifest?.contributes?.resources ?? [];
    const declaration = declarations.get(pluginId);
    if (rawResources.some(resource => resource.source !== 'dynamic' && resource.kind === 'asset'
      && resource.contentType === 'application/json') && !declaration) {
      throw new Error(`Invalid packaged Resource declaration for '${packageName}'`);
    }
    for (const resource of declaration?.normalizedManifest?.contributes.resources ?? []) {
      if (resource.source === 'dynamic' || resource.kind !== 'asset' || resource.contentType !== 'application/json') continue;
      const relativePath = `packaged-resources/${resource.path}.bundle`;
      let file = resourceFiles.get(relativePath);
      if (!file) {
        const path = assertArtifactPath(packageRoot, resource.path, packageName);
        try {
          if (!(await lstat(path)).isFile()) throw new Error('not a regular file');
          const realRoot = await realpath(packageRoot);
          const realPath = await realpath(path);
          assertArtifactPath(realRoot, relative(realRoot, realPath).split(sep).join('/'), packageName);
          file = { relativePath, bytes: new Uint8Array(await readFile(path)) };
        } catch (error) {
          throw new Error(`Invalid packaged Resource file for '${packageName}': '${resource.path}' (${String(error)})`);
        }
        resourceFiles.set(relativePath, file);
      }
      pluginResources.push({ pluginId, resourceId: resource.id, releaseVersion: packageVersion,
        digest: computePluginUiArtifactSha256DigestV1(file.bytes), relativePath });
    }
    if (!artifactsRoot && pluginResources.length === 0) break;
    for (const entry of entries) {
      const verifiedFiles = [];
      for (const file of entry.files) {
        const absolutePath = assertArtifactPath(artifactsRoot, file.relativePath, packageName);
        let bytes;
        try {
          if (!(await lstat(absolutePath)).isFile()) throw new Error('not a regular file');
          bytes = new Uint8Array(await readFile(absolutePath));
        } catch (error) {
          throw new Error(
            `Missing bundled Plugin UI artifact file for '${packageName}': '${file.relativePath}' (${String(error)})`,
          );
        }
        if (computePluginUiArtifactSha256DigestV1(bytes) !== file.digest) {
          throw new Error(
            `Bundled Plugin UI artifact file digest mismatch for '${packageName}': '${file.relativePath}'`,
          );
        }
        if (bytes.byteLength !== file.byteSize) {
          throw new Error(
            `Bundled Plugin UI artifact file byte size mismatch for '${packageName}': '${file.relativePath}'`,
          );
        }
        verifiedFiles.push({ relativePath: file.relativePath, bytes });
      }
      if (computePluginUiArtifactFileSetSha256DigestV1(verifiedFiles) !== entry.digest) {
        throw new Error(
          `Bundled Plugin UI artifact graph digest mismatch for '${packageName}/${entry.artifactId}'`,
        );
      }
      if (artifactStoreDir || (destination && destination !== artifactsRoot)) pluginFiles.push(...verifiedFiles);

      const coordinate = [pluginId, entry.artifactId, entry.tier, packageVersion].join('\u001f');
      const previousOwner = coordinateOwners.get(coordinate);
      if (previousOwner) {
        throw new Error(
          `Ambiguous bundled Plugin UI app artifact '${pluginId}/${entry.artifactId}/${entry.tier}/${packageVersion}' from '${previousOwner}' and '${packageName}'`,
        );
      }
      pluginSources.push({
        packageName,
        packageVersion,
        pluginId,
        artifactId: entry.artifactId,
        tier: entry.tier,
        digest: entry.digest,
        artifactGraph: entry,
        files: [...entry.files]
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
          .map((file) => ({ relativePath: file.relativePath, specifier: artifactRoots
            ? assertArtifactPath(artifactsRoot, file.relativePath, packageName)
            : `${packageName}/happier-plugin-ui/${file.relativePath}` })),
      });
    }
    pluginFiles.push(...resourceFiles.values());
    if (!destination && artifactStoreDir) {
      // Reuse the canonical graph digest: changes in compiler inputs that emit
      // identical bytes must not duplicate those bytes in a serving Expo.
      const files = [...new Map(pluginFiles.map(file => [file.relativePath, file])).values()];
      const digest = computePluginUiArtifactFileSetSha256DigestV1(files);
      destination = resolve(artifactStoreDir, pluginDirectory, digest.slice('sha256:'.length));
    }
    if (!destination && pluginResources.length > 0) destination = artifactsRoot;
    if (pluginResources.length > 0 && !destination) {
      throw new Error(`Packaged Resource output root is unavailable for '${packageName}'`);
    }
    // Finite native construction owns fresh output roots. Write the exact
    // bytes just verified, so a concurrent package publication cannot change
    // the retained graph between validation and materialization.
    if (destination && destination !== artifactsRoot) {
      await materializeArtifactGraph(destination, [...pluginFiles,
        ...(parsedManifest?.success ? [{ relativePath: 'ui-artifacts.json', bytes: Buffer.from(JSON.stringify(parsedManifest.data)) }] : [])], Boolean(artifactStoreDir));
      for (const source of pluginSources) {
        source.files = source.files.map((file) => ({ ...file,
          specifier: assertArtifactPath(destination, file.relativePath, source.packageName) }));
      }
    }
    if (destination && pluginResources.length > 0) {
      if (writePackagedResources && destination === artifactsRoot) {
        await materializeArtifactGraph(destination, [...resourceFiles.values()], true);
      } else if (!writePackagedResources) for (const file of resourceFiles.values()) {
        const path = assertArtifactPath(destination, file.relativePath, packageName);
        if (!(await readFile(path)).equals(file.bytes)) throw new Error(`Packaged Resource bytes are out of date for '${packageName}': '${file.relativePath}'`);
      }
      for (const resource of pluginResources) {
        packagedResources.push({ ...resource, specifier: assertArtifactPath(destination, resource.relativePath, packageName) });
      }
    }
    publishedArtifactRoots[pluginDirectory] = destination ?? artifactsRoot;
    if (parsedManifest?.success) compilerRoots[pluginId] = destination ?? artifactsRoot;
    for (const source of pluginSources) {
      coordinateOwners.set([source.pluginId, source.artifactId, source.tier, source.packageVersion].join('\u001f'), source.packageName);
      sources.push(source);
    }
    break;
    } catch (error) {
      if (candidateIndex < candidateRoots.length - 1) continue;
      pluginFailures.push(createBundledPluginPublicationFailure({
        repoRoot,
        packageName: candidatePackageName,
        pluginId,
        code: 'plugin_ui_artifact_invalid',
        error,
      }));
    }
    }
  }

  sources.sort((left, right) => (
    left.packageName.localeCompare(right.packageName)
    || left.artifactId.localeCompare(right.artifactId)
    || left.tier.localeCompare(right.tier)
    || left.digest.localeCompare(right.digest)
  ));
  packagedResources.sort((left, right) => left.pluginId.localeCompare(right.pluginId) || left.resourceId.localeCompare(right.resourceId));
  return { sources, packagedResources, declarations: [...declarations.values()].sort((left, right) => left.packageName.localeCompare(right.packageName)),
    pluginFailures, artifactRoots: publishedArtifactRoots, compilerRoots };
}

async function renderBundledPluginUiArtifactInventory(sources, declarations, packagedResources, declarationPaths, artifactRoots) {
  const lines = [
    '/**',
    ' * GENERATED FILE CONTRACT (APP-BUNDLED-PLUGIN-UI-ARTIFACTS)',
    ' *',
    ' * This file is emitted by:',
    ' * - `apps/ui/scripts/generateBundledPluginUiArtifacts.mjs`',
    ' *',
    ' * Artifact rows pre-seed immutable packaged bytes. The separate semantic',
    ' * declaration projection is owned by the CLI build-owned projector;',
    ' * packaged byte availability does not admit plugin declarations.',
    ' */',
    '',
  ];
  lines.push(`// BUNDLED_PLUGIN_UI_ARTIFACT_ROOTS = ${JSON.stringify(artifactRoots)};`, '');
  const assetSymbolBySpecifier = new Map();
  for (const files of [...sources.map(source => source.files), packagedResources]) {
    for (const file of files) {
      const specifier = file.specifier;
      if (assetSymbolBySpecifier.has(specifier)) continue;
      const symbol = `BUNDLED_PLUGIN_UI_APP_ASSET_${assetSymbolBySpecifier.size}`;
      assetSymbolBySpecifier.set(specifier, symbol);
      lines.push(`const ${symbol} = require(${JSON.stringify(specifier)});`);
    }
  }
  if (assetSymbolBySpecifier.size > 0) lines.push('');
  const declarationSymbolByPluginId = new Map();
  for (const declaration of declarations) {
    const symbol = `BUNDLED_PLUGIN_UI_APP_DECLARATION_${declarationSymbolByPluginId.size}`;
    declarationSymbolByPluginId.set(declaration.pluginId, symbol);
    lines.push("/** @type {import('./bundledPluginUiArtifactInventory').PluginHostBundledUiDeclaration} */");
    const index = await projectBundledPluginUiFirstPaintDeclaration(declaration);
    lines.push(`const ${symbol} = ${JSON.stringify(index)};`);
  }
  if (declarationSymbolByPluginId.size > 0) lines.push('');
  lines.push(
    "/** @type {ReadonlyArray<import('./bundledPluginUiArtifactInventory').PluginHostBundledUiDeclaration>} */",
    'export const BUNDLED_PLUGIN_UI_APP_DECLARATIONS = Object.freeze([',
    ...[...declarationSymbolByPluginId].map(([pluginId, symbol]) => `  Object.freeze({ ...${symbol}, loadDeclaration: () => import(${JSON.stringify(declarationPaths.get(pluginId))}).then(module => module.default) }),`),
    ']);',
    '',
  );
  lines.push(
    "/** @satisfies {import('./bundledPluginUiArtifactInventory').BundledPluginUiAppArtifactInventory} */",
    'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([',
  );
  for (const source of sources) {
    lines.push(
      '  Object.freeze({',
      `    pluginId: ${JSON.stringify(source.pluginId)},`,
      `    artifactId: ${JSON.stringify(source.artifactId)},`,
      `    tier: ${JSON.stringify(source.tier)},`,
      `    digest: ${JSON.stringify(source.digest)},`,
      `    releaseVersion: ${JSON.stringify(source.packageVersion)},`,
      `    artifactGraph: /** @satisfies {NonNullable<import('./bundledPluginUiArtifactInventory').BundledPluginUiAppArtifact['artifactGraph']>} */ (${JSON.stringify(source.artifactGraph)}),`,
      '    files: Object.freeze([',
    );
    for (const file of source.files) {
      const specifier = file.specifier;
      lines.push(
        '      Object.freeze({',
        `        relativePath: ${JSON.stringify(file.relativePath)},`,
        `        asset: ${assetSymbolBySpecifier.get(specifier)},`,
        '      }),',
      );
    }
    lines.push('    ]),', '  }),');
  }
  lines.push(']);', '');
  lines.push("/** @type {ReadonlyArray<import('./bundledPluginUiArtifactInventory').BundledPluginPackagedResource>} */",
    'export const BUNDLED_PLUGIN_PACKAGED_RESOURCES = Object.freeze([');
  for (const resource of packagedResources) {
    lines.push('  Object.freeze({',
      `    pluginId: ${JSON.stringify(resource.pluginId)},`,
      `    resourceId: ${JSON.stringify(resource.resourceId)},`,
      `    releaseVersion: ${JSON.stringify(resource.releaseVersion)},`,
      `    digest: ${JSON.stringify(resource.digest)},`,
      `    asset: ${assetSymbolBySpecifier.get(resource.specifier)},`,
      '  }),');
  }
  lines.push(']);', '');
  return lines.join('\n');
}

async function collectBundledPluginBrandMarks(repoRoot, pluginManifests, excludedPackageNames) {
  const { computePluginUiArtifactSha256DigestV1 } = await import('@happier-dev/protocol/plugins/ui');
  const directories = Object.keys(pluginManifests).length > 0
    ? Object.keys(pluginManifests).sort()
    : (await readdir(resolve(repoRoot, 'packages/plugins'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_')).map((entry) => entry.name).sort();
  const marks = [];
  const pluginFailures = [];
  for (const directory of directories) {
    if (excludedPackageNames.has(`${PLUGIN_PACKAGE_PREFIX}${directory}`)) continue;
    const packageRoot = resolve(repoRoot, 'packages/plugins', directory);
    let pluginId = `happier.${directory}`;
    try {
    let manifest = pluginManifests[directory];
    if (!manifest) {
      try {
        manifest = parseJson(await readFile(join(packageRoot, '.happier-plugin/plugin.json'), 'utf8'), packageRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
    if (!manifest.brand) continue;
    pluginId = manifest.id;
    const resource = manifest.contributes?.resources?.find((entry) => entry.id === manifest.brand.iconResourceId);
    if (!resource || resource.kind !== 'asset' || resource.contentType !== 'image/png') {
      throw new Error(`Invalid packaged brand Resource for '${manifest.id}'`);
    }
    const path = assertArtifactPath(packageRoot, resource.path, manifest.id);
    const bytes = new Uint8Array(await readFile(path));
    const packageJson = parseJson(await readFile(join(packageRoot, 'package.json'), 'utf8'), packageRoot);
    marks.push({ pluginId: manifest.id, displayName: manifest.displayName, resourceId: resource.id,
      releaseVersion: packageJson.version, digest: computePluginUiArtifactSha256DigestV1(bytes), bytes,
      ...(manifest.brand.monochrome === true ? { monochrome: true } : {}) });
    } catch (error) {
      pluginFailures.push(createBundledPluginPublicationFailure({ repoRoot,
        packageName: `${PLUGIN_PACKAGE_PREFIX}${directory}`, pluginId,
        code: 'plugin_ui_artifact_invalid', error }));
    }
  }
  return { marks, pluginFailures };
}

function renderBundledPluginBrandMarks(marks) {
  return [
    '/** Manifest-declared packaged identity bytes, admitted by the shared image owner before rendering. */',
    "/** @type {ReadonlyArray<import('./bundledPluginUiArtifactInventory').BundledPluginBrandMark>} */",
    'export const BUNDLED_PLUGIN_BRAND_MARKS = Object.freeze([',
    ...marks.flatMap((mark) => [
      '  Object.freeze({',
      ...Object.entries(mark).filter(([key]) => key !== 'bytes').map(([key, value]) => `    ${key}: ${JSON.stringify(value)},`),
      `    bytes: Uint8Array.from(${JSON.stringify([...mark.bytes])}),`,
      '  }),',
    ]),
    ']);', '',
  ].join('\n');
}

export function resolveBundledPluginUiArtifactsOutputPath(repoRoot) {
  return resolve(repoRoot, GENERATED_OUTPUT_RELATIVE_PATH);
}

export async function generateBundledPluginUiArtifacts({
  repoRoot = resolve(uiDir, '../..'),
  mode = 'write',
  publicationMode = 'live',
  pluginFailures = [],
  compilationFailures = [],
  outputPath = resolveBundledPluginUiArtifactsOutputPath(repoRoot),
  artifactRoots,
  artifactOutputDirs = {},
  artifactStoreDir,
  pluginManifests = {},
} = {}) {
  if (mode !== 'write' && mode !== 'check') {
    throw new Error(`Unsupported bundled Plugin UI artifact generation mode '${String(mode)}'`);
  }
  if (!['live', 'artifact', 'source'].includes(publicationMode)) {
    throw new Error(`Unsupported bundled Plugin UI publication mode '${String(publicationMode)}'`);
  }
  const inheritedCliFailures = publicationMode === 'live'
    ? readBundledPluginPublicationFailures(repoRoot).filter((failure) => (
      failure.diagnostic.code !== 'plugin_ui_artifact_invalid'
    ))
    : [];
  const initialFailures = [...new Map(
    [...inheritedCliFailures, ...pluginFailures].map((failure) => [failure.packageName, failure]),
  ).values()];
  const collected = await collectBundledPluginUiArtifactSources(repoRoot, initialFailures, artifactRoots, pluginManifests,
    mode === 'write' ? artifactOutputDirs : {}, mode === 'write' ? artifactStoreDir : undefined, mode === 'write');
  // A compiler failure can still have a validated retained byte graph. Only
  // unavailable graphs enter the existing failure set; every error is reported.
  const compilationFailureByPackage = new Map(compilationFailures.map((failure) => [failure.packageName, failure]));
  collected.pluginFailures = collected.pluginFailures.map((failure) => compilationFailureByPackage.get(failure.packageName) ?? failure);
  for (const failure of compilationFailures) {
    if (!collected.sources.some((source) => source.pluginId === failure.pluginId)
      && !collected.pluginFailures.some((row) => row.packageName === failure.packageName)) {
      collected.pluginFailures.push(failure);
    }
  }
  const brands = await collectBundledPluginBrandMarks(repoRoot, pluginManifests,
    new Set(collected.pluginFailures.map((failure) => failure.packageName)));
  collected.pluginFailures.push(...brands.pluginFailures);
  if ((mode === 'check' || publicationMode === 'artifact') && collected.pluginFailures.length > 0) {
    throw new Error(`Bundled Plugin UI artifact publication failed for ${collected.pluginFailures.map((failure) => (
      `${failure.packageName}: ${failure.diagnostic.message}`
    )).join('; ')}`);
  }
  const { sources } = collected;
  const reportedFailures = [...new Map([...compilationFailures, ...collected.pluginFailures]
    .map((failure) => [failure.packageName, failure])).values()];
  const diagnostics = reportedFailures.map(({ pluginId, diagnostic }) => ({
    pluginId, ...diagnostic,
  }));
  const { computePluginUiArtifactSha256DigestV1 } = await import('@happier-dev/protocol/plugins/ui');
  const declarationPaths = new Map();
  for (const declaration of collected.declarations) {
    const typePath = relative(resolve(artifactStoreDir ?? dirname(outputPath), 'declarations', 'content'),
      resolve(repoRoot, 'apps/ui/sources/sync/domains/plugins/availability/bundledPluginUiArtifactInventory')).split(sep).join('/');
    const bytes = Buffer.from(renderBundledPluginUiDeclarationSource(declaration, typePath));
    const digest = computePluginUiArtifactSha256DigestV1(bytes).slice('sha256:'.length);
    const root = resolve(artifactStoreDir ?? dirname(outputPath), 'declarations', digest);
    const path = join(root, 'declaration.js');
    if (mode === 'write') await materializeArtifactGraph(root, [{ relativePath: 'declaration.js', bytes }], Boolean(artifactStoreDir));
    else if (!(await readFile(path)).equals(bytes)) throw new Error(`Bundled Plugin UI declaration is out of date: ${path}`);
    declarationPaths.set(declaration.pluginId, path);
  }
  const output = await renderBundledPluginUiArtifactInventory(sources, collected.declarations, collected.packagedResources, declarationPaths,
    collected.compilerRoots) + renderBundledPluginBrandMarks(brands.marks);
  if (mode === 'check') {
    let current = null;
    try {
      current = await readFile(outputPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (current !== output) {
      throw new Error(
        `Generated bundled Plugin UI app-preseed registry is out of date: ${relative(repoRoot, outputPath)}`,
      );
    }
    return { outputPath, pluginFailures: collected.pluginFailures, diagnostics };
  }

  try {
    if (await readFile(outputPath, 'utf8') === output) {
      if (publicationMode === 'live') {
        writeBundledPluginPublicationFailures(repoRoot, collected.pluginFailures);
      }
      return { outputPath, pluginFailures: collected.pluginFailures, diagnostics, artifactRoots: collected.artifactRoots };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp.${process.pid}`;
  await writeFile(temporaryPath, output, 'utf8');
  await rename(temporaryPath, outputPath);
  if (publicationMode === 'live') {
    writeBundledPluginPublicationFailures(repoRoot, collected.pluginFailures);
  }
  return { outputPath, pluginFailures: collected.pluginFailures, diagnostics, artifactRoots: collected.artifactRoots };
}

function readMode(argv) {
  const modeIndex = argv.indexOf('--mode');
  return modeIndex === -1 ? 'write' : argv[modeIndex + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateBundledPluginUiArtifacts({ mode: readMode(process.argv.slice(2)) }).then(({ diagnostics }) => {
    for (const diagnostic of diagnostics) {
      console.error(`[plugin:${diagnostic.pluginId}] ${diagnostic.code}: ${diagnostic.message}`);
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
