#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  PluginUiArtifactsManifestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import * as tar from 'tar';
import ts from 'typescript';

import {
  assertPackedAuthorCandidateArchivesSafe,
  assertPackedPackageIdentity,
  assertPackedPluginUiSdkDependency,
  readPackedPackageManifest,
} from './packed-author-artifact-boundary.mjs';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const APP_INVENTORY_DIRECTORY = join(
  'apps',
  'ui',
  'sources',
  'sync',
  'domains',
  'plugins',
  'availability',
);
const TARGETS = Object.freeze([
  Object.freeze({
    target: 'channels',
    packageName: '@happier-dev/plugins-channels',
    packageDirectoryName: 'channels',
    pluginId: 'happier.channels',
    contributionId: 'channels-app-native',
  }),
  Object.freeze({
    target: 'inspector',
    packageName: '@happier-dev/plugins-inspector',
    packageDirectoryName: 'inspector',
    pluginId: 'happier.inspector',
    contributionId: 'inspector-app-native',
  }),
]);
const PLATFORMS = Object.freeze(['web', 'ios', 'android']);
const PACKAGE_IDENTITIES = Object.freeze({
  sdk: Object.freeze({ packageName: '@happier-dev/plugin-sdk', version: '0.0.0' }),
  pluginUi: Object.freeze({ packageName: '@happier-dev/plugin-ui', version: '0.0.0' }),
  channelsProtocol: Object.freeze({ packageName: '@happier-dev/channels-protocol', version: '0.0.0' }),
  cli: Object.freeze({ packageName: '@happier-dev/cli', version: '0.2.10' }),
});

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Digest(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

function packagePathSegments(packageName) {
  return packageName.split('/');
}

function appArtifactRoot(repositoryRoot, target) {
  return join(
    repositoryRoot,
    'packages',
    'plugins',
    target.packageDirectoryName,
    'dist',
    'happier-plugin-ui',
  );
}

function packedCliArtifactRoot(cliPackageRoot, target) {
  return join(
    cliPackageRoot,
    'node_modules',
    ...packagePathSegments(target.packageName),
    'dist',
    'happier-plugin-ui',
  );
}

async function evaluateGeneratedInventorySource(source, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`Generated app inventory has TypeScript syntax errors: ${sourcePath}`);
  }
  const bindings = new Map();
  const assetMarker = Symbol('happier-generated-app-asset');
  const unwrap = (input) => {
    let node = input;
    while (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)
      || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node))
    ) {
      node = node.expression;
    }
    return node;
  };
  const propertyName = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
      return node.text;
    }
    throw new Error(`Generated app inventory uses an unsupported computed property in ${sourcePath}`);
  };
  const evaluate = (input) => {
    const node = unwrap(input);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      if (!bindings.has(node.text)) {
        throw new Error(`Generated app inventory references an unknown binding ${node.text}: ${sourcePath}`);
      }
      return bindings.get(node.text);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return Object.freeze(node.elements.map((element) => {
        if (ts.isSpreadElement(element)) {
          throw new Error(`Generated app inventory uses an unsupported array spread: ${sourcePath}`);
        }
        return evaluate(element);
      }));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const object = Object.create(null);
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          throw new Error(`Generated app inventory uses an unsupported object member: ${sourcePath}`);
        }
        object[propertyName(property.name)] = evaluate(property.initializer);
      }
      return Object.freeze(object);
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'Object'
        && node.expression.name.text === 'freeze'
        && node.arguments.length === 1
      ) {
        return evaluate(node.arguments[0]);
      }
      if (
        ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && node.arguments.length === 1
      ) {
        const specifier = evaluate(node.arguments[0]);
        if (
          typeof specifier !== 'string'
          || !/^@happier-dev\/plugins-[^/]+\/happier-plugin-ui\//u.test(specifier)
        ) {
          throw new Error(`Generated app inventory requested a non-asset module: ${String(specifier)}`);
        }
        return Object.freeze({ [assetMarker]: specifier });
      }
    }
    throw new Error(`Generated app inventory uses unsupported executable syntax ${ts.SyntaxKind[node.kind]}: ${sourcePath}`);
  };
  let directlyExportedInventoryBindingCount = 0;
  const reservedEvaluatorIntrinsicBindings = new Set(['Object', 'require']);
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) {
        throw new Error(`Generated app inventory contains an unsupported runtime import: ${sourcePath}`);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      const label = ts.isExportDeclaration(statement)
        ? 'export declaration'
        : ts.SyntaxKind[statement.kind];
      throw new Error(`Generated app inventory contains an unsupported top-level ${label}: ${sourcePath}`);
    }
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      throw new Error(`Generated app inventory variables must be const: ${sourcePath}`);
    }
    const declaresInventory = statement.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name)
      && declaration.name.text === 'BUNDLED_PLUGIN_UI_APP_ARTIFACTS'
    ));
    const modifierKinds = statement.modifiers?.map((modifier) => modifier.kind) ?? [];
    if (
      declaresInventory
      && (modifierKinds.length !== 1 || modifierKinds[0] !== ts.SyntaxKind.ExportKeyword)
    ) {
      throw new Error(`Generated app inventory declaration must have exactly the export modifier; BUNDLED_PLUGIN_UI_APP_ARTIFACTS must be the directly exported const binding: ${sourcePath}`);
    }
    if (!declaresInventory && modifierKinds.length !== 0) {
      throw new Error(`Generated app inventory asset declarations must have exactly no modifiers: ${sourcePath}`);
    }
    const isExported = declaresInventory;
    if (isExported && statement.declarationList.declarations.length !== 1) {
      throw new Error(`Generated app inventory exports must declare one binding: ${sourcePath}`);
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        throw new Error(`Generated app inventory uses an unsupported variable declaration: ${sourcePath}`);
      }
      if (reservedEvaluatorIntrinsicBindings.has(declaration.name.text)) {
        throw new Error(`Generated app inventory binding shadows reserved evaluator intrinsic ${declaration.name.text}: ${sourcePath}`);
      }
      if (bindings.has(declaration.name.text)) {
        throw new Error(`Generated app inventory redeclares ${declaration.name.text}: ${sourcePath}`);
      }
      if (declaration.name.text === 'BUNDLED_PLUGIN_UI_APP_ARTIFACTS') {
        if (!isExported) {
          throw new Error(`BUNDLED_PLUGIN_UI_APP_ARTIFACTS must be the directly exported const binding: ${sourcePath}`);
        }
        directlyExportedInventoryBindingCount += 1;
      } else if (isExported) {
        throw new Error(`Generated app inventory exports an unsupported binding ${declaration.name.text}: ${sourcePath}`);
      }
      bindings.set(declaration.name.text, evaluate(declaration.initializer));
    }
  }
  if (directlyExportedInventoryBindingCount !== 1) {
    throw new Error(`BUNDLED_PLUGIN_UI_APP_ARTIFACTS must be the directly exported const binding: ${sourcePath}`);
  }
  const inventory = bindings.get('BUNDLED_PLUGIN_UI_APP_ARTIFACTS');
  if (!Array.isArray(inventory)) {
    throw new Error(`Evaluated generated app inventory is not an array: ${sourcePath}`);
  }
  return Object.freeze(inventory.map((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files)) {
      throw new Error(`Evaluated generated app inventory entry ${entryIndex} is invalid: ${sourcePath}`);
    }
    return Object.freeze({
      pluginId: entry.pluginId,
      contributionId: entry.contributionId,
      tier: entry.tier,
      platform: entry.platform,
      digest: entry.digest,
      releaseVersion: entry.releaseVersion,
      files: Object.freeze(entry.files.map((file, fileIndex) => {
        if (!file || typeof file !== 'object' || typeof file.relativePath !== 'string') {
          throw new Error(`Evaluated generated app inventory file ${entryIndex}/${fileIndex} is invalid: ${sourcePath}`);
        }
        if (
          !file.asset
          || typeof file.asset !== 'object'
          || !Object.prototype.hasOwnProperty.call(file.asset, assetMarker)
        ) {
          throw new Error(`Generated app inventory file ${entryIndex}/${fileIndex} asset marker was not issued by the static evaluator: ${sourcePath}`);
        }
        return Object.freeze({
          relativePath: file.relativePath,
          assetSpecifier: file.asset[assetMarker],
        });
      })),
    });
  }));
}

function readGeneratedInventoryEntry(inventory, target, platform) {
  const matches = inventory.filter((entry) => (
    entry.pluginId === target.pluginId
    && entry.contributionId === target.contributionId
    && entry.platform === platform
  ));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one evaluated app inventory entry for ${target.target}/${platform}; received ${matches.length}`);
  }
  const entry = matches[0];
  for (const file of entry.files) {
    const expected = `${target.packageName}/happier-plugin-ui/${file.relativePath}`;
    if (file.assetSpecifier !== expected) {
      throw new Error(`Generated app asset specifier mismatch for ${target.target}/${platform}/${file.relativePath}: expected ${expected}, received ${String(file.assetSpecifier)}`);
    }
  }
  return entry;
}

async function collectArtifactTreeCensus(artifactRoot, manifest) {
  const expectedFiles = new Set([
    'ui-artifacts.json',
    ...manifest.entries.flatMap((entry) => entry.files.map((file) => file.relativePath)),
  ]);
  const actualFiles = [];
  const nonRegularPaths = [];
  async function visit(path) {
    const stats = await lstat(path);
    const relativePath = relative(artifactRoot, path).split(sep).join('/');
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      nonRegularPaths.push(relativePath);
      return;
    }
    if (stats.isFile()) {
      actualFiles.push(relativePath);
      return;
    }
    const entries = await readdir(path, { withFileTypes: true });
    await Promise.all(entries.map((entry) => visit(join(path, entry.name))));
  }
  await visit(artifactRoot);
  actualFiles.sort();
  nonRegularPaths.sort();
  const missingFiles = [...expectedFiles].filter((path) => !actualFiles.includes(path)).sort();
  const unexpectedFiles = actualFiles.filter((path) => !expectedFiles.has(path)).sort();
  return Object.freeze({
    equal: missingFiles.length === 0 && unexpectedFiles.length === 0 && nonRegularPaths.length === 0,
    missingFiles: Object.freeze(missingFiles),
    unexpectedFiles: Object.freeze(unexpectedFiles),
    nonRegularPaths: Object.freeze(nonRegularPaths),
  });
}

async function readRepresentation({ artifactRoot, target, platform }) {
  const manifestBytes = await readFile(join(artifactRoot, 'ui-artifacts.json'));
  const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const [treeCensus] = await Promise.all([
    collectArtifactTreeCensus(artifactRoot, manifest),
  ]);
  const entries = manifest.entries.filter((entry) => (
    entry.contributionId === target.contributionId
    && entry.tier === 'reactNative'
    && entry.platform === platform
  ));
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one artifact manifest entry for ${target.target}/${platform}; received ${entries.length}`);
  }
  const entry = entries[0];
  const files = [];
  let fileMetadataValid = true;
  for (const file of entry.files) {
    const bytes = await readFile(join(artifactRoot, file.relativePath));
    if (sha256Digest(bytes) !== file.digest || bytes.byteLength !== file.byteSize) {
      fileMetadataValid = false;
    }
    files.push(Object.freeze({ relativePath: file.relativePath, bytes }));
  }
  const computedDigest = computePluginUiArtifactFileSetSha256DigestV1(files);
  return Object.freeze({
    manifestBytes,
    entry,
    files: Object.freeze(files),
    computedDigest,
    graphValid: fileMetadataValid && computedDigest === entry.digest,
    treeCensus,
  });
}

function compareFileSubset(leftFiles, rightFiles, predicate) {
  const left = new Map(leftFiles.filter(predicate).map((file) => [file.relativePath, file.bytes]));
  const right = new Map(rightFiles.filter(predicate).map((file) => [file.relativePath, file.bytes]));
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) {
    const other = right.get(path);
    if (!other || !bytes.equals(other)) return false;
  }
  return true;
}

function isPortableAbsolutePath(value) {
  return isAbsolute(value)
    || win32.isAbsolute(value)
    || /^file:\/\//iu.test(value);
}

function collectPathLeakFindings(representation, files, forbiddenRoots) {
  const findings = [];
  const seen = new Set();
  const addFinding = (relativePath, value) => {
    const key = `${relativePath}\0${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(Object.freeze({ representation, relativePath, value }));
  };
  for (const file of files) {
    const raw = file.bytes.toString('utf8');
    for (const forbiddenRoot of forbiddenRoots) {
      const portable = forbiddenRoot.replace(/\\/gu, '/');
      if (portable && raw.replace(/\\/gu, '/').includes(portable)) {
        addFinding(file.relativePath, forbiddenRoot);
      }
    }
    if (!file.relativePath.endsWith('.map')) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      addFinding(file.relativePath, '<invalid-source-map-json>');
      continue;
    }
    const candidates = [
      ...(Array.isArray(parsed.sources) ? parsed.sources : []),
      ...(typeof parsed.sourceRoot === 'string' ? [parsed.sourceRoot] : []),
    ].filter((value) => typeof value === 'string');
    for (const value of candidates) {
      if (isPortableAbsolutePath(value)) {
        addFinding(file.relativePath, value);
      }
    }
  }
  return findings;
}

export async function comparePackedCliArtifactGraphsToAppSource({
  repositoryRoot,
  cliPackageRoot,
}) {
  const evaluatedInventories = new Map(await Promise.all(PLATFORMS.map(async (platform) => {
    const path = join(repositoryRoot, APP_INVENTORY_DIRECTORY, `generatedBundledPluginUiArtifacts.${platform}.ts`);
    const source = await readFile(path, 'utf8');
    return [platform, await evaluateGeneratedInventorySource(source, path)];
  })));
  const rows = [];
  for (const target of TARGETS) {
    const appRoot = appArtifactRoot(repositoryRoot, target);
    const packedRoot = packedCliArtifactRoot(cliPackageRoot, target);
    for (const platform of PLATFORMS) {
      const generated = readGeneratedInventoryEntry(evaluatedInventories.get(platform), target, platform);
      const [app, packed] = await Promise.all([
        readRepresentation({ artifactRoot: appRoot, target, platform }),
        readRepresentation({ artifactRoot: packedRoot, target, platform }),
      ]);
      const generatedFilesEqual = generated.files.length === app.files.length
        && generated.files.every((file, index) => file.relativePath === app.files[index]?.relativePath);
      const pathLeakFindings = [
        ...collectPathLeakFindings('appSource', app.files, [repositoryRoot]),
        ...collectPathLeakFindings('packedCli', packed.files, [repositoryRoot, cliPackageRoot]),
      ];
      const manifestEqual = app.manifestBytes.equals(packed.manifestBytes);
      const fileEqual = compareFileSubset(app.files, packed.files, (file) => !file.relativePath.endsWith('.map'));
      const mapEqual = compareFileSubset(app.files, packed.files, (file) => file.relativePath.endsWith('.map'));
      const digestEqual = app.graphValid
        && packed.graphValid
        && app.entry.digest === packed.entry.digest
        && app.entry.digest === generated.digest
        && generated.tier === 'reactNative'
        && generated.releaseVersion === '0.0.0'
        && generatedFilesEqual;
      const packedTreeCensusEqual = packed.treeCensus.equal;
      const row = Object.freeze({
        target: target.target,
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        platform,
        digest: app.entry.digest,
        fileCount: app.files.filter((file) => !file.relativePath.endsWith('.map')).length,
        mapCount: app.files.filter((file) => file.relativePath.endsWith('.map')).length,
        manifestEqual,
        fileEqual,
        mapEqual,
        digestEqual,
        packedTreeCensusEqual,
        packedTreeMissingFiles: packed.treeCensus.missingFiles,
        packedTreeUnexpectedFiles: packed.treeCensus.unexpectedFiles,
        packedTreeNonRegularPaths: packed.treeCensus.nonRegularPaths,
        pathLeakFindings: Object.freeze(pathLeakFindings),
        ok: manifestEqual
          && fileEqual
          && mapEqual
          && digestEqual
          && packedTreeCensusEqual
          && pathLeakFindings.length === 0,
      });
      rows.push(row);
    }
  }
  return Object.freeze({
    ok: rows.every((row) => row.ok),
    rows: Object.freeze(rows),
  });
}

async function readCheckoutSourceIdentity(repositoryRoot) {
  const paths = [
    ...PLATFORMS.map((platform) => join(APP_INVENTORY_DIRECTORY, `generatedBundledPluginUiArtifacts.${platform}.ts`)),
    ...TARGETS.map((target) => join('packages', 'plugins', target.packageDirectoryName, 'dist', 'happier-plugin-ui', 'ui-artifacts.json')),
  ];
  const files = Object.fromEntries(await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(join(repositoryRoot, path));
    return [path, Object.freeze({ byteSize: bytes.byteLength, sha256: sha256Hex(bytes) })];
  })));
  let gitHead = null;
  let dirtyPaths = [];
  try {
    gitHead = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
    const status = (await execFile('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths], { cwd: repositoryRoot })).stdout.trim();
    dirtyPaths = status ? status.split('\n') : [];
  } catch {
    // The file identities remain sufficient when the command is copied outside Git.
  }
  return Object.freeze({ repositoryRoot, gitHead, dirtyPaths: Object.freeze(dirtyPaths), files: Object.freeze(files) });
}

async function inspectTarball(path) {
  const bytes = await readFile(path);
  return Object.freeze({ path: resolve(path), byteSize: bytes.byteLength, sha256: sha256Hex(bytes) });
}

async function extractPackedCliPluginUiTrees(cliTarballPath, extractionRoot) {
  const prefixes = TARGETS.map((target) => (
    `package/node_modules/${target.packageName}/dist/happier-plugin-ui/`
  ));
  const packageManifests = TARGETS.map((target) => (
    `package/node_modules/${target.packageName}/package.json`
  ));
  await mkdir(extractionRoot, { recursive: true });
  await tar.x({
    file: cliTarballPath,
    cwd: extractionRoot,
    strict: true,
    filter: (path) => prefixes.some((prefix) => path.startsWith(prefix)) || packageManifests.includes(path),
  });
  for (const target of TARGETS) {
    const manifest = JSON.parse(await readFile(join(
      extractionRoot,
      'package',
      'node_modules',
      ...packagePathSegments(target.packageName),
      'package.json',
    ), 'utf8'));
    assertPackedPackageIdentity(manifest, { packageName: target.packageName, version: '0.0.0' }, `Packed CLI nested ${target.target}`);
  }
  return join(extractionRoot, 'package');
}

export async function auditPackedPluginUiArtifactGraphs({
  sdkTarballPath,
  pluginUiTarballPath,
  channelsProtocolTarballPath,
  cliTarballPath,
  repositoryRoot = REPOSITORY_ROOT,
}) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-packed-plugin-ui-graph-audit-'));
  try {
    const [archives, tarballs] = await Promise.all([
      assertPackedAuthorCandidateArchivesSafe({
        sdkTarballPath,
        pluginUiTarballPath,
        channelsProtocolTarballPath,
        cliTarballPath,
      }),
      Promise.all([
        ['sdk', sdkTarballPath],
        ['pluginUi', pluginUiTarballPath],
        ['channelsProtocol', channelsProtocolTarballPath],
        ['cli', cliTarballPath],
      ].map(async ([name, path]) => [name, await inspectTarball(path)])),
    ]);
    const [sdkManifest, pluginUiManifest, channelsProtocolManifest, cliManifest] = await Promise.all([
      readPackedPackageManifest(sdkTarballPath, join(tempRoot, 'sdk')),
      readPackedPackageManifest(pluginUiTarballPath, join(tempRoot, 'plugin-ui')),
      readPackedPackageManifest(channelsProtocolTarballPath, join(tempRoot, 'channels-protocol')),
      readPackedPackageManifest(cliTarballPath, join(tempRoot, 'cli-manifest')),
    ]);
    assertPackedPackageIdentity(sdkManifest, PACKAGE_IDENTITIES.sdk, 'Packed SDK');
    assertPackedPackageIdentity(pluginUiManifest, PACKAGE_IDENTITIES.pluginUi, 'Packed Plugin UI');
    assertPackedPackageIdentity(channelsProtocolManifest, PACKAGE_IDENTITIES.channelsProtocol, 'Packed Channels protocol');
    assertPackedPackageIdentity(cliManifest, PACKAGE_IDENTITIES.cli, 'Packed CLI');
    assertPackedPluginUiSdkDependency(pluginUiManifest, PACKAGE_IDENTITIES.sdk);

    const cliPackageRoot = await extractPackedCliPluginUiTrees(cliTarballPath, join(tempRoot, 'cli-graphs'));
    const [comparison, checkoutSource] = await Promise.all([
      comparePackedCliArtifactGraphsToAppSource({ repositoryRoot, cliPackageRoot }),
      readCheckoutSourceIdentity(repositoryRoot),
    ]);
    return Object.freeze({
      ok: comparison.ok,
      tarballs: Object.freeze(Object.fromEntries(tarballs)),
      archiveEntryCounts: Object.freeze(archives),
      checkoutSource,
      rows: comparison.rows,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv.length !== 4) {
    throw new Error('Usage: audit-packed-plugin-ui-artifact-graphs.mjs <sdk.tgz> <plugin-ui.tgz> <channels-protocol.tgz> <cli.tgz>');
  }
  const result = await auditPackedPluginUiArtifactGraphs({
    sdkTarballPath: resolve(argv[0]),
    pluginUiTarballPath: resolve(argv[1]),
    channelsProtocolTarballPath: resolve(argv[2]),
    cliTarballPath: resolve(argv[3]),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
