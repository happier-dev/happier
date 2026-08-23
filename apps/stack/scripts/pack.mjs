import './utils/env/env.mjs';
import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { runCapture } from './utils/proc/proc.mjs';
import { resolveWorkspaceToolBinDirs } from './utils/proc/workspace_tool_bins.mjs';
import { pathExists } from './utils/fs/fs.mjs';

const VALID_TARGETS = ['cli', 'server', 'ui'];
const INTERNAL_PACKAGE_PREFIX = '@happier-dev/';
const PLUGINS_PACKAGE_PREFIX = '@happier-dev/plugins-';
const INTERNAL_WORKSPACE_NAME_PATTERN = /^@happier-dev\/([A-Za-z0-9_][A-Za-z0-9._-]*)$/u;

function normalizePathForComparison(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pathIsInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === ''
    || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function targetFromLegacyComponent(component) {
  const c = String(component ?? '').trim();
  if (c === 'happy') return 'ui';
  if (c === 'happy-cli') return 'cli';
  if (c === 'happy-server' || c === 'happy-server-light') return 'server';
  return null;
}

function legacyComponentFromTarget(target) {
  const t = String(target ?? '').trim();
  if (t === 'ui') return 'happy';
  if (t === 'cli') return 'happy-cli';
  if (t === 'server') return 'happy-server';
  return null;
}

export async function findMonorepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    const lock = join(dir, 'yarn.lock');
    if ((await pathExists(pkg)) && (await pathExists(lock))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readJson(path) {
  const sourceStats = await lstat(path);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error(`[pack] JSON source must be a regular file: ${path}`);
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

async function copyRequiredRegularFile(sourcePath, destinationPath) {
  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error(`[pack] pack source file must be a regular file: ${sourcePath}`);
  }
  await copyFile(sourcePath, destinationPath);
}

async function loadWorkspaceRuntimeDependencies({ monorepoRoot }) {
  const sourceModulePath = join(
    monorepoRoot,
    'packages',
    'cli-common',
    'workspaceRuntimeDependencies.mjs',
  );
  const sourceWorkspaceManifestPath = join(
    monorepoRoot,
    'packages',
    'cli-common',
    'package.json',
  );
  const sourceModuleExists = await pathExists(sourceModulePath);
  if (!sourceModuleExists && await pathExists(sourceWorkspaceManifestPath)) {
    throw new Error(
      '[pack] source cli-common workspace is missing its runtime dependency owner: '
        + sourceModulePath,
    );
  }
  if (sourceModuleExists) {
    const sourceModuleStats = await lstat(sourceModulePath);
    if (sourceModuleStats.isSymbolicLink() || !sourceModuleStats.isFile()) {
      throw new Error(
        `[pack] workspace runtime dependency owner must be a regular file: ${sourceModulePath}`,
      );
    }
  }
  const runtimeDependencies = await (
    sourceModuleExists
      ? import(pathToFileURL(sourceModulePath).href)
      : import('@happier-dev/cli-common/workspaceRuntimeDependencies')
  );
  for (const exportName of [
    'copyDirDereferenceContainedSync',
    'parsePackageNameSegments',
    'vendorRuntimeDependencyTree',
  ]) {
    if (typeof runtimeDependencies[exportName] !== 'function') {
      throw new Error(
        `[pack] workspace runtime dependency owner is missing ${exportName}: ${sourceModulePath}`,
      );
    }
  }
  return runtimeDependencies;
}

function readBundledDependencyNames(rawPackageJson) {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function readBundledInternalWorkspacePackageNames(rawPackageJson) {
  return readBundledDependencyNames(rawPackageJson)
    .filter((packageName) => packageName.startsWith(INTERNAL_PACKAGE_PREFIX));
}

function collectInternalWorkspaceDepNames(rawPackageJson, { includeBuildOnly = false } = {}) {
  const result = new Set();
  const dependencyGroups = [rawPackageJson?.dependencies, rawPackageJson?.optionalDependencies];
  if (includeBuildOnly) {
    dependencyGroups.push(rawPackageJson?.devDependencies, rawPackageJson?.peerDependencies);
  }
  for (const deps of dependencyGroups) {
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const packageName of Object.keys(deps)) {
      if (packageName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
        result.add(packageName);
      }
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

export function resolveInternalWorkspaceRelDir(packageName) {
  const normalizedPackageName = String(packageName ?? '').trim();
  if (!normalizedPackageName.startsWith(INTERNAL_PACKAGE_PREFIX)) {
    return null;
  }
  const packageNameMatch = INTERNAL_WORKSPACE_NAME_PATTERN.exec(normalizedPackageName);
  if (!packageNameMatch) {
    throw new Error(`[pack] invalid internal workspace package name: ${normalizedPackageName}`);
  }
  const workspaceName = packageNameMatch[1];
  if (normalizedPackageName.startsWith(PLUGINS_PACKAGE_PREFIX)) {
    const pluginWorkspaceName = normalizedPackageName.slice(PLUGINS_PACKAGE_PREFIX.length);
    if (!pluginWorkspaceName) {
      throw new Error(`[pack] invalid internal workspace package name: ${normalizedPackageName}`);
    }
    return `packages/plugins/${pluginWorkspaceName}`;
  }

  return `packages/${workspaceName}`;
}

async function resolveBundledInternalWorkspacePackageNameClosure({
  monorepoRoot,
  packageNames,
  includeBuildOnly = false,
}) {
  const visited = new Set();

  async function visit(packageName) {
    const normalizedPackageName = String(packageName ?? '').trim();
    if (!normalizedPackageName.startsWith(INTERNAL_PACKAGE_PREFIX) || visited.has(normalizedPackageName)) {
      return;
    }
    visited.add(normalizedPackageName);

    const workspaceRelDir = resolveInternalWorkspaceRelDir(normalizedPackageName);
    if (!workspaceRelDir) return;
    const packageJsonPath = join(monorepoRoot, workspaceRelDir, 'package.json');
    if (!(await pathExists(packageJsonPath))) return;

    const workspacePackageJson = await readJson(packageJsonPath);
    for (const dependencyName of collectInternalWorkspaceDepNames(workspacePackageJson, { includeBuildOnly })) {
      await visit(dependencyName);
    }
  }

  for (const packageName of packageNames) {
    await visit(packageName);
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

export async function resolvePackSandboxWorkspaceRelDirs({ monorepoRoot, packageRelDir }) {
  const packageJson = await readJson(join(monorepoRoot, packageRelDir, 'package.json'));
  const workspaceRelDirs = new Set([packageRelDir]);
  const bundledPackageNames = readBundledInternalWorkspacePackageNames(packageJson);
  const bundledPackageNameSet = new Set(bundledPackageNames);
  const bundledPackageNameClosure = await resolveBundledInternalWorkspacePackageNameClosure({
    monorepoRoot,
    packageNames: bundledPackageNames,
  });
  const missingClosureNames = bundledPackageNameClosure.filter((packageName) => !bundledPackageNameSet.has(packageName));
  if (missingClosureNames.length > 0) {
    throw new Error(
      [
        `[pack] Missing bundled internal workspace dependencies in ${join(monorepoRoot, packageRelDir, 'package.json')}:`,
        ...missingClosureNames.map((packageName) => `- ${packageName}`),
      ].join('\n'),
    );
  }

  for (const packageName of bundledPackageNameClosure) {
    const workspaceRelDir = resolveInternalWorkspaceRelDir(packageName);
    if (workspaceRelDir) workspaceRelDirs.add(workspaceRelDir);
  }

  return [...workspaceRelDirs].sort((left, right) => left.localeCompare(right));
}

async function readInternalWorkspacePackageNames({ monorepoRoot, workspaceRelDirs }) {
  const packageNames = [];
  for (const workspaceRelDir of workspaceRelDirs) {
    const packageJsonPath = join(monorepoRoot, workspaceRelDir, 'package.json');
    if (!(await pathExists(packageJsonPath))) continue;
    const packageJson = await readJson(packageJsonPath);
    const packageName = String(packageJson?.name ?? '').trim();
    if (packageName.startsWith(INTERNAL_PACKAGE_PREFIX)) packageNames.push(packageName);
  }
  return packageNames;
}

function normalizeWorkspaceRelDir(workspaceRelDir) {
  const normalizedWorkspaceRelDir = String(workspaceRelDir ?? '').trim().replaceAll('\\', '/');
  const segments = normalizedWorkspaceRelDir.split('/');
  if (
    !normalizedWorkspaceRelDir
    || isAbsolute(normalizedWorkspaceRelDir)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`[pack] invalid dependency workspace path: ${workspaceRelDir}`);
  }
  return {
    normalizedWorkspaceRelDir,
    segments,
  };
}

async function validatePackSandboxSourceRelDirs({
  monorepoRoot,
  workspaceRelDirs,
}) {
  const realMonorepoRoot = await realpath(monorepoRoot);
  return await Promise.all(workspaceRelDirs.map(async (workspaceRelDir) => {
    const {
      normalizedWorkspaceRelDir,
      segments,
    } = normalizeWorkspaceRelDir(workspaceRelDir);
    const sourcePath = join(monorepoRoot, ...segments);
    const sourceStats = await lstat(sourcePath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!sourceStats) return normalizedWorkspaceRelDir;
    if (sourceStats.isSymbolicLink()) {
      throw new Error(
        `[pack] dependency workspace must not resolve through a symbolic link: ${normalizedWorkspaceRelDir}`,
      );
    }
    const realSourcePath = await realpath(sourcePath);
    const expectedSourcePath = resolve(realMonorepoRoot, ...segments);
    if (
      !pathIsInside(realMonorepoRoot, realSourcePath)
      || normalizePathForComparison(realSourcePath)
        !== normalizePathForComparison(expectedSourcePath)
    ) {
      throw new Error(
        `[pack] dependency workspace must not resolve through a symbolic link: ${normalizedWorkspaceRelDir}`,
      );
    }
    return normalizedWorkspaceRelDir;
  }));
}

export async function resolvePackSandboxSourceRelDirs({ monorepoRoot, packageRelDir }) {
  const normalizedPackageRelDir = await validatePackSandboxPackageRelDir({
    monorepoRoot,
    packageRelDir,
  });
  const toolingWorkspaceNames = await resolveBundledInternalWorkspacePackageNameClosure({
    monorepoRoot,
    packageNames: ['@happier-dev/cli-common'],
  });
  const runtimeWorkspaceRelDirs = await resolvePackSandboxWorkspaceRelDirs({
    monorepoRoot,
    packageRelDir: normalizedPackageRelDir,
  });
  const runtimeWorkspaceNames = await readInternalWorkspacePackageNames({
    monorepoRoot,
    workspaceRelDirs: runtimeWorkspaceRelDirs,
  });
  const buildWorkspaceNames = await resolveBundledInternalWorkspacePackageNameClosure({
    monorepoRoot,
    packageNames: [...toolingWorkspaceNames, ...runtimeWorkspaceNames],
    includeBuildOnly: true,
  });
  const targetPackageJson = await readJson(join(monorepoRoot, normalizedPackageRelDir, 'package.json'));
  const targetPackageName = String(targetPackageJson?.name ?? '').trim();
  const buildWorkspaceRelDirs = buildWorkspaceNames
    .map((packageName) => (
      packageName === targetPackageName ? normalizedPackageRelDir : resolveInternalWorkspaceRelDir(packageName)
    ))
    .filter(Boolean);

  // The generator's own selector is the sole external-consumer inventory. An
  // installed hstack resolves it from the monorepo being packed rather than
  // importing SDK source from its own package installation.
  const publicToolchainGeneratorPath = join(
    monorepoRoot,
    'packages',
    'plugin-sdk',
    'scripts',
    'generatePublicToolchainCompatibility.mjs',
  );
  const publicToolchainConsumerSourceRelDirs = [];
  if (await pathExists(publicToolchainGeneratorPath)) {
    const { resolvePublicToolchainRequiredInputStagingRelDirs } = await import(
      pathToFileURL(publicToolchainGeneratorPath).href,
    );
    if (typeof resolvePublicToolchainRequiredInputStagingRelDirs !== 'function') {
      throw new Error('[pack] public toolchain generator has no staging selector');
    }
    for (const relativeDir of resolvePublicToolchainRequiredInputStagingRelDirs()) {
      if (await pathExists(join(monorepoRoot, relativeDir))) {
        publicToolchainConsumerSourceRelDirs.push(relativeDir);
      }
    }
  }
  // Capability availability is only valid when its declared public proof
  // consumer remains a regular source file. The matrix owns that inventory;
  // pack converts its selected leaves to source directories for staging.
  const capabilityMatrixCliPath = join(
    monorepoRoot,
    'packages',
    'plugin-sdk',
    'scripts',
    'capabilityMatrixCli.mjs',
  );
  const capabilityMatrixProvingConsumerSourceRelDirs = [];
  if (await pathExists(capabilityMatrixCliPath)) {
    const { resolveAvailableCapabilityMatrixProvingConsumerSourcePaths } = await import(
      pathToFileURL(capabilityMatrixCliPath).href,
    );
    if (typeof resolveAvailableCapabilityMatrixProvingConsumerSourcePaths !== 'function') {
      throw new Error('[pack] capability matrix has no available proving-consumer source selector');
    }
    const sourcePaths = await resolveAvailableCapabilityMatrixProvingConsumerSourcePaths({
      packageRoot: join(monorepoRoot, 'packages', 'plugin-sdk'),
    });
    for (const relativePath of sourcePaths) {
      const relativeDir = relativePath.slice(0, relativePath.lastIndexOf('/'));
      if (await pathExists(join(monorepoRoot, relativeDir))) {
        capabilityMatrixProvingConsumerSourceRelDirs.push(relativeDir);
      }
    }
  }
  // The CLI prepack publisher is a build owner, not a migration-tree utility.
  // Retain its entrypoint and canonical publisher module whenever a package
  // prepack reaches that owner from the temporary sandbox.
  const canonicalBuildOwnerRelDirs = [
    'apps/cli/scripts/buildSharedDeps.mjs',
    'apps/cli/scripts/build-owned',
  ];
  const canonicalBuildOwnerSourceRelDirs = [];
  for (const relativePath of canonicalBuildOwnerRelDirs) {
    if (await pathExists(join(monorepoRoot, relativePath))) {
      canonicalBuildOwnerSourceRelDirs.push(relativePath);
    }
  }
  // Public-package prepack scripts invoke this shared owner by its canonical
  // repository-relative path. Stage the owner itself, rather than weakening
  // those checks or creating package-local governance copies.
  const canonicalApiGovernanceOwnerRelDir = 'scripts/api-governance';
  const canonicalApiGovernanceOwnerSourceRelDirs = await pathExists(
    join(monorepoRoot, canonicalApiGovernanceOwnerRelDir),
  )
    ? [canonicalApiGovernanceOwnerRelDir]
    : [];
  const sourceRelDirs = [...new Set([
    'scripts/workspaces',
    'scripts/testing/process',
    ...buildWorkspaceRelDirs,
    ...runtimeWorkspaceRelDirs,
    ...publicToolchainConsumerSourceRelDirs,
    ...capabilityMatrixProvingConsumerSourceRelDirs,
    ...canonicalBuildOwnerSourceRelDirs,
    ...canonicalApiGovernanceOwnerSourceRelDirs,
  ])].sort((left, right) => left.localeCompare(right));
  return await validatePackSandboxSourceRelDirs({
    monorepoRoot,
    workspaceRelDirs: sourceRelDirs,
  });
}

async function resolveMonorepoComponentDir({ startDir, component }) {
  if (!startDir) return null;
  const monorepoRoot = await findMonorepoRoot(startDir);
  if (monorepoRoot) {
    try {
      const rootPkg = await readJson(join(monorepoRoot, 'package.json'));
      const name = String(rootPkg?.name ?? '').trim();
      if (name === 'monorepo') {
        if (component === 'happy-cli') return join(monorepoRoot, 'apps', 'cli');
        if (component === 'happy-server') return join(monorepoRoot, 'apps', 'server');
        if (component === 'happy') return join(monorepoRoot, 'apps', 'ui');
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export async function resolvePackDirForComponent({
  component,
  componentDir,
  explicitDir,
  rootDir = null,
}) {
  if (explicitDir) return explicitDir;

  // A repo-local hstack owns packing for its own checkout. Stack runtime variables can point at
  // another checkout (for example remote-dev), but must not redirect this checkout's release
  // artifact. Published hstack installations have no enclosing monorepo and retain the configured
  // component-dir fallback below.
  const localComponentDir = await resolveMonorepoComponentDir({ startDir: rootDir, component });
  if (localComponentDir) return localComponentDir;

  // Installed stacks often point the active repo dir at the monorepo root. Resolve its workspace
  // package when no repo-local owner exists.
  const configuredComponentDir = await resolveMonorepoComponentDir({ startDir: componentDir, component });
  if (configuredComponentDir) return configuredComponentDir;

  return componentDir;
}

function collectWorkspaceDependencyNames(packageJson) {
  const result = new Set();
  for (const dependencies of [
    packageJson?.dependencies,
    packageJson?.optionalDependencies,
    packageJson?.devDependencies,
    packageJson?.peerDependencies,
  ]) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const dependencyName of Object.keys(dependencies)) {
      result.add(dependencyName);
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

function collectExternalPackageDependencyNames(packageJson) {
  const result = new Set();
  for (const dependencies of [
    packageJson?.dependencies,
    packageJson?.optionalDependencies,
    packageJson?.peerDependencies,
  ]) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const dependencyName of Object.keys(dependencies)) {
      result.add(dependencyName);
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

const PACK_SANDBOX_IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.project',
  '.build',
  '.cache',
  '.runner-snapshots',
  '.yarn-cache',
  'coverage',
  'playwright-report',
  'test-results',
]);

function isTransientPackSandboxEntryName(name) {
  return (
    name.startsWith('.tmp.')
    || name.startsWith('.backup.')
    || name.startsWith('.restore.')
    || name.startsWith('.dist.build.')
    || name.startsWith('.dist.hstack-stage-')
    || name.startsWith('dist.staging.')
    || name.startsWith('dist.probe.')
  );
}

function isPluginSdkGeneratedExampleOutputPath(relativePath, workspaceRelDir) {
  if (workspaceRelDir !== 'packages/plugin-sdk') return false;
  const segments = String(relativePath ?? '').replaceAll('\\', '/').split('/');
  return segments[0] === 'examples' && segments.slice(1).includes('dist');
}

function isTypeScriptPackageBuildWorkTreePath(segments) {
  return segments.some((segment, index) => (
    segment === '.happier' && segments[index + 1] === 'typescript-package-build'
  ));
}

export function shouldIncludePackSandboxSourcePath(relativePath, { workspaceRelDir } = {}) {
  const normalizedRelativePath = String(relativePath ?? '').replaceAll('\\', '/');
  if (normalizedRelativePath === '') return true;
  const segments = normalizedRelativePath.split('/');
  if (isPluginSdkGeneratedExampleOutputPath(normalizedRelativePath, workspaceRelDir)) return false;
  if (isTypeScriptPackageBuildWorkTreePath(segments)) return false;
  if (
    segments.some((segment) => (
      PACK_SANDBOX_IGNORED_DIRECTORY_NAMES.has(segment)
      || isTransientPackSandboxEntryName(segment)
    ))
  ) {
    return false;
  }
  if (
    segments.some((segment, index) => (
      segment === 'tools' && segments[index + 1] === 'unpacked'
    ))
  ) {
    return false;
  }
  const name = segments.at(-1) ?? '';
  return !(
    name === '.DS_Store'
    || name === '.tsbuildinfo'
    || name.endsWith('.tgz')
  );
}

async function copyWorkspaceSourceDir({
  src,
  dest,
  runtimeDependencies,
  workspaceRelDir,
}) {
  const sourceRoot = resolve(src);
  runtimeDependencies.copyDirDereferenceContainedSync({
    sourceDir: sourceRoot,
    destDir: dest,
    dereferenceRootDir: sourceRoot,
    shouldCopyPath: (sourcePath) => {
      const relativePath = relative(sourceRoot, sourcePath);
      return shouldIncludePackSandboxSourcePath(relativePath, { workspaceRelDir });
    },
  });
  const packageJsonPath = join(sourceRoot, 'package.json');
  if (!(await pathExists(packageJsonPath))) return;
  await createPackSandboxWorkspaceNodeModules({
    dependencyNames: collectWorkspaceDependencyNames(await readJson(packageJsonPath)),
    sourceNodeModulesDir: join(sourceRoot, 'node_modules'),
    destinationNodeModulesDir: join(dest, 'node_modules'),
    parsePackageNameSegments: runtimeDependencies.parsePackageNameSegments,
  });
}

async function linkExternalNodeModuleEntry(sourcePath, destinationPath) {
  const sourceStats = await stat(sourcePath);
  if (sourceStats.isDirectory()) {
    await symlink(
      sourcePath,
      destinationPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return;
  }
  if (sourceStats.isFile()) {
    await copyFile(sourcePath, destinationPath);
  }
}

async function createPackSandboxWorkspaceNodeModules({
  dependencyNames,
  sourceNodeModulesDir,
  destinationNodeModulesDir,
  parsePackageNameSegments,
}) {
  const dependencyEntries = dependencyNames.map((dependencyName) => ({
    dependencyName,
    dependencySegments: parsePackageNameSegments(dependencyName),
  }));
  if (!(await pathExists(sourceNodeModulesDir))) return;
  await mkdir(destinationNodeModulesDir, { recursive: true });

  const visited = new Set();
  async function linkDependencyClosure(
    dependencyName,
    dependencySegments = parsePackageNameSegments(dependencyName),
  ) {
    if (dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX)) return;
    if (visited.has(dependencyName)) return;
    visited.add(dependencyName);
    const sourcePath = join(sourceNodeModulesDir, ...dependencySegments);
    if (!(await pathExists(sourcePath))) return;
    const destinationPath = join(destinationNodeModulesDir, ...dependencySegments);
    if (
      !pathIsInside(sourceNodeModulesDir, sourcePath)
      || !pathIsInside(destinationNodeModulesDir, destinationPath)
    ) {
      throw new Error(`[pack] package dependency path escapes node_modules: ${dependencyName}`);
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await linkExternalNodeModuleEntry(sourcePath, destinationPath);

    const dependencyPackageJsonPath = join(sourcePath, 'package.json');
    if (!(await pathExists(dependencyPackageJsonPath))) return;
    const dependencyPackageJson = await readJson(dependencyPackageJsonPath);
    for (const transitiveName of collectExternalPackageDependencyNames(dependencyPackageJson)) {
      await linkDependencyClosure(transitiveName);
    }
  }

  for (const { dependencyName, dependencySegments } of dependencyEntries) {
    await linkDependencyClosure(dependencyName, dependencySegments);
  }
}

async function createPackSandboxNodeModules({
  repoNodeModulesDir,
  sandboxRoot,
  workspaceRelDirs,
  parsePackageNameSegments,
}) {
  const sandboxNodeModulesDir = join(sandboxRoot, 'node_modules');
  await mkdir(sandboxNodeModulesDir, { recursive: true });

  for (const entry of await readdir(repoNodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '@happier-dev') continue;
    const sourcePath = join(repoNodeModulesDir, entry.name);
    const destinationPath = join(sandboxNodeModulesDir, entry.name);
    if (entry.name === '.bin') {
      await mkdir(destinationPath, { recursive: true });
      continue;
    }
    const sourceStats = await stat(sourcePath);
    if (entry.name.startsWith('@') && sourceStats.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      for (const scopedEntry of await readdir(sourcePath, { withFileTypes: true })) {
        if (scopedEntry.name === '.bin') continue;
        parsePackageNameSegments(`${entry.name}/${scopedEntry.name}`);
        await linkExternalNodeModuleEntry(
          join(sourcePath, scopedEntry.name),
          join(destinationPath, scopedEntry.name),
        );
      }
      continue;
    }
    if (sourceStats.isDirectory()) {
      await symlink(
        sourcePath,
        destinationPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } else {
      await copyFile(sourcePath, destinationPath);
    }
  }

  const sandboxInternalScopeDir = join(sandboxNodeModulesDir, '@happier-dev');
  await mkdir(sandboxInternalScopeDir, { recursive: true });
  for (const workspaceRelDir of workspaceRelDirs) {
    const workspacePackageJsonPath = join(sandboxRoot, workspaceRelDir, 'package.json');
    if (!(await pathExists(workspacePackageJsonPath))) continue;
    const packageJson = await readJson(workspacePackageJsonPath);
    const packageName = String(packageJson?.name ?? '').trim();
    if (!packageName.startsWith(INTERNAL_PACKAGE_PREFIX)) continue;
    const workspaceName = packageName.slice(INTERNAL_PACKAGE_PREFIX.length);
    if (!workspaceName || workspaceName.includes('/')) continue;
    await symlink(
      join(sandboxRoot, workspaceRelDir),
      join(sandboxInternalScopeDir, workspaceName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

async function materializePackSandboxRuntimeDependencyClosure({
  monorepoRoot,
  sandboxRoot,
  workspaceRelDirs,
  runtimeDependencies,
}) {
  const {
    copyDirDereferenceContainedSync,
    vendorRuntimeDependencyTree,
  } = runtimeDependencies;
  const realMonorepoRoot = await realpath(monorepoRoot);
  const sandboxNodeModulesDir = join(sandboxRoot, 'node_modules');
  const sourceNodeModulesDirs = [
    join(monorepoRoot, 'node_modules'),
    ...[...workspaceRelDirs].map((workspaceRelDir) => (
      join(monorepoRoot, ...normalizeWorkspaceRelDir(workspaceRelDir).segments, 'node_modules')
    )),
  ];
  const approvedDependencyRoots = [];
  for (const sourceNodeModulesDir of sourceNodeModulesDirs) {
    if (!(await pathExists(sourceNodeModulesDir))) continue;
    const physicalDependencyRoot = await realpath(sourceNodeModulesDir);
    if (!pathIsInside(realMonorepoRoot, physicalDependencyRoot)) {
      throw new Error(
        `[pack] dependency root is outside the monorepo: ${physicalDependencyRoot} `
          + `(monorepo: ${realMonorepoRoot})`,
      );
    }
    approvedDependencyRoots.push(physicalDependencyRoot);
  }
  const sandboxDependencyRoots = [
    sandboxNodeModulesDir,
    ...[...workspaceRelDirs].map((workspaceRelDir) => (
      join(sandboxRoot, ...normalizeWorkspaceRelDir(workspaceRelDir).segments, 'node_modules')
    )),
  ];
  for (const sandboxDependencyRoot of sandboxDependencyRoots) {
    await mkdir(sandboxDependencyRoot, { recursive: true });
    approvedDependencyRoots.push(await realpath(sandboxDependencyRoot));
  }

  const findApprovedDependencyRoot = ({ packageName, packageDir }) => {
    const physicalPackageDir = realpathSync(packageDir);
    const approvedDependencyRoot = approvedDependencyRoots.find((rootDir) => (
      pathIsInside(rootDir, physicalPackageDir)
    ));
    if (!approvedDependencyRoot) {
      throw new Error(
        `[pack] resolved runtime dependency ${packageName} is outside the approved dependency roots: `
          + `${physicalPackageDir}`,
      );
    }
    return approvedDependencyRoot;
  };

  const visited = new Set();
  for (const workspaceRelDir of [...workspaceRelDirs].sort((left, right) => (
    left.localeCompare(right)
  ))) {
    const packageJsonPath = join(sandboxRoot, workspaceRelDir, 'package.json');
    if (!(await pathExists(packageJsonPath))) continue;
    const destinationNodeModulesDir = join(
      sandboxRoot,
      ...normalizeWorkspaceRelDir(workspaceRelDir).segments,
      'node_modules',
    );
    vendorRuntimeDependencyTree({
      packageJsonPath,
      resolveFromPackageJsonPath: packageJsonPath,
      destNodeModulesDir: destinationNodeModulesDir,
      visited,
      validateResolvedPackage: findApprovedDependencyRoot,
      copyResolvedPackage: ({
        sourcePackageDir,
        destPackageDir,
      }) => {
        const sourcePackageJson = JSON.parse(
          readFileSync(join(sourcePackageDir, 'package.json'), 'utf8'),
        );
        const packageName = String(sourcePackageJson?.name ?? '').trim();
        findApprovedDependencyRoot({
          packageName,
          packageDir: sourcePackageDir,
        });
        const physicalSourcePackageDir = realpathSync(sourcePackageDir);
        rmSync(destPackageDir, { recursive: true, force: true });
        copyDirDereferenceContainedSync({
          sourceDir: physicalSourcePackageDir,
          destDir: destPackageDir,
          dereferenceRootDir: physicalSourcePackageDir,
          shouldCopyPath: (sourcePath) => {
            const sourceRelativePath = relative(physicalSourcePackageDir, sourcePath);
            if (sourceRelativePath.split(sep).includes('node_modules')) {
              return false;
            }
            const physicalSourcePath = realpathSync(sourcePath);
            if (!pathIsInside(physicalSourcePackageDir, physicalSourcePath)) {
              return true;
            }
            const physicalSourceRelativePath = relative(
              physicalSourcePackageDir,
              physicalSourcePath,
            );
            return !physicalSourceRelativePath.split(sep).includes('node_modules');
          },
        });
      },
    });
  }
}

async function validatePackSandboxPackageRelDir({ monorepoRoot, packageRelDir }) {
  const normalizedPackageRelDir = String(packageRelDir ?? '').trim().replaceAll('\\', '/');
  const segments = normalizedPackageRelDir.split('/');
  if (
    !['apps', 'packages'].includes(segments[0])
    || segments.length < 2
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('[pack] package directory must be a relative workspace path under apps/ or packages/');
  }

  const realMonorepoRoot = await realpath(monorepoRoot);
  const realPackageDir = await realpath(join(monorepoRoot, ...segments));
  const expectedPackageDir = resolve(realMonorepoRoot, ...segments);
  const normalizeForComparison = (value) => (
    process.platform === 'win32' ? value.toLowerCase() : value
  );
  if (normalizeForComparison(realPackageDir) !== normalizeForComparison(expectedPackageDir)) {
    throw new Error(`[pack] package directory must not resolve through a symbolic link: ${packageRelDir}`);
  }

  return normalizedPackageRelDir;
}

export async function createPackSandbox({
  monorepoRoot,
  packageRelDir,
  createTempDir = mkdtemp,
  removeTempDir = rm,
}) {
  const normalizedPackageRelDir = await validatePackSandboxPackageRelDir({
    monorepoRoot,
    packageRelDir,
  });
  const runtimeDependencies = await loadWorkspaceRuntimeDependencies({ monorepoRoot });
  const sandboxRoot = await createTempDir(join(tmpdir(), 'hstack-pack-'));

  try {
    const sandboxStats = await lstat(sandboxRoot);
    const realSandboxRoot = await realpath(sandboxRoot);
    if (
      sandboxStats.isSymbolicLink()
      || !sandboxStats.isDirectory()
    ) {
      throw new Error(`[pack] sandbox root must be a real isolated directory: ${sandboxRoot}`);
    }
    // Minimal monorepo layout needed for pack steps that reference workspace deps:
    // - root package.json + yarn.lock (for repo root detection)
    // - target package dir (e.g. apps/cli)
    // - bundled deps sources (packages/*)
    const filesToCopy = [
      'package.json',
      'yarn.lock',
    ];
    for (const f of filesToCopy) {
      await copyRequiredRegularFile(join(monorepoRoot, f), join(sandboxRoot, f));
    }

    const repoNodeModulesDir = join(monorepoRoot, 'node_modules');
    if (!(await pathExists(repoNodeModulesDir))) {
      throw new Error(`[pack] missing repository dependencies: ${repoNodeModulesDir}`);
    }
    // Workspace prepack scripts share the repository-owned lock, command, dependency-order, and
    // publication helpers. Keep that canonical script layer in the sandbox instead of teaching
    // each package a second standalone bundling implementation.
    const dirsToCopy = new Set(await resolvePackSandboxSourceRelDirs({
      monorepoRoot,
      packageRelDir: normalizedPackageRelDir,
    }));
    // The copy set additionally carries build-only internal workspaces so prepack scripts resolve.
    // Only the package's declared runtime bundle closure may have its external runtime dependency
    // tree vendored: a tooling-only workspace's runtime dependencies never reach the tarball.
    const runtimeBundleRelDirs = await resolvePackSandboxWorkspaceRelDirs({
      monorepoRoot,
      packageRelDir: normalizedPackageRelDir,
    });
    for (const d of dirsToCopy) {
      const { segments } = normalizeWorkspaceRelDir(d);
      const src = join(monorepoRoot, ...segments);
      if (!(await pathExists(src))) {
        throw new Error(`[pack] missing required directory for packing sandbox: ${src}`);
      }
      const destinationPath = resolve(realSandboxRoot, ...segments);
      if (!pathIsInside(realSandboxRoot, destinationPath)) {
        throw new Error(`[pack] dependency workspace destination escapes the sandbox: ${d}`);
      }
      const sourceStats = await lstat(src);
      const realSourcePath = await realpath(src);
      const realMonorepoRoot = await realpath(monorepoRoot);
      if (
        sourceStats.isSymbolicLink()
        || !pathIsInside(realMonorepoRoot, realSourcePath)
        || normalizePathForComparison(realSourcePath)
          !== normalizePathForComparison(resolve(realMonorepoRoot, ...segments))
      ) {
        throw new Error(
          `[pack] dependency workspace must not resolve through a symbolic link: ${d}`,
        );
      }
      const destParent = dirname(destinationPath);
      await mkdir(destParent, { recursive: true });
      await copyWorkspaceSourceDir({
        src,
        dest: destinationPath,
        runtimeDependencies,
        workspaceRelDir: d,
      });
      const destinationStats = await lstat(destinationPath);
      const realDestinationPath = await realpath(destinationPath);
      if (
        destinationStats.isSymbolicLink()
        || !pathIsInside(realSandboxRoot, realDestinationPath)
        || normalizePathForComparison(realDestinationPath)
          !== normalizePathForComparison(destinationPath)
      ) {
        throw new Error(`[pack] dependency workspace destination escaped the sandbox: ${d}`);
      }
    }
    // Package build scripts and scripts/workspaces deliberately reuse the Stack utility owner
    // (for example proc/pm.mjs and its transitive filesystem/path/process modules). Keep that
    // owner whole in the temporary sandbox so a new owner-local import cannot silently break
    // every package prepack while still avoiding a second build implementation.
    const stackToolingRelDir = 'apps/stack/scripts/utils';
    const stackToolingSourceDir = join(monorepoRoot, stackToolingRelDir);
    if (await pathExists(stackToolingSourceDir)) {
      const stackToolingDestinationDir = join(sandboxRoot, stackToolingRelDir);
      await mkdir(dirname(stackToolingDestinationDir), { recursive: true });
      await copyWorkspaceSourceDir({
        src: stackToolingSourceDir,
        dest: stackToolingDestinationDir,
        runtimeDependencies,
      });
    }
    // Stack tooling identifies a Happier monorepo by all three app manifests. Preserve those
    // lightweight markers even when only one app is part of the package build closure.
    for (const markerRelDir of ['apps/ui', 'apps/cli', 'apps/server']) {
      if (dirsToCopy.has(markerRelDir)) continue;
      const markerPackageJson = join(monorepoRoot, markerRelDir, 'package.json');
      if (!(await pathExists(markerPackageJson))) continue;
      const sandboxMarkerDir = join(sandboxRoot, markerRelDir);
      await mkdir(sandboxMarkerDir, { recursive: true });
      await copyRequiredRegularFile(
        markerPackageJson,
        join(sandboxMarkerDir, 'package.json'),
      );
    }
    await createPackSandboxNodeModules({
      repoNodeModulesDir,
      sandboxRoot,
      workspaceRelDirs: dirsToCopy,
      parsePackageNameSegments: runtimeDependencies.parsePackageNameSegments,
    });
    await materializePackSandboxRuntimeDependencyClosure({
      monorepoRoot,
      sandboxRoot,
      workspaceRelDirs: runtimeBundleRelDirs,
      runtimeDependencies,
    });
    const sandboxBinDir = join(sandboxRoot, 'node_modules', '.bin');
    for (const workspaceRelDir of dirsToCopy) {
      const workspaceDir = join(sandboxRoot, workspaceRelDir);
      if (!(await pathExists(join(workspaceDir, 'package.json')))) continue;
      await resolveWorkspaceToolBinDirs(workspaceDir, {
        outputBinDir: sandboxBinDir,
      });
    }

    return sandboxRoot;
  } catch (error) {
    await removeTempDir(sandboxRoot, { recursive: true, force: true });
    throw error;
  }
}

export function analyzeTarList(paths) {
  const hasAgents = paths.some((p) => p.startsWith('package/node_modules/@happier-dev/agents/'));
  const hasCliCommon = paths.some((p) => p.startsWith('package/node_modules/@happier-dev/cli-common/'));
  const hasProtocol = paths.some((p) => p.startsWith('package/node_modules/@happier-dev/protocol/'));
  return { hasAgents, hasCliCommon, hasProtocol };
}

export function analyzeBundledWorkspaceTarList(paths, bundledDependencyNames) {
  const internalNames = readBundledDependencyNames({ bundledDependencies: bundledDependencyNames })
    .filter((packageName) => packageName.startsWith(INTERNAL_PACKAGE_PREFIX));
  const present = {};
  const missing = [];

  for (const packageName of internalNames) {
    const packagePathPrefix = `package/node_modules/${packageName}/`;
    const isPresent = paths.some((p) => p.startsWith(packagePathPrefix));
    present[packageName] = isPresent;
    if (!isPresent) missing.push(packageName);
  }

  return {
    ok: missing.length === 0,
    present,
    missing,
  };
}

export function assertBundledWorkspaceTarballComplete({ enforce, analysis }) {
  if (!enforce || analysis.ok) return;
  throw new Error(`[pack] missing bundled deps in tarball: ${analysis.missing.join(', ')}`);
}

async function validatePackExportDestinationDir(destinationDir) {
  const resolvedDestinationDir = resolve(String(destinationDir ?? '').trim());
  if (!String(destinationDir ?? '').trim()) {
    throw new Error('[pack] export destination directory is required');
  }
  const destinationStats = await lstat(resolvedDestinationDir);
  if (destinationStats.isSymbolicLink()) {
    throw new Error(
      `[pack] export destination directory must not resolve through a symbolic link: ${resolvedDestinationDir}`,
    );
  }
  if (!destinationStats.isDirectory()) {
    throw new Error(`[pack] export destination is not a directory: ${resolvedDestinationDir}`);
  }
  return resolvedDestinationDir;
}

async function resolveValidatedSandboxTarball({
  sandboxPackDir,
  tarballNameRaw,
}) {
  const tarballName = String(tarballNameRaw ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';
  if (
    !tarballName
    || tarballName !== basename(tarballName)
    || !tarballName.endsWith('.tgz')
  ) {
    throw new Error('[pack] npm pack did not produce a safe tarball name');
  }

  const tarballPath = join(sandboxPackDir, tarballName);
  const tarballStats = await lstat(tarballPath);
  if (!tarballStats.isFile() || tarballStats.isSymbolicLink()) {
    throw new Error(`[pack] npm pack output is not a regular tarball: ${tarballName}`);
  }
  return {
    tarballName,
    tarballPath,
    sizeBytes: tarballStats.size,
  };
}

async function copyFileAtomicallyWithoutOverwrite(sourcePath, destinationPath) {
  const destinationDir = dirname(destinationPath);
  const stagingPath = join(
    destinationDir,
    `.${basename(destinationPath)}.hstack-stage-${process.pid}-${randomUUID()}`,
  );
  try {
    await copyFile(sourcePath, stagingPath, fsConstants.COPYFILE_EXCL);
    const stagedStats = await lstat(stagingPath);
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
      throw new Error(`[pack] staged export is not a regular file: ${basename(destinationPath)}`);
    }
    try {
      // A same-directory hard link makes the complete staged bytes visible in one operation and
      // fails instead of replacing a destination installed by another writer.
      await link(stagingPath, destinationPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`[pack] export destination already exists: ${destinationPath}`);
      }
      throw error;
    }
  } finally {
    await unlink(stagingPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePublicationPackageName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 214 || /\s/u.test(name)) {
    throw new Error('[pack] publication expectedPackageName must be a bounded npm package name');
  }
  return name;
}

function normalizePublicationDependencyVersions(value) {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    throw new Error('[pack] publication dependencyVersions must be an object');
  }
  const normalized = {};
  for (const [name, version] of Object.entries(value)) {
    const dependencyName = normalizePublicationPackageName(name);
    const dependencyVersion = String(version ?? '').trim();
    if (
      !dependencyVersion
      || dependencyVersion !== version
      || dependencyVersion.length > 128
      || dependencyVersion.startsWith('workspace:')
      || /\s/u.test(dependencyVersion)
    ) {
      throw new Error(`[pack] publication dependency ${dependencyName} must have an exact non-workspace version`);
    }
    normalized[dependencyName] = dependencyVersion;
  }
  return normalized;
}

function normalizePublicationRequiredFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('[pack] publication requiredFiles must be a non-empty array');
  }
  const files = value.map((entry) => String(entry ?? '').trim());
  for (const file of files) {
    if (!file || file.length > 512 || file.startsWith('/') || file.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`[pack] publication required file is not a safe package-relative path: ${file || '<empty>'}`);
    }
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function normalizeExpectedPeerDependencies(value) {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new Error('[pack] publication expectedPeerDependencies must be an object');
  const peers = {};
  for (const [name, version] of Object.entries(value)) {
    const peerName = normalizePublicationPackageName(name);
    const peerVersion = String(version ?? '').trim();
    if (!peerVersion || peerVersion !== version || peerVersion.length > 128 || /\s/u.test(peerVersion)) {
      throw new Error(`[pack] publication peer dependency ${peerName} must have a bounded version range`);
    }
    peers[peerName] = peerVersion;
  }
  return peers;
}

function normalizePublicationApiGovernance(value) {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) throw new Error('[pack] publication apiGovernance must be an object');
  const profileId = String(value.profileId ?? '').trim();
  if (!profileId || profileId.length > 128 || !/^[a-z][a-z0-9_-]*$/u.test(profileId)) {
    throw new Error('[pack] publication apiGovernance.profileId must be a bounded identifier');
  }
  return Object.freeze({ profileId });
}

function normalizePublicationConfig(publication, packageVersion) {
  if (publication === undefined || publication === null) return null;
  if (!isPlainRecord(publication)) throw new Error('[pack] publication config must be an object');
  if (packageVersion === null) {
    throw new Error('[pack] publication config requires an exact packageVersion override');
  }
  return {
    expectedPackageName: normalizePublicationPackageName(publication.expectedPackageName),
    dependencyVersions: normalizePublicationDependencyVersions(publication.dependencyVersions),
    requiredFiles: normalizePublicationRequiredFiles(publication.requiredFiles),
    expectedPeerDependencies: normalizeExpectedPeerDependencies(publication.expectedPeerDependencies),
    apiGovernance: normalizePublicationApiGovernance(publication.apiGovernance),
  };
}

function isPackTestFile(relativePath) {
  return /(?:^|\/)[^/]+\.test\.[cm]?[jt]sx?$/iu.test(relativePath);
}

async function removePackSandboxTestFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await removePackSandboxTestFiles(entryPath);
      continue;
    }
    if (entry.isFile() && isPackTestFile(entry.name)) {
      await unlink(entryPath);
    }
  }
}

/** @param {Record<string, unknown>} manifest */
function projectPublicSdkDeveloperPreview(manifest) {
  delete manifest.private;
  if (!isPlainRecord(manifest.happier)) {
    throw new Error('[pack] publication requires canonical Developer Preview metadata');
  }
  if (!isPlainRecord(manifest.happier.publicSdkRelease)) {
    throw new Error('[pack] publication requires canonical Developer Preview release metadata');
  }
  const publicSdkRelease = manifest.happier.publicSdkRelease;
  if (
    publicSdkRelease.posture !== 'prepublish_hold'
    && publicSdkRelease.posture !== 'developer_preview'
  ) {
    throw new Error('[pack] publication Developer Preview metadata has an unsupported posture');
  }
  // The sandbox sheds the unpublished package hold, but the public candidate
  // still advertises its package-level Developer Preview contract.
  manifest.happier = {
    ...manifest.happier,
    publicSdkRelease: {
      ...publicSdkRelease,
      posture: 'developer_preview',
    },
  };
}

async function applyPublicationPackSandboxTransform({ sandboxPackDir, config, packageVersion }) {
  const packageJsonPath = join(sandboxPackDir, 'package.json');
  const manifest = await readJson(packageJsonPath);
  if (!isPlainRecord(manifest) || manifest.name !== config.expectedPackageName) {
    throw new Error(`[pack] publication package name must be ${config.expectedPackageName}`);
  }
  if (manifest.version !== packageVersion) {
    throw new Error(`[pack] publication package version must be ${packageVersion}`);
  }
  projectPublicSdkDeveloperPreview(manifest);
  if (manifest.publishConfig !== undefined && !isPlainRecord(manifest.publishConfig)) {
    throw new Error('[pack] publication publishConfig must be an object when present');
  }
  manifest.publishConfig = { ...(manifest.publishConfig ?? {}), access: 'public' };
  if (Object.keys(config.dependencyVersions).length > 0) {
    if (!isPlainRecord(manifest.dependencies)) {
      throw new Error('[pack] publication dependency rewrite requires a dependencies object');
    }
    manifest.dependencies = { ...manifest.dependencies };
    for (const [dependencyName, dependencyVersion] of Object.entries(config.dependencyVersions)) {
      if (typeof manifest.dependencies[dependencyName] !== 'string') {
        throw new Error(`[pack] publication dependency is not declared as a normal dependency: ${dependencyName}`);
      }
      manifest.dependencies[dependencyName] = dependencyVersion;
    }
  }
  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await removePackSandboxTestFiles(sandboxPackDir);
}

/**
 * The public API governance owner is shared across package profiles. The pack
 * sandbox owns its candidate bytes, so release preparation invokes that owner
 * against the transformed sandbox rather than touching the shared worktree.
 */
async function preparePublicationApiGovernance(input) {
  const {
    preparePublicApiGovernance,
    renderPublicApiReleaseComparison,
    summarizePublicApiReleaseComparison,
  } = await import('../../../scripts/pipeline/release/public-api-governance.mjs');
  const report = await preparePublicApiGovernance(input);
  return Object.freeze({
    summary: summarizePublicApiReleaseComparison(report),
    log: renderPublicApiReleaseComparison(report),
  });
}

function assertNoWorkspaceResolution(manifest) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!isPlainRecord(entries)) throw new Error(`[pack] tarball ${field} must be an object when present`);
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== 'string' || version.startsWith('workspace:')) {
        throw new Error(`[pack] tarball has unresolved workspace dependency ${field}.${name}`);
      }
    }
  }
}

async function validatePublicationTarball({
  tarballPath,
  tarPaths,
  runCaptureImpl,
  sandboxPackDir,
  env,
  config,
  packageVersion,
}) {
  if (!tarPaths.includes('package/package.json')) {
    throw new Error('[pack] public tarball is missing package/package.json');
  }
  for (const requiredFile of config.requiredFiles) {
    if (!tarPaths.includes(`package/${requiredFile}`)) {
      throw new Error(`[pack] public tarball is missing required file: ${requiredFile}`);
    }
  }
  const testFile = tarPaths.find((tarPath) => isPackTestFile(tarPath));
  if (testFile) throw new Error(`[pack] public tarball must not include test file: ${testFile}`);
  const manifestRaw = await runCaptureImpl('tar', ['-xOf', tarballPath, 'package/package.json'], {
    cwd: sandboxPackDir,
    env,
  });
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`[pack] public tarball package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainRecord(manifest) || manifest.name !== config.expectedPackageName || manifest.version !== packageVersion) {
    throw new Error('[pack] public tarball package identity did not match its exact candidate');
  }
  if (Object.hasOwn(manifest, 'private')) throw new Error('[pack] public tarball must not retain private');
  if (
    !isPlainRecord(manifest.happier)
    || !isPlainRecord(manifest.happier.publicSdkRelease)
    || manifest.happier.publicSdkRelease.posture !== 'developer_preview'
  ) {
    throw new Error('[pack] public tarball must retain canonical Developer Preview metadata');
  }
  if (!isPlainRecord(manifest.publishConfig) || manifest.publishConfig.access !== 'public') {
    throw new Error('[pack] public tarball publishConfig.access must be public');
  }
  assertNoWorkspaceResolution(manifest);
  for (const [dependencyName, dependencyVersion] of Object.entries(config.dependencyVersions)) {
    if (manifest.dependencies?.[dependencyName] !== dependencyVersion) {
      throw new Error(`[pack] public tarball dependency did not retain exact version: ${dependencyName}`);
    }
  }
  for (const [peerName, peerVersion] of Object.entries(config.expectedPeerDependencies)) {
    if (manifest.peerDependencies?.[peerName] !== peerVersion) {
      throw new Error(`[pack] public tarball peer dependency did not retain expected range: ${peerName}`);
    }
  }
}

export async function exportPackSandboxTarball({
  monorepoRoot,
  packageRelDir,
  destinationDir,
  packageVersion = null,
  publication = null,
  env = process.env,
  createPackSandboxImpl = createPackSandbox,
  runCaptureImpl = runCapture,
  removeTempDir = rm,
  preparePublicationApiGovernanceImpl = preparePublicationApiGovernance,
}) {
  const resolvedDestinationDir = await validatePackExportDestinationDir(destinationDir);
  const sandboxRoot = await createPackSandboxImpl({ monorepoRoot, packageRelDir });
  const sandboxPackDir = join(sandboxRoot, packageRelDir);
  const publicationConfig = normalizePublicationConfig(publication, packageVersion);
  let apiGovernancePreparation = null;

  try {
    if (packageVersion !== null) {
      const normalizedPackageVersion = String(packageVersion).trim();
      if (
        normalizedPackageVersion !== packageVersion
        || !normalizedPackageVersion
        || normalizedPackageVersion.length > 128
        || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/u.test(normalizedPackageVersion)
      ) {
        throw new Error('[pack] package version override must be a bounded portable package version');
      }
      const sandboxPackageJsonPath = join(sandboxPackDir, 'package.json');
      const sandboxPackageJson = await readJson(sandboxPackageJsonPath);
      await writeFile(
        sandboxPackageJsonPath,
        `${JSON.stringify({
          ...sandboxPackageJson,
          version: normalizedPackageVersion,
        }, null, 2)}\n`,
      );
    }
    if (publicationConfig) {
      await applyPublicationPackSandboxTransform({
        sandboxPackDir,
        config: publicationConfig,
        packageVersion: String(packageVersion),
      });
    }
    if (publicationConfig?.apiGovernance) {
      apiGovernancePreparation = await preparePublicationApiGovernanceImpl({
        profileId: publicationConfig.apiGovernance.profileId,
        packageName: publicationConfig.expectedPackageName,
        packageRoot: sandboxPackDir,
        candidateVersion: String(packageVersion),
        repositoryRoot: monorepoRoot,
        env,
      });
      if (!isPlainRecord(apiGovernancePreparation) || !isPlainRecord(apiGovernancePreparation.summary)) {
        throw new Error('[pack] public API governance preparation must return a bounded summary');
      }
      if (apiGovernancePreparation.log !== undefined && typeof apiGovernancePreparation.log !== 'string') {
        throw new Error('[pack] public API governance preparation log must be a string when present');
      }
      if (apiGovernancePreparation.log) console.log(apiGovernancePreparation.log);
    }
    await runCaptureImpl('npm', ['pack', '--dry-run'], {
      cwd: sandboxPackDir,
      env: {
        ...env,
        npm_config_dry_run: 'true',
      },
    });
    const tarballNameRaw = await runCaptureImpl('npm', ['pack'], {
      cwd: sandboxPackDir,
      env: {
        ...env,
        npm_config_dry_run: 'false',
      },
    });
    const {
      tarballName,
      tarballPath,
      sizeBytes,
    } = await resolveValidatedSandboxTarball({
      sandboxPackDir,
      tarballNameRaw,
    });
    const tarListRaw = await runCaptureImpl('tar', ['-tf', tarballPath], {
      cwd: sandboxPackDir,
      env,
    });
    const tarPaths = tarListRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const { hasAgents, hasCliCommon, hasProtocol } = analyzeTarList(tarPaths);
    const packPackageJson = await readJson(join(sandboxPackDir, 'package.json'));
    const bundledWorkspaceAnalysis = analyzeBundledWorkspaceTarList(
      tarPaths,
      readBundledDependencyNames(packPackageJson),
    );
    const shouldEnforceBundledDeps =
      readBundledInternalWorkspacePackageNames(packPackageJson).length > 0;
    assertBundledWorkspaceTarballComplete({
      enforce: shouldEnforceBundledDeps,
      analysis: bundledWorkspaceAnalysis,
    });
    if (publicationConfig) {
      await validatePublicationTarball({
        tarballPath,
        tarPaths,
        runCaptureImpl,
        sandboxPackDir,
        env,
        config: publicationConfig,
        packageVersion: String(packageVersion),
      });
    }

    const destinationPath = join(resolvedDestinationDir, tarballName);
    const existingDestination = await lstat(destinationPath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (existingDestination) {
      throw new Error(`[pack] export destination already exists: ${destinationPath}`);
    }
    await copyFileAtomicallyWithoutOverwrite(tarballPath, destinationPath);

    return {
      ok: true,
      package: {
        name: String(packPackageJson?.name ?? ''),
        version: String(packPackageJson?.version ?? ''),
      },
      tarball: {
        name: tarballName,
        sizeBytes,
      },
      bundled: {
        agents: hasAgents,
        cliCommon: hasCliCommon,
        protocol: hasProtocol,
      },
      bundledWorkspaces: bundledWorkspaceAnalysis,
      enforcement: {
        bundledDeps: shouldEnforceBundledDeps,
      },
      dryRun: {
        ok: true,
      },
      ...(publicationConfig ? {
        publication: {
          name: publicationConfig.expectedPackageName,
          version: String(packageVersion),
          publicAccess: true,
          testFilesExcluded: true,
          ...(apiGovernancePreparation ? { apiGovernance: apiGovernancePreparation.summary } : {}),
        },
      } : {}),
    };
  } finally {
    await removeTempDir(sandboxRoot, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { targets: [...VALID_TARGETS, '--dir=/abs/path'], flags: ['--json'] },
      text: [
        '[pack] usage:',
        '  hstack pack cli [--json]',
        '  hstack pack server [--json]',
        '  hstack pack ui [--json]',
        '  hstack pack --dir=/abs/path/to/apps/cli [--json]',
        '',
        'notes:',
        '- packs in a temporary sandbox to avoid dirtying the worktree',
        '- can validate bundledDependencies output by inspecting the generated tarball (best-effort)',
      ].join('\n'),
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const explicitDir = (kv.get('--dir') ?? '').toString().trim();
  const raw =
    explicitDir
      ? null
      : positionals.length === 1
        ? positionals[0]
        : null;

  if (!explicitDir && !raw) {
    throw new Error('[pack] missing target (expected: hstack pack cli|server|ui | --dir=...)');
  }

  const target = raw
    ? (VALID_TARGETS.includes(String(raw).trim().toLowerCase()) ? String(raw).trim().toLowerCase() : targetFromLegacyComponent(raw))
    : null;
  if (raw && !target) {
    throw new Error(`[pack] unknown target: ${raw} (expected one of: ${VALID_TARGETS.join(', ')})`);
  }

  const rootDir = getRootDir(import.meta.url);
  const component = target ? legacyComponentFromTarget(target) : null;
  const componentDir = component ? getComponentDir(rootDir, component) : '';
  const packDir = await resolvePackDirForComponent({
    component: component ?? 'happy-cli',
    componentDir,
    explicitDir: explicitDir ? resolve(explicitDir) : null,
    rootDir,
  });

  if (!(await pathExists(packDir))) {
    throw new Error(`[pack] missing pack dir: ${packDir}`);
  }
  const st = await stat(packDir);
  if (!st.isDirectory()) {
    throw new Error(`[pack] pack dir is not a directory: ${packDir}`);
  }

  const monorepoRoot = await findMonorepoRoot(packDir);
  if (!monorepoRoot) {
    throw new Error(`[pack] could not locate monorepo root (package.json + yarn.lock) from: ${packDir}`);
  }
  const packageRelDir = relative(monorepoRoot, packDir).split(sep).join('/');
  if (!(packageRelDir.startsWith('apps/') || packageRelDir.startsWith('packages/'))) {
    throw new Error(`[pack] expected pack dir to be under monorepo apps/ or packages/: ${packDir}`);
  }

  const ephemeralOutputDir = await mkdtemp(join(tmpdir(), 'hstack-pack-output-'));
  try {
    const data = await exportPackSandboxTarball({
      monorepoRoot,
      packageRelDir,
      destinationDir: ephemeralOutputDir,
    });

    if (json) {
      printResult({ json, data });
      return;
    }

    const lines = [
      `[pack] dir: ${packDir}`,
      `[pack] tarball: ${data.tarball.name} (generated in a temp sandbox)`,
      `[pack] bundledDependencies (best-effort):`,
    ];
    for (const [packageName, isPresent] of Object.entries(data.bundledWorkspaces.present)) {
      lines.push(`- ${packageName}: ${isPresent ? 'present' : 'missing'}`);
    }
    if (!Object.keys(data.bundledWorkspaces.present).length) {
      lines.push('- no internal bundled workspaces required');
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  } finally {
    await rm(ephemeralOutputDir, { recursive: true, force: true });
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // `argv[1]` can be a relative path.
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  });
}
