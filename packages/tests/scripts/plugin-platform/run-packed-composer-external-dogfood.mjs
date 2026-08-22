#!/usr/bin/env node

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveNpmCommandInvocation } from '../../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from '../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import {
  assertPackedPackageIdentity,
  assertPackedPluginUiSdkDependency,
  readPackedPackageManifest,
} from './packed-author-artifact-boundary.mjs';
import {
  assertExternalAuthoringViteDevServer,
  assertPackedTargetInstallations,
  buildExternalAuthoringBootstrapPackageJson,
  parseExternalAuthoringFixtureArgs,
  resolveExternalAuthoringFixtureTarballPaths,
  resolveExternalAuthoringSupportPackageVersions,
  withTemporaryExternalAuthoringRoot,
} from '../../../plugin-ui/scripts/validateExternalAuthoringFixture.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureRelDir = 'packages/tests/fixtures/plugin-platform/composer-external-dogfood';
const fixtureRoot = resolve(repositoryRoot, fixtureRelDir);
const fixturePackageName = 'happier-composer-external-dogfood';
const fixturePackageVersion = '0.0.0';
const sdkPackageName = '@happier-dev/plugin-sdk';
const pluginUiPackageName = '@happier-dev/plugin-ui';
const composerDogfoodExactPairPackages = Object.freeze([sdkPackageName, pluginUiPackageName]);
const composerDogfoodFixtureBuildEntries = Object.freeze([
  'README.md',
  'happier-plugin-ui.config.mjs',
  'package.json',
  'scripts',
  'src',
]);
const composerDogfoodBrowserEntryUrl = '/composer-dogfood-browser-entry.ts';

export async function resolveComposerDogfoodSupportPackageVersions({ consumerRoot } = {}) {
  return await resolveExternalAuthoringSupportPackageVersions({ consumerRoot });
}

function fail(message) {
  throw new Error(message);
}

function pathIsInside(rootPath, candidatePath) {
  const pathRelative = relative(resolve(rootPath), resolve(candidatePath));
  return pathRelative === ''
    || (!isAbsolute(pathRelative) && pathRelative !== '..'
      && !pathRelative.startsWith('../') && !pathRelative.startsWith('..\\'));
}

function archiveSpecifier(archivePath) {
  return pathToFileURL(resolve(archivePath)).href;
}

function createComposerDogfoodDirectArtifact({ packageManifest, packageName, tarballPath, label }) {
  if (typeof packageManifest?.version !== 'string' || packageManifest.version.trim() === '') {
    fail(`${label} tarball package.json must declare a non-empty version`);
  }
  const artifact = Object.freeze({ packageName, version: packageManifest.version, tarballPath });
  assertPackedPackageIdentity(packageManifest, artifact, label);
  return artifact;
}

async function resolveComposerDogfoodPairArtifacts({ pairPaths, extractionRoot }) {
  const [sdkManifest, pluginUiManifest] = await Promise.all([
    readPackedPackageManifest(pairPaths.sdkTarballPath, join(extractionRoot, 'sdk')),
    readPackedPackageManifest(pairPaths.pluginUiTarballPath, join(extractionRoot, 'plugin-ui')),
  ]);
  const sdk = createComposerDogfoodDirectArtifact({
    packageManifest: sdkManifest,
    packageName: sdkPackageName,
    tarballPath: pairPaths.sdkTarballPath,
    label: 'Packed Composer dogfood SDK',
  });
  const pluginUiWithoutSdkVersion = createComposerDogfoodDirectArtifact({
    packageManifest: pluginUiManifest,
    packageName: pluginUiPackageName,
    tarballPath: pairPaths.pluginUiTarballPath,
    label: 'Packed Composer dogfood Plugin UI',
  });
  const pluginSdkVersion = assertPackedPluginUiSdkDependency(pluginUiManifest, sdk);
  return Object.freeze([
    sdk,
    Object.freeze({ ...pluginUiWithoutSdkVersion, pluginSdkVersion }),
  ]);
}

export function buildComposerDogfoodConsumerPackageJson({
  sdkTarballPath,
  pluginUiTarballPath,
  fixtureTarballPath,
  supportPackageVersions,
}) {
  const packageJson = buildExternalAuthoringBootstrapPackageJson({
    sdkTarballPath,
    pluginUiTarballPath,
  });
  return {
    ...packageJson,
    name: 'happier-composer-external-dogfood-consumer',
    dependencies: {
      ...packageJson.dependencies,
      ...supportPackageVersions,
      [fixturePackageName]: archiveSpecifier(fixtureTarballPath),
    },
  };
}

function resolveComposerDogfoodExternalDependencies(packageJson) {
  return Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  })
    .filter(([packageName]) => !composerDogfoodExactPairPackages.includes(packageName))
    .map(([packageName, version]) => {
      if (typeof version !== 'string' || version.trim() === '') {
        fail(`Composer dogfood fixture has an invalid declared external dependency: ${packageName}`);
      }
      return `${packageName}@${version}`;
    });
}

export function materializeComposerDogfoodFixturePackageJson({
  sourcePackageJson,
  sdkVersion,
  pluginUiVersion,
  supportPackageVersions,
}) {
  if (!sourcePackageJson || typeof sourcePackageJson !== 'object' || Array.isArray(sourcePackageJson)) {
    fail('Composer dogfood fixture source package.json must be an object');
  }
  const materializeDependencyGroup = (groupName) => {
    const dependencies = sourcePackageJson[groupName] ?? {};
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      fail(`Composer dogfood fixture ${groupName} must be an object`);
    }
    return Object.fromEntries(Object.entries(dependencies).map(([packageName, declaredVersion]) => {
      if (packageName === sdkPackageName) return [packageName, sdkVersion];
      if (packageName === pluginUiPackageName) return [packageName, pluginUiVersion];
      const version = supportPackageVersions?.[packageName];
      if (typeof version === 'string' && version.trim() !== '') return [packageName, version];
      if (typeof declaredVersion !== 'string' || declaredVersion.trim() === '') {
        fail(`Composer dogfood fixture has an invalid declared dependency: ${packageName}`);
      }
      return [packageName, declaredVersion];
    }));
  };
  return {
    ...sourcePackageJson,
    dependencies: materializeDependencyGroup('dependencies'),
    devDependencies: materializeDependencyGroup('devDependencies'),
  };
}

async function copyComposerDogfoodFixtureBuildInput({ fixtureBuildRoot, sourceFixtureRoot = fixtureRoot }) {
  for (const entry of composerDogfoodFixtureBuildEntries) {
    await cp(join(sourceFixtureRoot, entry), join(fixtureBuildRoot, entry), { recursive: true });
  }
}

function resolveNpmInvocation(args) {
  return resolveNpmCommandInvocation(args, {
    npmExecPath: process.env.npm_execpath,
    processExecPath: process.execPath,
  });
}

function runCommand(command, args, { cwd, env = {}, stage, timeout = 180_000 }) {
  try {
    execFileSync(command, args, {
      cwd,
      env: { ...process.env, CI: '1', ...env },
      stdio: 'inherit',
      timeout,
    });
  } catch (error) {
    throw new Error(`Composer dogfood failed at ${stage}`, { cause: error });
  }
}

function runNpm(args, { cwd, cacheDir, stage }) {
  const invocation = resolveNpmInvocation(args);
  runCommand(invocation.command, invocation.args, {
    cwd,
    env: {
      npm_config_audit: 'false',
      npm_config_cache: cacheDir,
      npm_config_fund: 'false',
    },
    stage,
  });
}

function runTypeScript(consumerRoot, configName) {
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: repositoryRoot,
    workspaceDir: consumerRoot,
    processExecPath: process.execPath,
  });
  runCommand(invocation.command, [...invocation.argsPrefix, '--noEmit', '-p', configName], {
    cwd: consumerRoot,
    stage: `typescript-${configName}`,
  });
}

export async function packComposerDogfoodFixture({
  destinationDir,
  fixtureBuildRoot,
  sdkTarballPath,
  pluginUiTarballPath,
  cacheDir = join(dirname(fixtureBuildRoot), 'npm-cache'),
  assertPackedTargetInstallationsImpl = assertPackedTargetInstallations,
  resolveExternalAuthoringSupportPackageVersionsImpl = resolveExternalAuthoringSupportPackageVersions,
  runNpmImpl = runNpm,
} = {}) {
  if (typeof fixtureBuildRoot !== 'string' || fixtureBuildRoot.trim() === '') {
    fail('Composer dogfood fixture build requires a clean external workspace');
  }
  const tarballName = `${fixturePackageName}-${fixturePackageVersion}.tgz`;
  const fixtureTarballPath = join(fixtureBuildRoot, tarballName);
  const destinationTarballPath = join(destinationDir, tarballName);

  const sourcePackageJson = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));
  if (
    sourcePackageJson?.name !== fixturePackageName
    || sourcePackageJson?.version !== fixturePackageVersion
  ) {
    fail('Composer dogfood fixture source has an unexpected package identity');
  }
  await lstat(destinationTarballPath).then(() => {
    fail(`Composer dogfood pack destination already exists: ${destinationTarballPath}`);
  }).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await mkdir(fixtureBuildRoot);
  await writeFile(join(fixtureBuildRoot, 'package.json'), `${JSON.stringify(
    buildExternalAuthoringBootstrapPackageJson({ sdkTarballPath, pluginUiTarballPath }),
    null,
    2,
  )}\n`);
  await runNpmImpl([
    'install',
    '--ignore-scripts',
    '--install-links=true',
    '--omit=peer',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    sdkTarballPath,
    pluginUiTarballPath,
  ], {
    cwd: fixtureBuildRoot,
    cacheDir,
    stage: 'install-exact-prepack-pair',
  });
  const installedPairArtifacts = await assertPackedTargetInstallationsImpl({
    consumerRoot: fixtureBuildRoot,
    repositoryRoot,
    expectedPackages: composerDogfoodExactPairPackages.map((packageName) => ({ packageName })),
  });
  const installedSdkArtifact = installedPairArtifacts.find((artifact) => artifact.packageName === sdkPackageName);
  const installedPluginUiArtifact = installedPairArtifacts.find((artifact) => artifact.packageName === pluginUiPackageName);
  if (!installedSdkArtifact?.version || !installedPluginUiArtifact?.version) {
    fail('Composer dogfood exact prepack pair did not expose both installed package versions');
  }
  const supportPackageVersions = await resolveExternalAuthoringSupportPackageVersionsImpl({
    consumerRoot: fixtureBuildRoot,
  });
  const fixturePackageJson = materializeComposerDogfoodFixturePackageJson({
    sourcePackageJson,
    sdkVersion: installedSdkArtifact.version,
    pluginUiVersion: installedPluginUiArtifact.version,
    supportPackageVersions,
  });
  await runNpmImpl([
    'install',
    '--ignore-scripts',
    '--install-links=true',
    '--omit=peer',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    ...resolveComposerDogfoodExternalDependencies(fixturePackageJson),
  ], {
    cwd: fixtureBuildRoot,
    cacheDir,
    stage: 'install-declared-external-dependencies',
  });
  await copyComposerDogfoodFixtureBuildInput({ fixtureBuildRoot });
  await writeFile(
    join(fixtureBuildRoot, 'package.json'),
    `${JSON.stringify(fixturePackageJson, null, 2)}\n`,
  );
  await runNpmImpl(['pack', '--dry-run'], {
    cwd: fixtureBuildRoot,
    cacheDir,
    stage: 'pack-fixture-dry-run',
  });
  await runNpmImpl(['pack'], {
    cwd: fixtureBuildRoot,
    cacheDir,
    stage: 'pack-fixture',
  });
  const tarballStats = await lstat(fixtureTarballPath).catch((error) => {
    if (error?.code === 'ENOENT') {
      fail('Composer dogfood pack did not produce its expected fixture archive');
    }
    throw error;
  });
  if (!tarballStats.isFile() || tarballStats.isSymbolicLink()) {
    fail('Composer dogfood pack did not produce a regular fixture archive');
  }
  await copyFile(fixtureTarballPath, destinationTarballPath);
  return Object.freeze({
    packageName: fixturePackageName,
    version: fixturePackageVersion,
    tarballPath: destinationTarballPath,
    supportPackageVersions,
  });
}

export async function assertInstalledComposerFixture({ consumerRoot, fixtureArtifact }) {
  const packageRoot = join(consumerRoot, 'node_modules', fixtureArtifact.packageName);
  const [stats, physicalConsumerRoot, physicalPackageRoot] = await Promise.all([
    lstat(packageRoot),
    realpath(consumerRoot),
    realpath(packageRoot),
  ]);
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !pathIsInside(physicalConsumerRoot, physicalPackageRoot)
    || pathIsInside(repositoryRoot, physicalPackageRoot)
  ) {
    fail('Composer dogfood fixture did not install as an exact external archive');
  }
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (
    packageJson.name !== fixtureArtifact.packageName
    || packageJson.version !== fixtureArtifact.version
    || packageJson.exports?.['.'] !== './src/index.mjs'
    || packageJson.exports?.['./composer'] !== './src/issueComposer.mjs'
    || packageJson.exports?.['./ui'] !== './src/issueSurface.mjs'
  ) {
    fail('Installed Composer dogfood package identity or public entries drifted');
  }
  const requireFromFixture = createRequire(join(physicalPackageRoot, 'package.json'));
  for (const packageName of [sdkPackageName, pluginUiPackageName]) {
    const expectedPackageRoot = await realpath(join(
      consumerRoot,
      'node_modules',
      ...packageName.split('/'),
    ));
    const resolvedEntry = await realpath(requireFromFixture.resolve(packageName));
    if (!pathIsInside(expectedPackageRoot, resolvedEntry)) {
      fail(
        `Composer dogfood fixture must resolve ${packageName} from the exact top-level tarball installation`,
      );
    }
  }
  await assertInstalledComposerFixtureUiArtifacts(physicalPackageRoot);
  return physicalPackageRoot;
}

async function assertInstalledComposerFixtureUiArtifacts(packageRoot) {
  const artifactRoot = join(packageRoot, 'dist', 'happier-plugin-ui');
  const artifactManifestPath = join(artifactRoot, 'ui-artifacts.json');
  const rawManifest = await readFile(artifactManifestPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') {
      fail('Composer dogfood package is missing its generated React Native artifact manifest');
    }
    throw error;
  });
  const [artifactRootStats, physicalArtifactRoot] = await Promise.all([
    lstat(artifactRoot),
    realpath(artifactRoot),
  ]);
  if (!artifactRootStats.isDirectory() || artifactRootStats.isSymbolicLink()) {
    fail('Composer dogfood generated React Native artifact root is not a regular directory');
  }
  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch (error) {
    throw new Error('Composer dogfood generated React Native artifact manifest is not JSON', {
      cause: error,
    });
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const expectedEntryKeys = [
    'reactNative:issue-surface-native:android',
    'reactNative:issue-surface-native:ios',
    'reactNative:issue-surface-native:web',
  ];
  const actualEntryKeys = entries.map((entry) => [
    entry?.tier,
    entry?.contributionId,
    entry?.platform,
  ].join(':')).sort();
  if (manifest?.version !== 1 || JSON.stringify(actualEntryKeys) !== JSON.stringify(expectedEntryKeys)) {
    fail('Composer dogfood generated React Native artifact manifest does not contain the exact web/iOS/Android surface');
  }

  for (const entry of entries) {
    const files = Array.isArray(entry?.files) ? entry.files : [];
    if (
      typeof entry?.entry !== 'string'
      || entry.entry.trim() === ''
      || files.length === 0
      || !files.some((file) => file?.relativePath === entry.entry)
    ) {
      fail('Composer dogfood generated React Native artifact entry is incomplete');
    }
    for (const file of files) {
      if (typeof file?.relativePath !== 'string' || file.relativePath.trim() === '') {
        fail('Composer dogfood generated React Native artifact file path is invalid');
      }
      const artifactPath = resolve(artifactRoot, file.relativePath);
      if (!pathIsInside(artifactRoot, artifactPath)) {
        fail('Composer dogfood generated React Native artifact file escapes its package root');
      }
      const stats = await lstat(artifactPath).catch((error) => {
        if (error?.code === 'ENOENT') {
          fail(`Composer dogfood generated React Native artifact file is missing: ${file.relativePath}`);
        }
        throw error;
      });
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail(`Composer dogfood generated React Native artifact file is not a regular file: ${file.relativePath}`);
      }
      const physicalArtifactPath = await realpath(artifactPath);
      if (!pathIsInside(physicalArtifactRoot, physicalArtifactPath)) {
        fail(`Composer dogfood generated React Native artifact file escapes its generated root: ${file.relativePath}`);
      }
    }
  }
}

async function listRegularFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listRegularFiles(path));
    } else if (entry.isFile()) {
      result.push(path);
    } else if (entry.isSymbolicLink()) {
      fail(`Composer dogfood source contains a symbolic link: ${path}`);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

const COMPOSER_DOGFOOD_PUBLIC_AUTHORING_PACKAGES = new Set([
  '@happier-dev/plugin-sdk',
  '@happier-dev/plugin-sdk/contributions',
  '@happier-dev/plugin-sdk/protocol',
  '@happier-dev/plugin-sdk/ui',
  '@happier-dev/plugin-ui',
  'react',
]);

function readComposerDogfoodModuleSpecifiers(source) {
  const specifiers = [];
  const staticModule = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?(['"])([^'"\n]+)\1/gmu;
  const dynamicModule = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/gmu;
  for (const pattern of [staticModule, dynamicModule]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  }
  return specifiers;
}

function isComposerDogfoodRelativeModuleSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isComposerDogfoodPublicPackageSpecifier(specifier) {
  return specifier.startsWith('node:')
    || COMPOSER_DOGFOOD_PUBLIC_AUTHORING_PACKAGES.has(specifier);
}

async function resolveNearestExistingPhysicalPath(path) {
  let candidatePath = path;
  while (true) {
    const physicalPath = await realpath(candidatePath).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (physicalPath !== undefined) return physicalPath;
    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) return undefined;
    candidatePath = parentPath;
  }
}

export async function assertComposerDogfoodPublicOnlySource(packageRoot) {
  const physicalPackageRoot = await realpath(packageRoot);
  const physicalSourceRoot = await realpath(join(physicalPackageRoot, 'src'));
  if (!pathIsInside(physicalPackageRoot, physicalSourceRoot)) {
    fail('Composer dogfood source root escapes its controlled package root');
  }
  const sourceFiles = await listRegularFiles(physicalSourceRoot);
  if (sourceFiles.length === 0) fail('Composer dogfood archive has no source files');
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8');
    for (const specifier of readComposerDogfoodModuleSpecifiers(source)) {
      if (isComposerDogfoodRelativeModuleSpecifier(specifier)) {
        const relativeModulePath = fileURLToPath(new URL(specifier, pathToFileURL(sourceFile)));
        if (!pathIsInside(physicalPackageRoot, relativeModulePath)) {
          fail(`Composer dogfood source relative module escapes its controlled package root: ${specifier}`);
        }
        const physicalRelativeModulePath = await resolveNearestExistingPhysicalPath(relativeModulePath);
        if (
          physicalRelativeModulePath !== undefined
          && !pathIsInside(physicalPackageRoot, physicalRelativeModulePath)
        ) {
          fail(`Composer dogfood source relative module escapes its controlled package root: ${specifier}`);
        }
      } else if (!isComposerDogfoodPublicPackageSpecifier(specifier)) {
        fail(
          `Composer dogfood source must use only relative modules and public Plugin SDK/Plugin UI imports: ${specifier}`,
        );
      }
    }
  }
  return Object.freeze({ sourceFileCount: sourceFiles.length });
}

async function stagePublicAuthoringChecks(consumerRoot) {
  const sourceTestRoot = join(fixtureRoot, 'test');
  const destinationTestRoot = join(consumerRoot, 'test');
  await mkdir(destinationTestRoot, { recursive: true });
  const typeScriptConfigs = buildComposerDogfoodTypeScriptConfigs();
  await Promise.all([
    cp(
      join(sourceTestRoot, 'external-semantic.test.mjs'),
      join(destinationTestRoot, 'external-semantic.test.mjs'),
    ),
    ...Object.entries(typeScriptConfigs).map(([configName, config]) => writeFile(
      join(consumerRoot, configName),
      `${JSON.stringify(config, null, 2)}\n`,
    )),
  ]);
}

export function buildComposerDogfoodTypeScriptConfigs() {
  const files = [
    `node_modules/${fixturePackageName}/src/index.mjs`,
    `node_modules/${fixturePackageName}/src/issueComposer.mjs`,
    `node_modules/${fixturePackageName}/src/issueSurface.mjs`,
    `node_modules/${fixturePackageName}/src/uiBuildIdentity.mjs`,
  ];
  const base = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      types: ['react'],
    },
    files,
  };
  return Object.freeze({
    'tsconfig.nodenext.json': base,
    'tsconfig.vite.json': {
      ...base,
      compilerOptions: {
        ...base.compilerOptions,
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
    },
    'tsconfig.metro.json': {
      ...base,
      compilerOptions: {
        ...base.compilerOptions,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        customConditions: ['react-native'],
      },
    },
  });
}

export function buildComposerDogfoodSmokeSource() {
  return [
    "const sdk = await import('@happier-dev/plugin-sdk');",
    "const sdkUi = await import('@happier-dev/plugin-sdk/ui');",
    `const plugin = await import(${JSON.stringify(fixturePackageName)});`,
    `const composer = await import(${JSON.stringify(`${fixturePackageName}/composer`)});`,
    "const { readFile } = await import('node:fs/promises');",
    "const { join } = await import('node:path');",
    "const { isDeepStrictEqual } = await import('node:util');",
    `const packageRoot = join(process.cwd(), 'node_modules', ${JSON.stringify(fixturePackageName)});`,
    "const diskManifest = JSON.parse(await readFile(join(packageRoot, '.happier-plugin', 'plugin.json'), 'utf8'));",
    "if (typeof plugin.activate !== 'function') throw new Error('packed Composer dogfood did not export activation');",
    "if (!plugin.manifest || typeof plugin.manifest !== 'object') throw new Error('packed Composer dogfood did not export a manifest');",
    "if (typeof sdk.defineComposerAttachment !== 'function') throw new Error('packed SDK Composer attachment authoring did not load');",
    "if (typeof composer.attachIssueWithoutControl !== 'function') throw new Error('packed Composer dogfood document helper did not load');",
    "if (typeof composer.attachDaemonIssueMediaFromCurrentComposer !== 'function') throw new Error('packed Composer dogfood daemon-media helper did not load');",
    "if (typeof composer.attachIssueMediaFromCurrentComposer !== 'function') throw new Error('packed Composer dogfood staged-media helper did not load');",
    "if (typeof composer.inspectAndReleaseIssueMediaFromCurrentComposer !== 'function') throw new Error('packed Composer dogfood release helper did not load');",
    "if (plugin.manifest.id !== 'acme.composer.issue-dogfood') throw new Error('packed Composer dogfood has the wrong plugin identity');",
    "const daemonMediaAttachment = plugin.manifest.contributes?.composerAttachments?.find(({ id }) => id === 'issue-media');",
    "if (daemonMediaAttachment?.runtime?.prepareForSend !== true) throw new Error('packed Composer dogfood did not declare daemon media preparation');",
    "if (!isDeepStrictEqual(diskManifest, JSON.parse(JSON.stringify(plugin.manifest)))) throw new Error('packed Composer dogfood manifest drifted from source projection');",
    "const stagedHandle = { v: 1, id: 'external-stage-42', executionTarget: { serverId: 'external-server', machineId: 'external-machine' }, owner: { pluginId: 'acme.composer.issue-dogfood', localId: 'issue-media' }, mediaKind: 'image', mimeType: 'image/png', name: 'issue-evidence.png', sizeBytes: 4, sha256: 'a'.repeat(64) };",
    "if (!sdkUi.ComposerContentHandleV1Schema.safeParse(stagedHandle).success) throw new Error('packed public SDK rejected its opaque Composer content handle');",
    "for (const privateField of [{ path: '/tmp/issue-evidence.png' }, { uri: 'file:///tmp/issue-evidence.png' }, { base64: 'iVBORw==' }, { bytes: [0x89, 0x50] }, { credential: 'secret' }, { sessionId: 'private-session-42' }, { transferSessionId: 'private-transfer-42' }]) {",
    "  if (sdkUi.ComposerContentHandleV1Schema.safeParse({ ...stagedHandle, ...privateField }).success) throw new Error('packed public SDK admitted private Composer custody fields');",
    "}",
    "const stagedTransaction = { expectedRevision: 29, operations: [{ kind: 'attachment.add', attachmentLocalId: 'issue-media', value: { key: 'issue-media:EXT-42', value: { issueId: 'EXT-42' }, presentation: { label: 'Image evidence for Issue EXT-42' } }, content: { kind: 'stagedMedia', handle: stagedHandle } }] };",
    "if (!sdkUi.ComposerTransactionV1Schema.safeParse(stagedTransaction).success) throw new Error('packed public SDK rejected the approved staged Composer attachment path');",
    "for (const privateSpecifier of ['@happier-dev/plugin-sdk/src/definePlugin.js', '@happier-dev/plugin-ui/src/composer/service.js']) {",
    "  let privateImportError;",
    "  try { await import(privateSpecifier); } catch (error) { privateImportError = error; }",
    "  if (privateImportError?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw new Error(`packed public package admitted private import ${privateSpecifier}`);",
    "}",
  ].join('\n');
}

export function buildComposerDogfoodViteEntryDocument() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>Composer dogfood</title>',
    '</head>',
    '<body>',
    '  <div id="root"></div>',
    `  <script type="module" src="${composerDogfoodBrowserEntryUrl}"></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

async function runComposerDogfoodViteProof({ consumerRoot }) {
  const configPath = join(consumerRoot, 'vite.composer-dogfood.config.mjs');
  const entryPath = join(consumerRoot, composerDogfoodBrowserEntryUrl.slice(1));
  const outputRoot = join(consumerRoot, 'dist-composer-dogfood');
  await Promise.all([
    writeFile(join(consumerRoot, 'index.html'), buildComposerDogfoodViteEntryDocument()),
    writeFile(entryPath, [
      `export { renderComposerIssueSurface } from ${JSON.stringify(`${fixturePackageName}/ui`)};`,
      '',
    ].join('\n')),
    writeFile(configPath, [
      "import { resolve } from 'node:path';",
      '',
      'export default {',
      '  resolve: {',
      "    alias: { 'react-native': resolve(process.cwd(), 'node_modules/react-native-web/dist/index.js') },",
      "    dedupe: ['react', 'react-dom'],",
      '  },',
      '  build: {',
      `    outDir: ${JSON.stringify(outputRoot)},`,
      '    emptyOutDir: true,',
      '    lib: {',
      `      entry: ${JSON.stringify(entryPath)},`,
      "      formats: ['es'],",
      "      fileName: 'composer-dogfood',",
      '    },',
      '  },',
      '};',
      '',
    ].join('\n')),
  ]);

  const requireFromConsumer = createRequire(join(consumerRoot, 'package.json'));
  const vitePackageRoot = dirname(requireFromConsumer.resolve('vite/package.json'));
  runCommand(process.execPath, [
    join(vitePackageRoot, 'bin/vite.js'),
    'build',
    '--config',
    configPath,
    '--mode',
    'production',
  ], {
    cwd: consumerRoot,
    stage: 'vite-production-build',
  });
  const outputNames = await readdir(outputRoot);
  if (!outputNames.some((name) => /^composer-dogfood\.(?:js|mjs)$/u.test(name))) {
    fail(`Composer dogfood Vite build emitted no UI bundle: ${outputNames.join(', ')}`);
  }
  return await assertExternalAuthoringViteDevServer({
    consumerRoot,
    configPath,
    entryPaths: [composerDogfoodBrowserEntryUrl],
  });
}

export async function runPackedComposerExternalDogfood({
  sdkTarballPath,
  pluginUiTarballPath,
  candidateManifestPath,
  artifactSource,
} = {}) {
  const pairPaths = await resolveExternalAuthoringFixtureTarballPaths({
    sdkTarballPath,
    pluginUiTarballPath,
    candidateManifestPath,
    artifactSource,
  });
  return await withTemporaryExternalAuthoringRoot(async (temporaryRoot) => {
    const packedRoot = join(temporaryRoot, 'packed');
    const fixtureBuildRoot = join(temporaryRoot, 'fixture-build');
    const consumerRoot = join(temporaryRoot, 'consumer');
    await Promise.all([mkdir(packedRoot), mkdir(consumerRoot)]);

    const pairArtifacts = await resolveComposerDogfoodPairArtifacts({
      pairPaths,
      extractionRoot: join(packedRoot, 'pair-manifests'),
    });
    const [sdkArtifact, pluginUiArtifact] = pairArtifacts;
    const fixtureArtifact = await packComposerDogfoodFixture({
      destinationDir: packedRoot,
      fixtureBuildRoot,
      sdkTarballPath: sdkArtifact.tarballPath,
      pluginUiTarballPath: pluginUiArtifact.tarballPath,
      cacheDir: join(temporaryRoot, 'npm-cache'),
    });
    await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify(
      buildComposerDogfoodConsumerPackageJson({
        sdkTarballPath: sdkArtifact.tarballPath,
        pluginUiTarballPath: pluginUiArtifact.tarballPath,
        fixtureTarballPath: fixtureArtifact.tarballPath,
        supportPackageVersions: fixtureArtifact.supportPackageVersions,
      }),
      null,
      2,
    )}\n`);
    runNpm([
      'install',
      '--ignore-scripts',
      '--install-links=true',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
    ], {
      cwd: consumerRoot,
      cacheDir: join(temporaryRoot, 'npm-cache'),
      stage: 'install-exact-tarballs',
    });

    await assertPackedTargetInstallations({
      consumerRoot,
      repositoryRoot,
      expectedPackages: pairArtifacts,
    });
    const installedFixtureRoot = await assertInstalledComposerFixture({
      consumerRoot,
      fixtureArtifact,
    });
    const sourceBoundary = await assertComposerDogfoodPublicOnlySource(installedFixtureRoot);

    await stagePublicAuthoringChecks(consumerRoot);
    for (const configName of [
      'tsconfig.nodenext.json',
      'tsconfig.vite.json',
      'tsconfig.metro.json',
    ]) {
      runTypeScript(consumerRoot, configName);
    }
    runCommand(process.execPath, ['--test', 'test/external-semantic.test.mjs'], {
      cwd: consumerRoot,
      stage: 'packed-plugin-semantic-test',
      timeout: 30_000,
    });
    runCommand(process.execPath, ['--input-type=module', '-e', buildComposerDogfoodSmokeSource()], {
      cwd: consumerRoot,
      stage: 'packed-plugin-runtime-smoke',
      timeout: 30_000,
    });
    const viteDevelopmentServer = await runComposerDogfoodViteProof({ consumerRoot });

    return Object.freeze({
      ok: true,
      provenance: Object.freeze({
        sdk: Object.freeze({
          packageName: sdkArtifact.packageName,
          version: sdkArtifact.version,
          tarballPath: sdkArtifact.tarballPath,
        }),
        pluginUi: Object.freeze({
          packageName: pluginUiArtifact.packageName,
          version: pluginUiArtifact.version,
          pluginSdkVersion: pluginUiArtifact.pluginSdkVersion,
          tarballPath: pluginUiArtifact.tarballPath,
        }),
      }),
      fixture: Object.freeze({
        packageName: fixtureArtifact.packageName,
        version: fixtureArtifact.version,
        sourceBoundary,
      }),
      viteDevelopmentServer,
      cleanup: Object.freeze({ disposition: 'removed' }),
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { sdkTarballPath, pluginUiTarballPath } = parseExternalAuthoringFixtureArgs(argv);
  const result = await runPackedComposerExternalDogfood({ sdkTarballPath, pluginUiTarballPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedAsMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  await main();
}
