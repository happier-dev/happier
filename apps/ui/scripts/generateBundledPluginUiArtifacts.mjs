import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectBundledPluginUiDeclaration } from '../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';

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
  return { source, references: paths.slice(1), paths: Array.from(new Set(paths)) };
}

export function resolveBundledPluginUiArtifactsInputPaths(inventoryPath) {
  return readBundledPluginUiArtifactsInventory(inventoryPath)?.paths ?? null;
}

/** Recover roots from this producer's static rows without evaluating UI code.
 * These are candidates only; publication revalidates their entire byte graph. */
export function resolveBundledPluginUiArtifactsRetainedRoots(inventoryPath) {
  const retained = readBundledPluginUiArtifactsInventory(inventoryPath);
  const roots = new Map();
  if (!retained) return roots;
  const rows = /pluginId: ("(?:[^"\\]|\\.)*"),[\s\S]*?files: Object.freeze\(\[\s*Object.freeze\(\{\s*relativePath: ("(?:[^"\\]|\\.)*"),\s*asset: BUNDLED_PLUGIN_UI_APP_ASSET_(\d+),/g;
  for (const [, pluginId, relativePath, assetIndex] of retained.source.matchAll(rows)) {
    const path = retained.references[Number(assetIndex)];
    if (!path) continue;
    const segments = JSON.parse(relativePath).split('/');
    const root = resolve(dirname(path), ...segments.slice(1).map(() => '..'));
    if (resolve(root, ...segments) === path) roots.set(JSON.parse(pluginId), root);
  }
  return roots;
}

/** Seed the existing consumer inventory from producer-owned retained bytes.
 * Absolute references preserve the artifact graph across inventory locations;
 * the normal compiler can later replace this same file atomically for Metro.
 */
export async function retainBundledPluginUiArtifactsInventory({ inventoryPath, outputPath }) {
  const retained = readBundledPluginUiArtifactsInventory(inventoryPath);
  if (!retained) return false;
  let index = 0;
  const output = retained.source.replace(INVENTORY_REQUIRE, (_match, prefix) => `${prefix}require(${JSON.stringify(retained.references[index++])});`);
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

export async function collectBundledPluginUiArtifactSources(repoRoot, initialPluginFailures = [], artifactRoots, pluginManifests = {}, artifactOutputDirs = {}, artifactStoreDir) {
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
  const declarations = new Map();
  const publishedArtifactRoots = {};
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
    if (!artifactsRoot) break;
    if (artifactManifestError) {
      if (artifactManifestError.code === 'ENOENT') {
        const bundleExports = listBundledPluginUiArtifactExports(packageJson);
        if (bundleExports.length === 0 && !artifactRoots) continue;
        pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
        throw new Error(
          `Bundled Plugin UI artifact manifest is missing for '${pluginId}' with declared UI artifact exports: ${bundleExports.join(', ')}`,
        );
      }
      throw artifactManifestError;
    }

    pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
    if (!parsedManifest?.success) {
      throw new Error(`Invalid bundled Plugin UI artifact manifest for '${packageName}'`);
    }
    // App dependency membership applies to executable UI graphs. Daemon-only
    // packages may emit empty manifests and still contribute packaged brands.
    if (!artifactRoots && parsedManifest.data.entries.length > 0 && uiDependencies[packageName] !== packageVersion) {
      throw new Error(
        `apps/ui must depend on bundled Plugin UI package '${packageName}' at '${packageVersion}'`,
      );
    }

    let destination = artifactOutputDirs[pluginDirectory] && resolve(artifactOutputDirs[pluginDirectory]);
    const pluginSources = [];
    const pluginFiles = [];
    for (const entry of parsedManifest.data.entries) {
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
    if (!destination && artifactStoreDir) {
      // Reuse the canonical graph digest: changes in compiler inputs that emit
      // identical bytes must not duplicate those bytes in a serving Expo.
      const files = [...new Map(pluginFiles.map(file => [file.relativePath, file])).values()];
      const digest = computePluginUiArtifactFileSetSha256DigestV1(files);
      destination = resolve(artifactStoreDir, pluginDirectory, digest.slice('sha256:'.length));
    }
    // Finite native construction owns fresh output roots. Write the exact
    // bytes just verified, so a concurrent package publication cannot change
    // the retained graph between validation and materialization.
    if (destination && destination !== artifactsRoot) {
      await materializeArtifactGraph(destination, [...pluginFiles,
        { relativePath: 'ui-artifacts.json', bytes: Buffer.from(JSON.stringify(parsedManifest.data)) }], Boolean(artifactStoreDir));
      for (const source of pluginSources) {
        source.files = source.files.map((file) => ({ ...file,
          specifier: assertArtifactPath(destination, file.relativePath, source.packageName) }));
      }
    }
    publishedArtifactRoots[pluginDirectory] = destination ?? artifactsRoot;
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
  return { sources, declarations: [...declarations.values()].sort((left, right) => left.packageName.localeCompare(right.packageName)),
    pluginFailures, artifactRoots: publishedArtifactRoots };
}

function renderBundledPluginUiArtifactInventory(sources, declarations) {
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
  const assetSymbolBySpecifier = new Map();
  for (const source of sources) {
    for (const file of source.files) {
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
    lines.push(`const ${symbol} = ${JSON.stringify(declaration)};`);
  }
  if (declarationSymbolByPluginId.size > 0) lines.push('');
  lines.push(
    "/** @type {ReadonlyArray<import('./bundledPluginUiArtifactInventory').PluginHostBundledUiDeclaration>} */",
    'export const BUNDLED_PLUGIN_UI_APP_DECLARATIONS = Object.freeze([',
    ...[...declarationSymbolByPluginId.values()].map(symbol => `  ${symbol},`),
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
    mode === 'write' ? artifactOutputDirs : {}, mode === 'write' ? artifactStoreDir : undefined);
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
  const output = renderBundledPluginUiArtifactInventory(sources, collected.declarations) + renderBundledPluginBrandMarks(brands.marks);
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
