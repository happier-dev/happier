import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveNpmCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const fixtureSourceRoot = join(packageRoot, 'fixtures/external-authoring');
const externalTargetedPackageSourceRoot = join(
  repositoryRoot,
  'packages/plugin-sdk/fixtures/external-targeted-packages/target',
);
const externalTargetedContributorPackageSourceRoot = join(
  repositoryRoot,
  'packages/plugin-sdk/fixtures/external-targeted-packages/contributor',
);
const requireFromPluginUi = createRequire(join(packageRoot, 'package.json'));
const requireFromPluginSdk = createRequire(join(repositoryRoot, 'packages/plugin-sdk/package.json'));
const requireFromUiApp = createRequire(join(repositoryRoot, 'apps/ui/package.json'));
const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const PLUGIN_UI_PACKAGE_NAME = '@happier-dev/plugin-ui';

const EXTERNAL_SEMANTIC_FRAMEWORK_ENTRIES = Object.freeze([
  Object.freeze({ label: 'React', path: ['node_modules', 'react', 'index.js'] }),
  Object.freeze({ label: 'React JSX runtime', path: ['node_modules', 'react', 'jsx-runtime.js'] }),
  Object.freeze({ label: 'React JSX development runtime', path: ['node_modules', 'react', 'jsx-dev-runtime.js'] }),
  Object.freeze({ label: 'React DOM', path: ['node_modules', 'react-dom', 'index.js'] }),
  Object.freeze({ label: 'React DOM client', path: ['node_modules', 'react-dom', 'client.js'] }),
  Object.freeze({ label: 'React Native Web', path: ['node_modules', 'react-native-web', 'dist', 'index.js'] }),
]);

// These declaration-only packages are not part of the public toolchain packet.
// Every runtime/framework/build package must instead come from the exact
// installed SDK's PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 below.
const EXTERNAL_AUTHORING_SUPPLEMENTAL_SUPPORT_PACKAGES = Object.freeze([
  Object.freeze({ name: '@types/react-dom', resolver: requireFromUiApp }),
  Object.freeze({ name: 'csstype', resolver: requireFromPluginUi }),
  Object.freeze({ name: 'zod', resolver: requireFromPluginSdk }),
  Object.freeze({ name: 'undici-types', resolver: requireFromPluginSdk }),
]);
const EXACT_PAIR_PACKAGE_NAMES = new Set([SDK_PACKAGE_NAME, PLUGIN_UI_PACKAGE_NAME]);

function pathIsInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === ''
    || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

function packageFileSpecifier(path) {
  return pathToFileURL(resolve(path)).href;
}

async function listSourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(entryPath));
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const EXTERNAL_TARGET_PUBLIC_IMPORTS = new Set([
  '@happier-dev/plugin-sdk',
  '@happier-dev/plugin-sdk/actions',
  '@happier-dev/plugin-sdk/agents/runtime',
  '@happier-dev/plugin-sdk/contributions',
  '@happier-dev/plugin-sdk/manifest',
  '@happier-dev/plugin-sdk/protocol',
  '@happier-dev/plugin-sdk/ui',
  '@happier-dev/plugin-sdk/ui/build',
  '@happier-dev/plugin-sdk/sessions/external',
  '@happier-dev/plugin-ui',
  'react',
]);

/** Fail before compilation when the external target reaches around a public package export. */
export async function assertExternalTargetedPackagePublicBoundary({
  targetRoot,
  expectedPackageName = '@happier-fixture/physical-target',
  requiredPackageNames = [SDK_PACKAGE_NAME, PLUGIN_UI_PACKAGE_NAME],
} = {}) {
  if (typeof targetRoot !== 'string' || targetRoot.trim() === '') {
    throw new Error('External targeted package proof requires a target root');
  }
  const sourceRoot = join(targetRoot, 'src');
  const manifest = JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8'));
  if (manifest.name !== expectedPackageName) {
    throw new Error('External targeted package proof received the wrong package identity');
  }
  for (const [sectionName, dependencies] of Object.entries({
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  })) {
    for (const [packageName, version] of Object.entries(dependencies ?? {})) {
      if (typeof version !== 'string' || /^(?:file|link|workspace):/u.test(version)) {
        throw new Error(`External targeted package ${sectionName}.${packageName} substitutes workspace source`);
      }
    }
  }
  if (requiredPackageNames.some((packageName) => manifest.dependencies?.[packageName] !== '0.0.0')) {
    throw new Error('External targeted package must depend on its required public packages');
  }
  const sourceFiles = await listSourceFiles(sourceRoot);
  if (sourceFiles.length === 0) {
    throw new Error('External targeted package proof requires TypeScript source files');
  }

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8');
    const specifiers = source.matchAll(/\b(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu);
    for (const match of specifiers) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        if (!pathIsInside(sourceRoot, resolve(dirname(sourceFile), specifier))) {
          throw new Error(`External targeted package source escapes its package: ${specifier}`);
        }
        continue;
      }
      if (!EXTERNAL_TARGET_PUBLIC_IMPORTS.has(specifier)) {
        throw new Error(`External targeted package source imports a non-public dependency: ${specifier}`);
      }
    }
  }

  return Object.freeze([...sourceFiles].sort());
}

async function assertExternalTargetedContributorPackageDeclarations(contributorRoot) {
  const declarationPath = join(contributorRoot, 'dist', 'index.d.ts');
  const declaration = await readFile(declarationPath, 'utf8');
  for (const forbiddenReference of [
    '@happier-dev/protocol',
    '@happier-dev/plugin-sdk/src',
    '/apps/',
    '/packages/',
  ]) {
    if (declaration.includes(forbiddenReference)) {
      throw new Error(`External targeted contributor declaration leaks ${forbiddenReference}`);
    }
  }
  for (const requiredSymbol of ['contributorPlugin', 'manifest']) {
    if (!declaration.includes(requiredSymbol)) {
      throw new Error(`External targeted contributor declaration omits ${requiredSymbol}`);
    }
  }
  return Object.freeze([declarationPath]);
}

async function assertExternalTargetedPackageDeclarations(targetRoot) {
  const declarationPaths = [
    join(targetRoot, 'dist', 'index.d.ts'),
    join(targetRoot, 'dist', 'surface.d.ts'),
    join(targetRoot, 'dist', 'pluginUiBuild.d.ts'),
  ];
  const declarations = await Promise.all(declarationPaths.map((path) => readFile(path, 'utf8')));
  const declarationClosure = declarations.join('\n');
  for (const forbiddenReference of [
    '@happier-dev/protocol',
    '@happier-dev/plugin-sdk/src',
    '@happier-dev/plugin-ui/src',
    '/apps/',
    '/packages/',
  ]) {
    if (declarationClosure.includes(forbiddenReference)) {
      throw new Error(`External targeted package declaration leaks ${forbiddenReference}`);
    }
  }
  for (const requiredSymbol of [
    'physicalCopyTargetDetailNode',
    'selectPhysicalCopyDetailSurface',
    'renderPhysicalCopyTargetSurface',
    'pluginUiBuildConfig',
  ]) {
    if (!declarationClosure.includes(requiredSymbol)) {
      throw new Error(`External targeted package declaration omits ${requiredSymbol}`);
    }
  }
  return Object.freeze(declarationPaths);
}

function resolvePackageVersion(packageName, resolver) {
  const packageJson = resolver(`${packageName}/package.json`);
  if (!packageJson || typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`Support package ${packageName} has no published version`);
  }
  return packageJson.version;
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function rejectLegacyArtifactArgument(argv, flag) {
  if (argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`))) {
    throw new Error(`External author proof does not accept ${flag}; pass direct SDK and Plugin UI tarballs`);
  }
}

export function parseExternalAuthoringFixtureArgs(argv) {
  rejectLegacyArtifactArgument(argv, '--candidate');
  rejectLegacyArtifactArgument(argv, '--artifact-source');
  const sdkTarballPath = readFlag(argv, '--sdk-tarball');
  const pluginUiTarballPath = readFlag(argv, '--plugin-ui-tarball');
  if (!sdkTarballPath) throw new Error('Missing --sdk-tarball <sdk-tarball>');
  if (!pluginUiTarballPath) throw new Error('Missing --plugin-ui-tarball <plugin-ui-tarball>');
  if (!isAbsolute(sdkTarballPath) || !isAbsolute(pluginUiTarballPath)) {
    throw new Error('External author proof tarball paths must be absolute');
  }
  if (resolve(sdkTarballPath) === resolve(pluginUiTarballPath)) {
    throw new Error('External author proof SDK and Plugin UI tarballs must be distinct files');
  }
  return Object.freeze({ sdkTarballPath, pluginUiTarballPath });
}

function rejectProgrammaticArtifactSource({ artifactSource, candidateManifestPath }) {
  if (candidateManifestPath !== undefined) {
    throw new Error('External author proof does not accept a candidate manifest; pass direct SDK and Plugin UI tarballs');
  }
  if (artifactSource !== undefined) {
    throw new Error('External author proof does not accept an artifact source; pass direct SDK and Plugin UI tarballs');
  }
}

async function assertRegularTarball(tarballPath, label) {
  const stats = await lstat(tarballPath).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`External author proof ${label} tarball does not exist: ${tarballPath}`);
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`External author proof ${label} tarball must be an exact regular file`);
  }
}

export async function resolveExternalAuthoringFixtureTarballPaths({
  sdkTarballPath,
  pluginUiTarballPath,
  artifactSource,
  candidateManifestPath,
} = {}) {
  rejectProgrammaticArtifactSource({ artifactSource, candidateManifestPath });
  if (typeof sdkTarballPath !== 'string' || sdkTarballPath.trim() === '') {
    throw new Error('External author proof SDK tarball path must be a non-empty string');
  }
  if (typeof pluginUiTarballPath !== 'string' || pluginUiTarballPath.trim() === '') {
    throw new Error('External author proof Plugin UI tarball path must be a non-empty string');
  }
  if (!isAbsolute(sdkTarballPath) || !isAbsolute(pluginUiTarballPath)) {
    throw new Error('External author proof tarball paths must be absolute');
  }
  const sdkPath = resolve(sdkTarballPath);
  const pluginUiPath = resolve(pluginUiTarballPath);
  if (sdkPath === pluginUiPath) {
    throw new Error('External author proof SDK and Plugin UI tarballs must be distinct files');
  }
  await Promise.all([
    assertRegularTarball(sdkPath, 'SDK'),
    assertRegularTarball(pluginUiPath, 'Plugin UI'),
  ]);
  return Object.freeze({ sdkTarballPath: sdkPath, pluginUiTarballPath: pluginUiPath });
}

function readPacketDependencyVersions(bindings, groupName) {
  const group = bindings?.[groupName];
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(`Exact installed SDK toolchain packet has no ${groupName} dependency map`);
  }
  return Object.entries(group).map(([packageName, version]) => {
    if (typeof packageName !== 'string' || packageName.trim() === ''
      || typeof version !== 'string' || version.trim() === '') {
      throw new Error(`Exact installed SDK toolchain packet has an invalid ${groupName} dependency`);
    }
    return [packageName, version];
  });
}

export async function resolveInstalledExternalAuthoringToolchainBindings({ consumerRoot } = {}) {
  if (typeof consumerRoot !== 'string' || consumerRoot.trim() === '') {
    throw new Error('Exact installed SDK toolchain packet requires a consumer root');
  }
  const physicalConsumerRoot = await realpath(consumerRoot);
  const sdkRoot = join(physicalConsumerRoot, 'node_modules', ...SDK_PACKAGE_NAME.split('/'));
  const [physicalSdkRoot, packageEntry] = await Promise.all([
    realpath(sdkRoot),
    Promise.resolve(createRequire(join(physicalConsumerRoot, 'package.json')).resolve(`${SDK_PACKAGE_NAME}/ui/build`)),
  ]);
  const physicalEntry = await realpath(packageEntry);
  if (!pathIsInside(physicalSdkRoot, physicalEntry)) {
    throw new Error('Exact installed SDK toolchain packet resolved outside the installed SDK archive');
  }
  const installedSdkBuild = await import(pathToFileURL(physicalEntry).href);
  const bindings = installedSdkBuild.PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;
  const dependencies = readPacketDependencyVersions(bindings, 'dependencies');
  const devDependencies = readPacketDependencyVersions(bindings, 'devDependencies');
  return Object.freeze({
    dependencies: Object.freeze(Object.fromEntries(dependencies)),
    devDependencies: Object.freeze(Object.fromEntries(devDependencies)),
  });
}

/**
 * Resolves every framework/build dependency from the exact installed SDK
 * packet. The narrow supplementary declaration set is deliberately kept out
 * of that packet because it is not an authored runtime/toolchain contract.
 */
export async function resolveExternalAuthoringSupportPackageVersions({ consumerRoot } = {}) {
  const bindings = await resolveInstalledExternalAuthoringToolchainBindings({ consumerRoot });
  const packetOwnedDependencies = Object.entries({
    ...bindings.dependencies,
    ...bindings.devDependencies,
  }).filter(([packageName]) => !EXACT_PAIR_PACKAGE_NAMES.has(packageName));
  const supplementalDependencies = EXTERNAL_AUTHORING_SUPPLEMENTAL_SUPPORT_PACKAGES.map(({ name, resolver }) => [
    name,
    resolvePackageVersion(name, resolver),
  ]);
  return Object.freeze(Object.fromEntries([
    ...packetOwnedDependencies,
    ...supplementalDependencies,
  ]));
}

export function buildExternalAuthoringBootstrapPackageJson({
  sdkTarballPath,
  pluginUiTarballPath,
}) {
  return {
    name: 'happier-plugin-ui-external-author-bootstrap',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@happier-dev/plugin-sdk': packageFileSpecifier(sdkTarballPath),
      '@happier-dev/plugin-ui': packageFileSpecifier(pluginUiTarballPath),
    },
  };
}

export function buildExternalAuthoringFixturePackageJson({
  sdkVersion,
  pluginUiVersion,
  supportPackageVersions,
}) {
  return {
    name: '@happier-fixture/external-authoring',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: './dist-node/index.js',
    exports: {
      '.': './dist-node/index.js',
      './semantic-surface': './dist-node/semanticSurface.js',
      './surface': './dist-node/Surface.js',
    },
    files: ['dist-node', 'dist-vite', 'dist-browser', 'package.json'],
    dependencies: {
      '@happier-dev/plugin-sdk': sdkVersion,
      '@happier-dev/plugin-ui': pluginUiVersion,
    },
    devDependencies: supportPackageVersions,
  };
}

export function buildExternalAuthoringPackedHostPackageJson({
  sdkTarballPath,
  pluginUiTarballPath,
  authorTarballPath,
  supportPackageVersions,
}) {
  return {
    name: 'happier-plugin-ui-external-author-packed-host',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@happier-dev/plugin-sdk': packageFileSpecifier(sdkTarballPath),
      '@happier-dev/plugin-ui': packageFileSpecifier(pluginUiTarballPath),
      '@happier-fixture/external-authoring': packageFileSpecifier(authorTarballPath),
      ...supportPackageVersions,
    },
  };
}

/**
 * The exact external semantic runner may use repository-owned Vitest tooling,
 * but its framework modules must come from the clean consumer installation.
 */
export async function assertExternalSemanticFrameworkDependencies({ consumerRoot } = {}) {
  if (typeof consumerRoot !== 'string' || consumerRoot.trim() === '') {
    throw new Error('External semantic framework proof requires a consumer root');
  }
  const physicalConsumerRoot = await realpath(consumerRoot);
  const resolvedEntries = [];
  for (const frameworkEntry of EXTERNAL_SEMANTIC_FRAMEWORK_ENTRIES) {
    const physicalEntry = await realpath(join(consumerRoot, ...frameworkEntry.path));
    if (!pathIsInside(physicalConsumerRoot, physicalEntry)) {
      throw new Error(`${frameworkEntry.label} resolved outside the clean external consumer root`);
    }
    resolvedEntries.push(Object.freeze({
      label: frameworkEntry.label,
      entry: physicalEntry,
    }));
  }
  return Object.freeze(resolvedEntries);
}

export async function assertPackedTargetInstallations({
  consumerRoot,
  repositoryRoot: workspaceRoot,
  expectedPackages,
}) {
  const physicalConsumerRoot = await realpath(consumerRoot);
  const physicalWorkspaceRoot = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
  const installedPackages = [];
  for (const expectedPackage of expectedPackages) {
    const packageInstallRoot = join(
      consumerRoot,
      'node_modules',
      ...expectedPackage.packageName.split('/'),
    );
    const stats = await lstat(packageInstallRoot);
    const physicalPackageRoot = await realpath(packageInstallRoot);
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || !pathIsInside(physicalConsumerRoot, physicalPackageRoot)
      || pathIsInside(physicalWorkspaceRoot, physicalPackageRoot)
    ) {
      throw new Error(
        `External fixture resolved ${expectedPackage.packageName} through workspace source instead of its tarball`,
      );
    }

    const manifest = JSON.parse(await readFile(join(packageInstallRoot, 'package.json'), 'utf8'));
    if (
      manifest.name !== expectedPackage.packageName
      || (expectedPackage.version !== undefined && manifest.version !== expectedPackage.version)
    ) {
      throw new Error(`Installed ${expectedPackage.packageName} identity does not match its exact packed artifact`);
    }
    if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
      throw new Error(`Installed ${expectedPackage.packageName} has no package version`);
    }

    if (expectedPackage.packageName === SDK_PACKAGE_NAME) {
      let authorApiInventory;
      try {
        authorApiInventory = await readFile(join(packageInstallRoot, 'API.md'), 'utf8');
      } catch (error) {
        throw new Error(
          `Installed ${SDK_PACKAGE_NAME} is missing the generated author API inventory`,
          { cause: error },
        );
      }
      if (!authorApiInventory.includes('> Generated from `api-surface.json`. Do not hand-edit.')) {
        throw new Error(`Installed ${SDK_PACKAGE_NAME} has an invalid generated author API inventory`);
      }
    }

    try {
      await lstat(join(packageInstallRoot, 'src'));
      throw new Error(`Installed ${expectedPackage.packageName} unexpectedly contains workspace source`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    installedPackages.push(Object.freeze({
      packageName: manifest.name,
      version: manifest.version,
      packageRoot: physicalPackageRoot,
    }));
  }
  return Object.freeze(installedPackages);
}

async function assertPluginUiResolvesTopLevelSdk({ consumerRoot }) {
  const sdkRoot = await realpath(join(
    consumerRoot,
    'node_modules',
    ...SDK_PACKAGE_NAME.split('/'),
  ));
  const pluginUiRoot = await realpath(join(
    consumerRoot,
    'node_modules',
    ...PLUGIN_UI_PACKAGE_NAME.split('/'),
  ));
  const requireFromInstalledPluginUi = createRequire(join(pluginUiRoot, 'package.json'));
  const resolvedSdkEntry = await realpath(requireFromInstalledPluginUi.resolve(SDK_PACKAGE_NAME));
  if (!pathIsInside(sdkRoot, resolvedSdkEntry)) {
    throw new Error('Packed Plugin UI must resolve Plugin SDK from the exact top-level tarball installation');
  }
}

async function assertPackedExternalAuthoringFixtureInstallation({ packedHostRoot }) {
  const physicalPackedHostRoot = await realpath(packedHostRoot);
  const fixtureRoot = join(
    packedHostRoot,
    'node_modules',
    '@happier-fixture',
    'external-authoring',
  );
  const stats = await lstat(fixtureRoot);
  const physicalFixtureRoot = await realpath(fixtureRoot);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || !pathIsInside(physicalPackedHostRoot, physicalFixtureRoot)
    || pathIsInside(repositoryRoot, physicalFixtureRoot)
  ) {
    throw new Error('Packed host resolved the external author through workspace source instead of its tarball');
  }

  const manifest = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@happier-fixture/external-authoring' || manifest.version !== '0.1.0') {
    throw new Error('Packed host installed the wrong external author package');
  }
  for (const requiredOutput of [
    join('dist-node', 'index.js'),
    join('dist-node', 'semanticSurface.js'),
    join('dist-vite', 'plugin-ui-surface.js'),
    join('dist-browser', 'index.html'),
  ]) {
    try {
      await lstat(join(fixtureRoot, requiredOutput));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Packed external author fixture is missing ${requiredOutput}`);
      }
      throw error;
    }
  }
  try {
    await lstat(join(fixtureRoot, 'src'));
    throw new Error('Packed external author fixture unexpectedly contains source files');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ root: physicalFixtureRoot, version: manifest.version });
}

async function assertPublicPresentationContract(consumerRoot) {
  const packageRoot = join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-ui');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const presentationExport = packageJson.exports?.['./presentation'];
  const declarationPath = (
    presentationExport
    && typeof presentationExport === 'object'
    && typeof presentationExport.types === 'string'
  )
    ? presentationExport.types
    : undefined;
  if (!declarationPath?.startsWith('./')) {
    throw new Error('Packed plugin-ui presentation export has no public declaration entrypoint');
  }
  const declarationFile = resolve(packageRoot, declarationPath);
  if (!pathIsInside(packageRoot, declarationFile)) {
    throw new Error('Packed plugin-ui presentation declaration escapes its package root');
  }
  const declarations = await readFile(declarationFile, 'utf8');
  if (/\bHappierImage\b/u.test(declarations)) {
    throw new Error('Raw renderer export leaked through plugin-ui/presentation: HappierImage');
  }
  if (!/\bHappierBrandMark\b/u.test(declarations)) {
    throw new Error('Semantic BrandMark renderer is missing from plugin-ui/presentation');
  }
}

/**
 * TypeScript is structural, so the author fixture's negative object literals
 * prove that host metadata cannot be supplied but cannot distinguish a local
 * value vocabulary from an identically shaped imported Action schema. Inspect
 * the exact packed declaration to retain that owner boundary: Form and Select
 * may normalize into the Action schema internally, but they must not publish
 * an SDK or Protocol type through their curated author props.
 */
export async function assertPublicFormPropsAreCurated(consumerRoot) {
  const packageRoot = join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-ui');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const componentsExport = packageJson.exports?.['./components'];
  const declarationPath = (
    componentsExport
    && typeof componentsExport === 'object'
    && typeof componentsExport.types === 'string'
  )
    ? componentsExport.types
    : undefined;
  if (!declarationPath?.startsWith('./')) {
    throw new Error('Packed plugin-ui components export has no public declaration entrypoint');
  }
  const componentsDeclarationFile = resolve(packageRoot, declarationPath);
  if (!pathIsInside(packageRoot, componentsDeclarationFile)) {
    throw new Error('Packed plugin-ui components declaration escapes its package root');
  }
  const formDeclarationFile = resolve(dirname(componentsDeclarationFile), 'Form.d.ts');
  if (!pathIsInside(packageRoot, formDeclarationFile)) {
    throw new Error('Packed plugin-ui Form declaration escapes its package root');
  }
  const declarations = await readFile(formDeclarationFile, 'utf8');
  const declarationCode = declarations.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
  for (const forbiddenReference of [
    '@happier-dev/plugin-sdk',
    '@happier-dev/protocol',
    'ActionInputHints',
    'ActionInputOptionValue',
    'ActionInputPredicate',
    'optionsSourceId',
    'connectedAccountOptions',
  ]) {
    if (declarationCode.includes(forbiddenReference)) {
      throw new Error(`Packed plugin-ui Form declaration leaks ${forbiddenReference} through curated author props`);
    }
  }
}

export async function withTemporaryExternalAuthoringRoot(run) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-authoring-'));
  try {
    return await run(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function runCommand(command, args, { cwd, env = {}, stage, timeout = 120_000 }) {
  try {
    execFileSync(command, args, {
      cwd,
      env: {
        ...process.env,
        CI: '1',
        ...env,
      },
      stdio: 'inherit',
      timeout,
    });
  } catch (error) {
    throw new Error(`External author fixture failed at ${stage}`, { cause: error });
  }
}

function runNpmCommand(args, { cwd, cacheDir, stage }) {
  const invocation = resolveNpmCommandInvocation(args, {
    npmExecPath: process.env.npm_execpath,
    processExecPath: process.execPath,
  });
  runCommand(invocation.command, invocation.args, {
    cwd,
    env: {
      npm_config_audit: 'false',
      npm_config_cache: cacheDir,
      npm_config_fund: 'false',
    },
    stage,
    timeout: 180_000,
  });
}

function runTypeScriptConfig(consumerRoot, configName, { emit = false } = {}) {
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: repositoryRoot,
    workspaceDir: consumerRoot,
    processExecPath: process.execPath,
  });
  runCommand(
    invocation.command,
    [
      ...invocation.argsPrefix,
      ...(emit ? [] : ['--noEmit']),
      '-p',
      configName,
    ],
    {
      cwd: consumerRoot,
      stage: `typescript-${configName}`,
    },
  );
}

async function assertViteOutput(viteOutputRoot) {
  const outputNames = await readdir(viteOutputRoot);
  if (!outputNames.some((name) => /^plugin-ui-surface\.(?:js|mjs)$/u.test(name))) {
    throw new Error(`Vite did not emit the external plugin UI surface: ${outputNames.join(', ')}`);
  }
}

/** Verify the real browser bundle, not merely Vite's compile exit status. */
export async function assertExternalAuthoringBrowserOutput(browserOutputRoot) {
  const outputNames = await readdir(browserOutputRoot);
  if (!outputNames.includes('index.html')) {
    throw new Error('External author browser build is missing its entry document.');
  }
  let assetNames;
  try {
    assetNames = await readdir(join(browserOutputRoot, 'assets'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('External author browser build is missing its emitted script asset.');
    }
    throw error;
  }
  if (!assetNames.some((name) => /\.(?:js|mjs)$/u.test(name))) {
    throw new Error('External author browser build is missing its emitted script asset.');
  }
}

/**
 * Exercise Vite's development resolver against the exact external consumer.
 * Production builds do not exercise Vite's development-server request path,
 * so request the author entry through a real local server and force Vite to
 * transform that module before disposing the server.
 */
export async function assertExternalAuthoringViteDevServer({
  consumerRoot,
  configPath = join(consumerRoot, 'vite.browser.config.ts'),
  entryPaths = ['/src/browser.tsx'],
  viteModulePath,
} = {}) {
  if (typeof consumerRoot !== 'string' || consumerRoot.trim() === '') {
    throw new Error('External author Vite dev proof requires a consumer root');
  }
  if (
    !Array.isArray(entryPaths)
    || entryPaths.length === 0
    || entryPaths.some((entryPath) => (
      typeof entryPath !== 'string'
      || !entryPath.startsWith('/')
      || entryPath.split('/').includes('..')
    ))
  ) {
    throw new Error('External author Vite dev proof requires absolute in-root entry paths');
  }
  const physicalConsumerRoot = await realpath(consumerRoot);
  const physicalConfigPath = await realpath(configPath);
  if (!pathIsInside(physicalConsumerRoot, physicalConfigPath)) {
    throw new Error('External author Vite dev config must stay inside the consumer root');
  }

  const resolvedViteModulePath = viteModulePath
    ?? createRequire(join(consumerRoot, 'package.json')).resolve('vite');
  const { createServer } = await import(packageFileSpecifier(resolvedViteModulePath));
  let server;
  try {
    server = await createServer({
      root: physicalConsumerRoot,
      configFile: physicalConfigPath,
      logLevel: 'silent',
      clearScreen: false,
      // The proof explicitly transforms the entry below, so disable Vite's
      // asynchronous cold-start scanner. That keeps teardown bounded without
      // allowing an unrelated optimizer task to outlive the server.
      optimizeDeps: { noDiscovery: true },
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
      },
    });
    await server.listen();
    const serverUrl = server.resolvedUrls?.local?.[0];
    if (!serverUrl) {
      throw new Error('External author Vite dev server did not expose a loopback URL');
    }

    const htmlResponse = await fetch(serverUrl);
    if (!htmlResponse.ok) {
      throw new Error(`External author Vite dev server returned ${htmlResponse.status} for its entry document`);
    }
    for (const entryPath of entryPaths) {
      const transformedEntry = await server.transformRequest(entryPath);
      if (!transformedEntry?.code) {
        throw new Error(`External author Vite dev server did not transform ${entryPath}`);
      }
    }
    return Object.freeze({
      entryPaths: Object.freeze([...entryPaths]),
      entriesTransformed: true,
      htmlStatus: htmlResponse.status,
    });
  } finally {
    await server?.close();
  }
}

async function runExternalAuthoringFixtureInRoot({ tarballPaths, temporaryRoot }) {
  if (pathIsInside(repositoryRoot, temporaryRoot)) {
    throw new Error('External author fixture must run outside the workspace');
  }

  const consumerRoot = join(temporaryRoot, 'consumer');
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify(
    buildExternalAuthoringBootstrapPackageJson({
      sdkTarballPath: tarballPaths.sdkTarballPath,
      pluginUiTarballPath: tarballPaths.pluginUiTarballPath,
    }),
    null,
    2,
  )}\n`);

  runNpmCommand([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
  ], {
    cwd: consumerRoot,
    cacheDir: join(temporaryRoot, 'npm-cache'),
    stage: 'install-exact-tarballs',
  });

  const [sdkArtifact, pluginUiArtifact] = await assertPackedTargetInstallations({
    consumerRoot,
    repositoryRoot,
    expectedPackages: [
      { packageName: SDK_PACKAGE_NAME },
      { packageName: PLUGIN_UI_PACKAGE_NAME },
    ],
  });

  // The author source and manifest do not exist in this clean root until the
  // exact public SDK/UI pair has been installed and verified.
  await cp(fixtureSourceRoot, consumerRoot, { recursive: true });
  const supportPackageVersions = await resolveExternalAuthoringSupportPackageVersions({ consumerRoot });
  runNpmCommand([
    'install',
    '--ignore-scripts',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    ...Object.entries(supportPackageVersions).map(([name, version]) => `${name}@${version}`),
  ], {
    cwd: consumerRoot,
    cacheDir: join(temporaryRoot, 'npm-cache'),
    stage: 'install-declared-external-dependencies',
  });
  await assertPackedTargetInstallations({
    consumerRoot,
    repositoryRoot,
    expectedPackages: [
      { packageName: SDK_PACKAGE_NAME, version: sdkArtifact.version },
      { packageName: PLUGIN_UI_PACKAGE_NAME, version: pluginUiArtifact.version },
    ],
  });
  await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify(
    buildExternalAuthoringFixturePackageJson({
      sdkVersion: sdkArtifact.version,
      pluginUiVersion: pluginUiArtifact.version,
      supportPackageVersions,
    }),
    null,
    2,
  )}\n`);

  const externalTargetRoot = join(consumerRoot, 'external-targeted-surface-target');
  await cp(externalTargetedPackageSourceRoot, externalTargetRoot, { recursive: true });
  await assertExternalTargetedPackagePublicBoundary({ targetRoot: externalTargetRoot });
  const externalContributorRoot = join(consumerRoot, 'external-targeted-surface-contributor');
  await cp(externalTargetedContributorPackageSourceRoot, externalContributorRoot, { recursive: true });
  await assertExternalTargetedPackagePublicBoundary({
    targetRoot: externalContributorRoot,
    expectedPackageName: '@happier-fixture/physical-contributor',
    requiredPackageNames: [SDK_PACKAGE_NAME],
  });

  await assertPluginUiResolvesTopLevelSdk({ consumerRoot });
  await assertExternalSemanticFrameworkDependencies({ consumerRoot });

  await assertPublicPresentationContract(consumerRoot);
  await assertPublicFormPropsAreCurated(consumerRoot);
  for (const adversarialPackage of [
    'adversarial/private-plugin-ui-subpath',
    'adversarial/private-sdk-subpath',
  ]) {
    runCommand(process.execPath, [
      join(consumerRoot, adversarialPackage, 'src', 'assert-public-export-boundary.mjs'),
    ], {
      cwd: consumerRoot,
      stage: `public-export-negative-${adversarialPackage.split('/').at(-1)}`,
      timeout: 30_000,
    });
  }

  for (const configName of [
    'tsconfig.nodenext.json',
    'tsconfig.vite.json',
    'tsconfig.metro.json',
  ]) {
    runTypeScriptConfig(consumerRoot, configName);
  }

  // This is the existing 03a/03b target package, physically copied outside
  // the workspace and resolved against the exact top-level SDK/UI archives.
  runTypeScriptConfig(externalTargetRoot, 'tsconfig.json', { emit: true });
  const externalTargetDeclarations = await assertExternalTargetedPackageDeclarations(externalTargetRoot);
  runTypeScriptConfig(externalContributorRoot, 'tsconfig.json', { emit: true });
  const externalContributorDeclarations = await assertExternalTargetedContributorPackageDeclarations(
    externalContributorRoot,
  );

  runTypeScriptConfig(consumerRoot, 'tsconfig.runtime.json', { emit: true });
  runCommand(process.execPath, [join(consumerRoot, 'dist-node/runtime.js')], {
    cwd: consumerRoot,
    stage: 'nodenext-runtime-boot',
    timeout: 30_000,
  });
  runCommand(process.execPath, [join(consumerRoot, 'composerRuntimeProof.mjs')], {
    cwd: consumerRoot,
    stage: 'composer-authoring-runtime-proof',
    timeout: 30_000,
  });

  const requireFromExternalAuthor = createRequire(join(consumerRoot, 'package.json'));
  const vitePackageRoot = dirname(requireFromExternalAuthor.resolve('vite/package.json'));
  const viteOutputRoot = join(consumerRoot, 'dist-vite');
  runCommand(process.execPath, [
    join(vitePackageRoot, 'bin/vite.js'),
    'build',
    '--config',
    join(consumerRoot, 'vite.config.ts'),
    '--mode',
    'production',
  ], {
    cwd: consumerRoot,
    env: { HAPPIER_PLUGIN_UI_FIXTURE_OUT_DIR: viteOutputRoot },
    stage: 'vite-production-build',
  });
  await assertViteOutput(viteOutputRoot);

  const browserOutputRoot = join(consumerRoot, 'dist-browser');
  runCommand(process.execPath, [
    join(vitePackageRoot, 'bin/vite.js'),
    'build',
    '--config',
    join(consumerRoot, 'vite.browser.config.ts'),
    '--mode',
    'production',
  ], {
    cwd: consumerRoot,
    env: { HAPPIER_PLUGIN_UI_BROWSER_OUT_DIR: browserOutputRoot },
    stage: 'vite-browser-production-build',
  });
  await assertExternalAuthoringBrowserOutput(browserOutputRoot);

  const viteDevelopmentServer = await assertExternalAuthoringViteDevServer({
    consumerRoot,
    // This advanced public author tier is otherwise mounted only by the RNW
    // semantic proof. Resolve it through Vite development as well, so the
    // exact packed `/advanced`, `/presentation`, and `/environment` entries cannot regress
    // behind a production-only build.
    entryPaths: ['/src/browser.tsx', '/src/semanticSurface.tsx'],
  });

  const fixturePackRoot = join(temporaryRoot, 'fixture-pack');
  await mkdir(fixturePackRoot, { recursive: true });
  runNpmCommand([
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    fixturePackRoot,
  ], {
    cwd: consumerRoot,
    cacheDir: join(temporaryRoot, 'npm-cache'),
    stage: 'pack-external-author-fixture',
  });
  const packedFixtureNames = (await readdir(fixturePackRoot))
    .filter((name) => name.endsWith('.tgz'))
    .sort();
  if (packedFixtureNames.length !== 1) {
    throw new Error('External author fixture pack must emit exactly one tarball');
  }
  const authorTarballPath = join(fixturePackRoot, packedFixtureNames[0]);
  await assertRegularTarball(authorTarballPath, 'external author fixture');

  const packedHostRoot = join(temporaryRoot, 'packed-host');
  await mkdir(packedHostRoot, { recursive: true });
  await writeFile(join(packedHostRoot, 'package.json'), `${JSON.stringify(
    buildExternalAuthoringPackedHostPackageJson({
      sdkTarballPath: tarballPaths.sdkTarballPath,
      pluginUiTarballPath: tarballPaths.pluginUiTarballPath,
      authorTarballPath,
      supportPackageVersions,
    }),
    null,
    2,
  )}\n`);
  runNpmCommand([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
  ], {
    cwd: packedHostRoot,
    cacheDir: join(temporaryRoot, 'npm-cache'),
    stage: 'install-packed-author-host',
  });
  const [packedHostSdkArtifact, packedHostPluginUiArtifact] = await assertPackedTargetInstallations({
    consumerRoot: packedHostRoot,
    repositoryRoot,
    expectedPackages: [
      { packageName: SDK_PACKAGE_NAME, version: sdkArtifact.version },
      { packageName: PLUGIN_UI_PACKAGE_NAME, version: pluginUiArtifact.version },
    ],
  });
  const packedAuthorFixture = await assertPackedExternalAuthoringFixtureInstallation({ packedHostRoot });
  await assertPluginUiResolvesTopLevelSdk({ consumerRoot: packedHostRoot });
  await assertExternalSemanticFrameworkDependencies({ consumerRoot: packedHostRoot });

  // The external author contributes an actual packed public surface. The
  // host-owned RNW semantic environment must mount that installed artifact,
  // never the author source tree used to prepare it.
  runCommand(process.execPath, [
    requireFromPluginUi.resolve('vitest/vitest.mjs'),
    'run',
    '--config',
    join(packageRoot, 'scripts/externalAuthoringSemanticProof.vitest.config.ts'),
  ], {
    cwd: packageRoot,
    env: {
      HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT: packedHostRoot,
      HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT: externalTargetRoot,
      HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT: externalContributorRoot,
    },
    stage: 'framework-owned-packed-public-semantic-lifecycle',
    timeout: 60_000,
  });

  return Object.freeze({
    consumerRoot,
    externalTargetPackage: Object.freeze({
      root: externalTargetRoot,
      declarations: externalTargetDeclarations,
    }),
    externalContributorPackage: Object.freeze({
      root: externalContributorRoot,
      declarations: externalContributorDeclarations,
    }),
    browserOutputRoot,
    viteDevelopmentServer,
    packedAuthorFixture,
    packedHostRoot,
    packages: Object.freeze({
      sdk: packedHostSdkArtifact,
      pluginUi: packedHostPluginUiArtifact,
    }),
  });
}

/**
 * Build the external-author fixture from exact package tarballs. The default
 * root is deleted after the proof. A caller that creates and supplies its own
 * external root owns cleanup, which permits a real browser to load the same
 * packed bytes before they are discarded.
 */
export async function runExternalAuthoringFixture({
  sdkTarballPath,
  pluginUiTarballPath,
  artifactSource,
  candidateManifestPath,
  temporaryRoot: requestedTemporaryRoot,
} = {}) {
  const tarballPaths = await resolveExternalAuthoringFixtureTarballPaths({
    sdkTarballPath,
    pluginUiTarballPath,
    artifactSource,
    candidateManifestPath,
  });
  if (requestedTemporaryRoot !== undefined) {
    const temporaryRoot = resolve(requestedTemporaryRoot);
    if (pathIsInside(repositoryRoot, temporaryRoot)) {
      throw new Error('External author fixture must run outside the workspace');
    }
    await mkdir(temporaryRoot, { recursive: true });
    const physicalTemporaryRoot = await realpath(temporaryRoot);
    const physicalRepositoryRoot = await realpath(repositoryRoot);
    if (pathIsInside(physicalRepositoryRoot, physicalTemporaryRoot)) {
      throw new Error('External author fixture must run outside the workspace');
    }
    if ((await readdir(physicalTemporaryRoot)).length > 0) {
      throw new Error('Caller-retained external fixture root must be an empty owned directory.');
    }
    return await runExternalAuthoringFixtureInRoot({ tarballPaths, temporaryRoot: physicalTemporaryRoot });
  }
  return await withTemporaryExternalAuthoringRoot(async (temporaryRoot) => (
    await runExternalAuthoringFixtureInRoot({ tarballPaths, temporaryRoot })
  ));
}

export async function main(argv = process.argv.slice(2)) {
  const { sdkTarballPath, pluginUiTarballPath } = parseExternalAuthoringFixtureArgs(argv);
  const result = await runExternalAuthoringFixture({ sdkTarballPath, pluginUiTarballPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedAsMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  await main();
}
