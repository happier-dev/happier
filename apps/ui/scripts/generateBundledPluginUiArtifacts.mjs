import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function listBundledPluginUiArtifactExports(packageJson) {
  return packageJson?.exports && typeof packageJson.exports === 'object'
    ? Object.entries(packageJson.exports).filter(([key, target]) => (
      key.startsWith('./happier-plugin-ui/')
      // Portable authored entries are direct source declarations. Conditional
      // platform modules (e.g. voice) retain their ordinary Metro source path;
      // they are not the universal app-preseed artifact compiler's inputs.
      && (key.endsWith('/entry.cjs.bundle') || typeof target === 'string')
    )).map(([key]) => key) : [];
}

async function collectBundledPluginUiArtifactSources(repoRoot, initialPluginFailures = [], artifactRoots, pluginManifests = {}) {
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
  const pluginDirectories = artifactRoots ? Object.keys(artifactRoots).sort() : (await readdir(pluginsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const sources = [];
  const pluginFailures = [...initialPluginFailures];
  const excludedPackageNames = new Set(initialPluginFailures.map((failure) => failure.packageName));
  const coordinateOwners = new Map();

  for (const pluginDirectory of pluginDirectories) {
    const candidatePackageName = `${PLUGIN_PACKAGE_PREFIX}${pluginDirectory}`;
    if (excludedPackageNames.has(candidatePackageName)) continue;
    const packageRoot = resolve(pluginsRoot, pluginDirectory);
    const artifactsRoot = artifactRoots ? resolve(artifactRoots[pluginDirectory]) : resolve(packageRoot, 'dist', 'happier-plugin-ui');
    const artifactsManifestPath = resolve(artifactsRoot, 'ui-artifacts.json');
    let pluginId = `happier.${pluginDirectory}`;
    try {
    let rawArtifactManifest;
    try {
      rawArtifactManifest = parseJson(await readFile(artifactsManifestPath, 'utf8'), artifactsManifestPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const packageJsonPath = resolve(packageRoot, 'package.json');
        const packageJson = parseJson(await readFile(packageJsonPath, 'utf8'), packageJsonPath);
        const bundleExports = listBundledPluginUiArtifactExports(packageJson);
        if (bundleExports.length === 0) continue;
        const pluginManifestPath = resolve(packageRoot, '.happier-plugin', 'plugin.json');
        const pluginManifest = parseJson(await readFile(pluginManifestPath, 'utf8'), pluginManifestPath);
        pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
        throw new Error(
          `Bundled Plugin UI artifact manifest is missing for '${pluginId}' with declared UI artifact exports: ${bundleExports.join(', ')}`,
        );
      }
      throw error;
    }

    const packageJsonPath = resolve(packageRoot, 'package.json');
    const pluginManifestPath = resolve(packageRoot, '.happier-plugin', 'plugin.json');
    const packageJson = parseJson(await readFile(packageJsonPath, 'utf8'), packageJsonPath);
    const pluginManifest = pluginManifests[pluginDirectory] ?? parseJson(await readFile(pluginManifestPath, 'utf8'), pluginManifestPath);
    const packageName = readRequiredString(packageJson, 'name', packageJsonPath);
    const packageVersion = readRequiredString(packageJson, 'version', packageJsonPath);
    pluginId = readRequiredString(pluginManifest, 'id', pluginManifestPath);
    if (!packageName.startsWith(PLUGIN_PACKAGE_PREFIX)) {
      throw new Error(`Bundled Plugin UI package '${packageName}' must use the '${PLUGIN_PACKAGE_PREFIX}' prefix`);
    }
    if (uiDependencies[packageName] !== packageVersion) {
      throw new Error(
        `apps/ui must depend on bundled Plugin UI package '${packageName}' at '${packageVersion}'`,
      );
    }

    const parsedManifest = PluginUiArtifactsManifestV2Schema.safeParse(rawArtifactManifest);
    if (!parsedManifest.success) {
      throw new Error(`Invalid bundled Plugin UI artifact manifest for '${packageName}'`);
    }

    const pluginSources = [];
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
        files: [...entry.files]
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
          .map((file) => ({ relativePath: file.relativePath, specifier: artifactRoots
            ? assertArtifactPath(artifactsRoot, file.relativePath, packageName)
            : `${packageName}/happier-plugin-ui/${file.relativePath}` })),
      });
    }
    for (const source of pluginSources) {
      coordinateOwners.set([source.pluginId, source.artifactId, source.tier, source.packageVersion].join('\u001f'), source.packageName);
      sources.push(source);
    }
    } catch (error) {
      pluginFailures.push(createBundledPluginPublicationFailure({
        repoRoot,
        packageName: candidatePackageName,
        pluginId,
        code: 'plugin_ui_artifact_invalid',
        error,
      }));
    }
  }

  sources.sort((left, right) => (
    left.packageName.localeCompare(right.packageName)
    || left.artifactId.localeCompare(right.artifactId)
    || left.tier.localeCompare(right.tier)
    || left.digest.localeCompare(right.digest)
  ));
  return { sources, pluginFailures };
}

function renderBundledPluginUiArtifactInventory(sources) {
  const lines = [
    '/**',
    ' * GENERATED FILE CONTRACT (APP-BUNDLED-PLUGIN-UI-ARTIFACTS)',
    ' *',
    ' * This file is emitted by:',
    ' * - `apps/ui/scripts/generateBundledPluginUiArtifacts.mjs`',
    ' *',
    ' * Static module values below are immutable packaged bytes only. Artifact',
    ' * selection, currentness, cache custody, graph validation, and integrity',
    ' * remain owned by the Availability Artifact lease.',
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

export function resolveBundledPluginUiArtifactsOutputPath(repoRoot) {
  return resolve(repoRoot, GENERATED_OUTPUT_RELATIVE_PATH);
}

export async function generateBundledPluginUiArtifacts({
  repoRoot = resolve(uiDir, '../..'),
  mode = 'write',
  publicationMode = 'live',
  pluginFailures = [],
  outputPath = resolveBundledPluginUiArtifactsOutputPath(repoRoot),
  artifactRoots,
  pluginManifests,
} = {}) {
  if (mode !== 'write' && mode !== 'check') {
    throw new Error(`Unsupported bundled Plugin UI artifact generation mode '${String(mode)}'`);
  }
  if (publicationMode !== 'live' && publicationMode !== 'artifact') {
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
  const collected = await collectBundledPluginUiArtifactSources(repoRoot, initialFailures, artifactRoots, pluginManifests);
  if ((mode === 'check' || publicationMode === 'artifact') && collected.pluginFailures.length > 0) {
    throw new Error(`Bundled Plugin UI artifact publication failed for ${collected.pluginFailures.map((failure) => (
      `${failure.packageName}: ${failure.diagnostic.message}`
    )).join('; ')}`);
  }
  const { sources } = collected;
  const diagnostics = collected.pluginFailures.map(({ pluginId, diagnostic }) => ({
    pluginId, ...diagnostic,
  }));
  const output = renderBundledPluginUiArtifactInventory(sources);
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
      return { outputPath, pluginFailures: collected.pluginFailures, diagnostics };
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
  return { outputPath, pluginFailures: collected.pluginFailures, diagnostics };
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
