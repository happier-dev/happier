import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIntoTempThenReplace } from '../../apps/stack/scripts/utils/fs/atomic_dir_swap.mjs';
import { readCachedFileDigestSync } from '../../apps/stack/scripts/utils/fs/cached_file_digest.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { readWorkspaceBuildInputs } from '../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';
export { readWorkspaceBuildInputs } from '../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { withCliDistBuildLock } from '../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import { createWorkspaceBuildWaitNotifier } from '../../apps/stack/scripts/utils/proc/workspaceBuildWaitNotifier.mjs';
import { run } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import { resolveWorkspaceToolBinDirs } from '../../apps/stack/scripts/utils/proc/workspace_tool_bins.mjs';
import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import {
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetMatches,
  resolvePackageBuildOutputTargetPath,
} from './packageBuildOutputTargets.mjs';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR } from './workspaceChildBuildEnv.mjs';
import { resolveWorkspaceBundlePublicationMode } from './workspaceBundlePublication.mjs';
import { syncBundledWorkspacePackages } from './syncBundledWorkspacePackages.mjs';
import { createBundledPluginPublicationFailure } from './bundledPluginPublicationFailure.mjs';
import { BuildInputDriftError, WorkspacePackageBuildError, withSingleTrailingBuildPass } from './buildInputConvergence.mjs';
import {
  collectInternalWorkspaceDependencyNames,
  collectAdmittedInternalWorkspacePeerDependencyNames,
} from './workspacePackageDependencies.mjs';

const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH =
  'dist/happier-plugin-ui/ui-artifacts.json';
const DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS = 2;
export const BUILD_INPUT_RECORD = '.happier-build-inputs.json';
export const WORKSPACE_BUILD_MODE_ENV = 'HAPPIER_WORKSPACE_BUILD_MODE';

// QA publication is the only caller allowed to consume an older compilation.
// This mode travels with compiler children; ordinary/release builds are strict.
export function resolveWorkspaceBuildMode({ buildMode, env = {} } = {}) {
  if (/^(?:prepack|pack|publish|prepublishOnly)$/.test(String(env.npm_lifecycle_event ?? ''))) return 'strict';
  const mode = buildMode ?? env[WORKSPACE_BUILD_MODE_ENV] ?? 'strict';
  if (mode !== 'strict' && mode !== 'qa-runtime') throw new Error(`[workspace-build] invalid build mode: ${mode}`);
  return mode;
}

function compilerDiagnosticSummary(error) {
  if (!(error instanceof WorkspacePackageBuildError) || error.code !== 'EEXIT') return null;
  const cause = error.cause;
  if (cause?.signal || cause?.exitCode === null) return null;
  const diagnostics = error.message.replace(/\u001b\[[0-9;]*m/g, '').split('\n')
    .filter((line) => /\berror TS\d+:/.test(line));
  return diagnostics.length ? diagnostics.join('\n') : null;
}

function readQaStalePackage(packageDir, packageName, { monorepoRoot, dependencyDirs }) {
  const record = JSON.parse(readFileSync(join(packageDir, 'dist', BUILD_INPUT_RECORD), 'utf8'));
  if (!record.qaFailure || !isWorkspacePackageOutputValid(packageDir, { monorepoRoot, dependencyDirs })) return null;
  const { qaFailure, ...lastGreenBuildRecord } = record;
  const hash = createHash('sha256').update('happier:qa-last-green-output:v1\0');
  hash.update(JSON.stringify({ fingerprint: record.fingerprint, dependencies: record.dependencies, outputs: record.outputs, files: record.files }));
  for (const path of record.files) {
    const outputPath = resolve(packageDir, 'dist', path);
    if (!outputPath.startsWith(`${resolve(packageDir, 'dist')}${sep}`)) throw new Error(`[workspace-build] invalid recorded output: ${path}`);
    hash.update(`${path}\0${readWorkspaceBuildFileDigest(outputPath)}\0`);
  }
  return { packageName, lastGreenBuildRecord, lastGreenBuiltAt: qaFailure.lastGreenBuiltAt,
    diagnosticSummary: qaFailure.diagnosticSummary, outputIdentity: hash.digest('hex') };
}

/** Project QA failures from the same package records used by source-dev. */
export async function inspectWorkspaceQaStalePackages(monorepoPath, packageNames) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(monorepoPath);
  if (!monorepoRoot) return [];
  const packageDirsByName = await collectWorkspacePackageDirsByName(monorepoRoot);
  const closure = await collectWorkspaceDependencyClosure(packageNames, packageDirsByName, { includeDevDependencies: false });
  const stalePackages = [];
  for (const packageName of [...closure].sort()) {
    const packageDir = packageDirsByName.get(packageName);
    const recordPath = join(packageDir, 'dist', BUILD_INPUT_RECORD);
    if (!existsSync(recordPath)) continue;
    const dependencyDirs = collectWorkspacePackageFingerprintDependencyNames(
      JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')), packageName,
      new Set(packageDirsByName.keys()), { packageDirsByName },
    ).map((name) => packageDirsByName.get(name));
    const stale = readQaStalePackage(packageDir, packageName, { monorepoRoot, dependencyDirs });
    if (stale) stalePackages.push(stale);
  }
  return stalePackages;
}

function createAsyncConcurrencyLimiter(maxConcurrent) {
  const limit = Number.isInteger(maxConcurrent) && maxConcurrent > 0
    ? maxConcurrent
    : DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS;
  let active = 0;
  const waiters = [];

  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  return async (operation) => {
    if (active >= limit) {
      await new Promise((resolveWaiter) => waiters.push(resolveWaiter));
    }
    active += 1;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function collectWorkspacePackageDirsByName(monorepoRoot) {
  const paths = await collectWorkspacePackageJsonPaths(monorepoRoot);
  const packageDirsByName = new Map();

  for (const packageJsonPath of paths) {
    let packageJson = null;
    try {
      packageJson = await readJson(packageJsonPath);
    } catch {
      continue;
    }
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
    if (packageName) packageDirsByName.set(packageName, dirname(packageJsonPath));
  }

  return packageDirsByName;
}

async function collectWorkspaceDependencyClosure(packageNames, packageDirsByName, { includeDevDependencies = true } = {}) {
  const admitted = new Set();
  const workspacePackageNames = new Set(packageDirsByName.keys());
  const visit = async (name) => {
    if (admitted.has(name)) return;
    const dir = packageDirsByName.get(name);
    if (!dir) return;
    admitted.add(name);
    const packageJson = await readJson(join(dir, 'package.json'));
    await Promise.all(collectInternalWorkspaceDependencyNames(packageJson, name, {
      includeDevDependencies, workspacePackageNames,
    }).map(visit));
  };
  await Promise.all(packageNames.map(visit));
  return admitted;
}

export function collectWorkspacePackageFingerprintDependencyNames(
  packageJson,
  currentPackageName,
  workspacePackageNames,
  { packageDirsByName = null } = {},
) {
  const names = new Set();
  const visit = (metadata, name, includeDevDependencies) => {
    const dependencies = [...collectInternalWorkspaceDependencyNames(metadata, name, {
      includeDevDependencies, workspacePackageNames,
    }), ...Object.keys(metadata?.peerDependencies ?? {}).filter((peer) => workspacePackageNames.has(peer))];
    for (const dependency of dependencies) {
      if (dependency === currentPackageName || names.has(dependency)) continue;
      names.add(dependency);
      const dir = packageDirsByName?.get(dependency);
      // Emitted declarations can reference another workspace's declarations
      // even when the immediate dependency's own emitted bytes do not change.
      if (dir) visit(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), dependency, false);
    }
  };
  visit(packageJson, currentPackageName, false);
  return [...names];
}

function collectBundledWorkspaceDependencyNames(packageJson) {
  const bundledDependencies = Array.isArray(packageJson?.bundledDependencies)
    ? packageJson.bundledDependencies
    : Array.isArray(packageJson?.bundleDependencies)
      ? packageJson.bundleDependencies
      : [];
  return bundledDependencies
    .map((packageName) => typeof packageName === 'string' ? packageName.trim() : '')
    .filter((packageName) => packageName.startsWith('@happier-dev/'));
}

function hasBundledWorkspaceDependencies(packageJson) {
  return collectBundledWorkspaceDependencyNames(packageJson).length > 0;
}

function buildEntersWorkspaceBundleLock(packageJson) {
  return hasBundledWorkspaceDependencies(packageJson);
}

function collectExpectedPackageOutputTargets(packageJson) {
  const candidates = collectPackageBuildOutputTargets(packageJson);
  // A declared plugin UI build is part of the package's atomic dist contract,
  // even though its generated graph is not a JavaScript export target.
  if (
    typeof packageJson?.scripts?.['build:ui'] === 'string'
    && packageJson.scripts['build:ui'].trim()
  ) {
    candidates.push(GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH);
  }

  return [...new Set(candidates)].filter(isPackageBuildDistOutputTarget);
}

function resolveExpectedPackageOutputTargetMatches({ packageDir, distDir, expectedTargets }) {
  return expectedTargets.map((target) => ({
    target,
    paths: resolvePackageBuildOutputTargetMatches({
      packageDir,
      outputDir: distDir,
      target,
    }),
  }));
}

function remapPathToDirectory(path, { sourceDir, destinationDir }) {
  const absolutePath = resolve(path);
  const sourceRoot = resolve(sourceDir);
  if (absolutePath === sourceRoot) return resolve(destinationDir);
  if (absolutePath.startsWith(sourceRoot + sep)) {
    return join(resolve(destinationDir), relative(sourceRoot, absolutePath));
  }
  return absolutePath;
}

function remapDistPathToDir(path, { packageDir, distDir }) {
  return remapPathToDirectory(path, {
    sourceDir: join(packageDir, 'dist'),
    destinationDir: distDir,
  });
}

export function readWorkspaceBuildFileDigest(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error(`[workspace-build] expected a build input file: ${path}`);
  const digest = readCachedFileDigestSync(path, stat);
  if (digest.startsWith('metadata:')) throw new Error(`[workspace-build] unreadable build input: ${path}`);
  return digest;
}

function collectExtendedTsconfigs(packageDir, inputPaths) {
  const extended = new Set();
  const visit = (path) => {
    if (extended.has(path)) return;
    extended.add(path);
    const content = readFileSync(path, 'utf8');
    const match = content.match(/"extends"\s*:\s*("[^"]+"|\[[^\]]+\])/);
    if (!match) return;
    const specs = match[1].startsWith('[')
      ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
      : [match[1].slice(1, -1)];
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(path), spec);
      const target = existsSync(base) ? base : `${base}.json`;
      if (!existsSync(target)) throw new Error(`[workspace-build] missing extended tsconfig: ${target}`);
      visit(target);
    }
  };
  for (const path of inputPaths) {
    if (/^tsconfig(?:\.[^.]+)*\.json$/.test(basename(path))) visit(path);
  }
  return [...extended].filter((path) => !path.startsWith(`${packageDir}${sep}`));
}

function digestDirectory(path, hash, { declarationsOnly = false, root = path } = {}) {
  if (!existsSync(path)) return;
  for (const name of readdirSync(path).sort()) {
    if (name === BUILD_INPUT_RECORD) continue;
    const child = join(path, name);
    const stat = lstatSync(child, { bigint: true });
    if (stat.isDirectory()) digestDirectory(child, hash, { declarationsOnly, root });
    else if (!declarationsOnly || /\.d\.(?:ts|mts|cts)$/.test(name)) {
      hash.update(`${relative(root, child).split(sep).join('/')}\0`);
      if (stat.isFile()) hash.update(readWorkspaceBuildFileDigest(child));
      else hash.update(`other:${stat.mode}:${stat.size}:${stat.mtimeNs}`);
      hash.update('\0');
    }
  }
}

function digestDependencyOutputs(packageDir, packageJson, hash, { declarationsOnly = false } = {}) {
  const distDir = join(packageDir, 'dist');
  digestDirectory(distDir, hash, { declarationsOnly });
  const targets = new Set(collectPackageBuildOutputTargets({
    ...packageJson,
    exports: [packageJson.exports, packageJson.imports],
  })
    .filter(isLocalPackageBuildOutputTarget)
    .map((target) => declarationsOnly ? target.replace(/\.(mjs|cjs|js)$/, (_match, extension) => (
      { mjs: '.d.mts', cjs: '.d.cts', js: '.d.ts' }[extension]
    )) : target)
    .filter((target) => (!declarationsOnly || /\.d\.(?:ts|mts|cts)$/.test(target)) && !isPackageBuildDistOutputTarget(target)));
  for (const target of [...targets].sort()) {
    hash.update(`output-target:${target}\0`);
    for (const path of resolvePackageBuildOutputTargetMatches({ packageDir, outputDir: distDir, target })) {
      hash.update(`${relative(packageDir, path).split(sep).join('/')}\0`);
      if (lstatSync(path).isDirectory()) digestDirectory(path, hash, { declarationsOnly, root: packageDir });
      else hash.update(readWorkspaceBuildFileDigest(path));
      hash.update('\0');
    }
  }
}

export function readWorkspacePackageInputFingerprint({
  packageDir,
  dependencyDirs = [],
  includeShippedFiles = false,
  excludeGeneratedPluginManifest = false,
  excludeGeneratedPluginArtifacts = false,
  resolveTypeScriptCliInvocationImpl = resolveTypeScriptCliInvocation,
}) {
  const hash = createHash('sha256');
  hash.update('happier:workspace-package-build:v2\0');
  const inputPaths = readWorkspaceBuildInputs(packageDir, {
    includeShippedFiles,
    excludeGeneratedPluginManifest,
    excludeGeneratedPluginArtifacts,
  })
    .map((path) => join(packageDir, path));
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const buildScript = String(packageJson.scripts?.build ?? '');
  const referencedBuildInputs = [...buildScript.matchAll(/(?:^|\s)(\.{1,2}\/[^\s;&|]+\.(?:[cm]?[jt]sx?|json))(?=$|\s|[;&|])/g)]
    .map((match) => resolve(packageDir, match[1]))
    .filter(existsSync);
  const invocation = resolveTypeScriptCliInvocationImpl({ args: [], env: process.env });
  const compilerPath = invocation.argsPrefix[0];
  const compilerPackageJson = resolve(dirname(compilerPath), '..', 'package.json');
  const buildOwnerPath = fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url));
  const paths = [...new Set([
    ...inputPaths,
    ...referencedBuildInputs,
    ...collectExtendedTsconfigs(packageDir, inputPaths),
    compilerPath,
    compilerPackageJson,
    buildOwnerPath,
  ])].sort();
  for (const path of paths) {
    hash.update(`${path}\0${readWorkspaceBuildFileDigest(path)}\0`);
  }
  for (const dependencyDir of [...dependencyDirs].sort()) {
    hash.update(`dependency:${dependencyDir}\0`);
    const metadata = JSON.parse(readFileSync(join(dependencyDir, 'package.json'), 'utf8'));
    hash.update(JSON.stringify(Object.fromEntries(
      ['name', 'type', 'main', 'module', 'types', 'typings', 'typesVersions', 'exports', 'imports']
        .map((key) => [key, metadata[key]]),
    )));
    digestDependencyOutputs(dependencyDir, metadata, hash, { declarationsOnly: true });
  }
  return hash.digest('hex');
}

function collectOutputDigests(distDir, expectedTargetMatches) {
  return [...new Set(expectedTargetMatches.flatMap(({ paths }) => paths))]
    .map((path) => ({
      path: relative(distDir, path).split(sep).join('/'),
      digest: readWorkspaceBuildFileDigest(path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function collectPublishedDistFiles(distDir, relativeDir = '') {
  const directory = relativeDir ? join(distDir, relativeDir) : distDir;
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (path === BUILD_INPUT_RECORD) return [];
    if (entry.isDirectory()) return collectPublishedDistFiles(distDir, path);
    return [path];
  }).sort();
}

function publishedOutputsMatch(distDir, inputFingerprint, { requirePruned = false, allowQaFailure = true } = {}) {
  try {
    const record = JSON.parse(readFileSync(join(distDir, BUILD_INPUT_RECORD), 'utf8'));
    if (!allowQaFailure && record.qaFailure) return false;
    if (record.version !== 2 || record.fingerprint !== inputFingerprint || !Array.isArray(record.outputs) || record.outputs.length === 0) {
      return false;
    }
    if (requirePruned) {
      const actualFiles = collectPublishedDistFiles(distDir);
      if (
        !Array.isArray(record.files)
        || record.files.length !== actualFiles.length
        || record.files.some((path, index) => path !== actualFiles[index])
      ) return false;
    }
    return record.outputs.every(({ path, digest }) => {
      if (typeof path !== 'string' || !path || !/^[a-f0-9]{64}$/.test(digest)) return false;
      const outputPath = resolve(distDir, path);
      if (!outputPath.startsWith(`${resolve(distDir)}${sep}`)) return false;
      return readWorkspaceBuildFileDigest(outputPath) === digest;
    });
  } catch {
    return false;
  }
}

export function isWorkspacePackageOutputCurrent(packageDir, { dependencyDirs = [] } = {}) {
  return publishedOutputsMatch(
    join(packageDir, 'dist'),
    readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs }),
    { allowQaFailure: false },
  ) && publishedDependencyOutputsMatch(join(packageDir, 'dist'), readWorkspaceBuiltDependencies({
    monorepoRoot: coerceHappyMonorepoRootFromPath(packageDir) ?? packageDir, dependencyDirs,
  }));
}

/** Integrity of the recorded build, independently of newer source freshness. */
export function isWorkspacePackageOutputValid(packageDir, { dependencyDirs = [], monorepoRoot } = {}) {
  const distDir = join(packageDir, 'dist');
  try {
    const record = JSON.parse(readFileSync(join(distDir, BUILD_INPUT_RECORD), 'utf8'));
    if (!(typeof record.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.fingerprint)
      && publishedOutputsMatch(distDir, record.fingerprint))) return false;
    return JSON.stringify(record.dependencies ?? []) === JSON.stringify(readWorkspaceBuiltDependencies({
      monorepoRoot: monorepoRoot ?? coerceHappyMonorepoRootFromPath(packageDir), dependencyDirs,
    }));
  } catch {
    return false;
  }
}

function readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs }) {
  return [...dependencyDirs].sort().map((packageDir) => {
    const hash = createHash('sha256');
    hash.update('happier:workspace-built-dependency:v1\0');
    hash.update(readWorkspaceBuildFileDigest(join(packageDir, 'package.json')));
    digestDependencyOutputs(packageDir, JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')), hash);
    return { packageDir: relative(monorepoRoot, packageDir).split(sep).join('/'), fingerprint: hash.digest('hex') };
  });
}

function publishedDependencyOutputsMatch(distDir, dependencies) {
  if (dependencies.length === 0) return true;
  try {
    return JSON.stringify(JSON.parse(readFileSync(join(distDir, BUILD_INPUT_RECORD), 'utf8')).dependencies)
      === JSON.stringify(dependencies);
  } catch {
    return false;
  }
}

function parsePositiveEnvInt(envValue, fallback) {
  const raw = Number.parseInt(String(envValue ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

async function assertNoMissingLocalImportsWithRetry({
  distDir,
  entryPath,
  label,
  env,
  onRetry,
}) {
  const attempts = parsePositiveEnvInt(
    env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS,
    24,
  );
  const delayMs = parsePositiveEnvInt(
    env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_DELAY_MS,
    250,
  );
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertNoMissingLocalImports({ distDir, entryPath, label });
      return;
    } catch (error) {
      lastError = error;
      onRetry?.({
        attempt,
        attempts,
        delayMs,
        entryPath,
        label,
        waitedMs: attempt * delayMs,
        error,
      });
      if (attempt >= attempts - 1) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }

  throw lastError ?? new Error(`[local] ${label} import validation failed for ${entryPath}`);
}

async function inspectWorkspacePackageOutput(packageDir, packageJson, {
  env = process.env,
  retryImports = false,
  inputFingerprint,
  builtDependencies = [],
  publicationMode = 'live',
  allowQaFailure = false,
} = {}) {
  const expectedTargets = collectExpectedPackageOutputTargets(packageJson);
  const distDir = join(packageDir, 'dist');
  const expectedTargetMatches = resolveExpectedPackageOutputTargetMatches({
    packageDir,
    distDir,
    expectedTargets,
  });
  const expectedFiles = [...new Set(expectedTargetMatches.flatMap(({ paths }) => paths))];
  const missing = expectedTargetMatches
    .filter(({ paths }) => paths.length === 0)
    .map(({ target }) => target);
  const distRoot = resolve(distDir);
  const distEntrypoints = expectedTargets
    .filter((target) => !target.includes('*'))
    .filter((target) => /\.(?:mjs|cjs|js)$/.test(target))
    .map((target) => resolvePackageBuildOutputTargetPath({
      packageDir,
      outputDir: distDir,
      target,
    }))
    .filter((path) => {
      const absolutePath = resolve(path);
      return absolutePath === distRoot || absolutePath.startsWith(distRoot + sep);
    });
  const label = packageJson?.name ? `${packageJson.name} dist build` : 'dist build';

  if (expectedTargets.length === 0) {
    return {
      complete: true,
      expectedTargets,
      expectedFiles,
      missing,
      distDir,
      distEntrypoints,
      label,
    };
  }

  const outputsAreAdmissible = missing.length === 0 && inputFingerprint
    && await publishedOutputsMatch(distDir, inputFingerprint, {
      requirePruned: publicationMode === 'artifact',
      allowQaFailure,
    });
  if (outputsAreAdmissible) {
    try {
      for (const entryPath of distEntrypoints) {
        if (
          retryImports
          && String(env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS ?? '').trim()
        ) {
          await assertNoMissingLocalImportsWithRetry({ distDir, entryPath, label, env });
        } else {
          await assertNoMissingLocalImports({ distDir, entryPath, label });
        }
      }
      return {
        complete: publishedDependencyOutputsMatch(distDir, builtDependencies),
        compileComplete: true,
        expectedTargets,
        expectedFiles,
        missing,
        distDir,
        distEntrypoints,
        label,
      };
    } catch {
      // A partial import graph is stale even when every package.json target exists.
    }
  }

  return {
    complete: false,
    compileComplete: false,
    expectedTargets,
    expectedFiles,
    missing,
    distDir,
    distEntrypoints,
    label,
  };
}

function prependPathEntry(env, entry) {
  const candidate = String(entry ?? '').trim();
  if (!candidate) return;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  env.PATH = [candidate, ...current.filter((value) => value !== candidate)].join(delimiter);
}

async function prepareWorkspaceBuildEnv(packageDir, envIn) {
  const env = { ...(envIn && typeof envIn === 'object' ? envIn : process.env) };
  env.REDISMS_DISABLE_POSTINSTALL ??= '1';
  prependPathEntry(env, dirname(process.execPath));
  const workspaceToolBinDirs = await resolveWorkspaceToolBinDirs(packageDir);
  for (const workspaceToolBinDir of workspaceToolBinDirs.reverse()) {
    prependPathEntry(env, workspaceToolBinDir);
  }
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) env.TSX_TSCONFIG_PATH = tsconfigPath;
  else delete env.TSX_TSCONFIG_PATH;
  return env;
}

async function runYarn(args, {
  cwd,
  env,
  quiet,
  input = null,
  timeoutMs = null,
  captureFailureDiagnostic = false,
}) {
  const invocation = resolveYarnCommandInvocation(args, { npmExecPath: env?.npm_execpath });
  const outputMode = quiet ? 'ignore' : 'inherit';
  const stdio = input === null ? outputMode : ['pipe', outputMode, outputMode];
  await run(invocation.command, invocation.args, {
    cwd,
    env,
    stdio,
    ownedProcessGroup: true,
    ...(input === null ? {} : { input }),
    ...(timeoutMs === null ? {} : { timeoutMs }),
    ...(captureFailureDiagnostic ? { captureFailureDiagnostic: true } : {}),
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

async function runWorkspacePackageBuild(packageDir, { env, quiet, timeoutMs }) {
  try {
    await runYarn(['-s', 'build'], {
      cwd: packageDir,
      env,
      quiet,
      timeoutMs,
      captureFailureDiagnostic: quiet,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `[local] yarn is required for component at ${packageDir}. Install it via Corepack: \`corepack enable\``,
        { cause: error },
      );
    }
    throw error;
  }
}

const defaultWorkspaceBuildBoundary = {
  prepareEnv: async (packageDir, env) => prepareWorkspaceBuildEnv(packageDir, env),
  runPackageBuild: runWorkspacePackageBuild,
  runPackageScript: (packageDir, script, options) => runYarn(['-s', script], {
    cwd: packageDir, ...options, captureFailureDiagnostic: options.quiet,
  }),
};

async function ensureWorkspacePackageBuiltUnderLock({
  monorepoRoot,
  packageDir,
  packageJsonPath,
  quiet,
  env,
  force,
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  waited,
  heldLockValue,
  workspaceBuildBoundary,
  publicationMode,
  buildMode,
  dependencyDirs,
}) {
  const packageJson = await readJson(packageJsonPath);
  const inputFingerprint = readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs });
  const builtDependencies = readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs });
  const state = await inspectWorkspacePackageOutput(packageDir, packageJson, {
    env,
    retryImports: true,
    inputFingerprint,
    builtDependencies,
    publicationMode,
  });
  const {
    expectedTargets,
    missing: missingBefore,
    distDir,
    distEntrypoints,
    label,
  } = state;
  const reportImportRetry = createWorkspaceBuildWaitNotifier({ env, label, kind: 'imports' });
  if (expectedTargets.length === 0) return { built: false, reason: 'no-expected-files' };
  if (!force && state.complete) {
    return {
      built: false,
      reason: waited ? 'concurrent_build_already_completed' : 'already-built',
    };
  }

  const refreshOnly = !force && state.compileComplete;
  const priorRecord = refreshOnly ? await readJson(join(distDir, BUILD_INPUT_RECORD)) : null;

  if (!packageJson?.scripts?.build) {
    throw new Error(
      `[local] missing build outputs for ${packageJson?.name ?? packageDir}:\n`
      + missingBefore.map((path) => `- ${path}`).join('\n')
      + '\nFix: add a build script, or ensure the package does not export dist/* paths.',
    );
  }

  syncBundledWorkspacePackages({
    repoRoot: monorepoRoot,
    hostPackageDirs: [packageDir],
    replaceExisting: true,
    pruneStale: true,
    syncId: `workspace-build.${process.pid}`,
  });

  if (!refreshOnly) await onPackageBuildStart?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });
  const publishOutputs = async (tmpDistDir) => {
    const buildEnv = {
      ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: tmpDistDir,
      [WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR]: '1',
    };
    const options = { env: buildEnv, quiet, timeoutMs };
    try {
      if (refreshOnly) {
        const runScript = workspaceBuildBoundary.runPackageScript ?? defaultWorkspaceBuildBoundary.runPackageScript;
        if (packageJson.scripts?.prebuild) await runScript(packageDir, 'prebuild', options);
        if (packageJson.scripts?.['build:ui']) {
          // Live dist may retain prior generations. Only the recorded current
          // tree may seed an output-only refresh or an artifact publication.
          for (const path of priorRecord.files) {
            const sourcePath = resolve(distDir, path);
            if (!sourcePath.startsWith(`${resolve(distDir)}${sep}`)) throw new Error(`[workspace-build] invalid recorded output: ${path}`);
            const destinationPath = join(tmpDistDir, path);
            await mkdir(dirname(destinationPath), { recursive: true });
            await cp(sourcePath, destinationPath);
          }
          await runScript(packageDir, 'build:ui', options);
        }
      } else {
        await workspaceBuildBoundary.runPackageBuild(packageDir, options);
      }
    } catch (error) {
      throw new WorkspacePackageBuildError(error);
    }

    const stagedExpectedTargetMatches = resolveExpectedPackageOutputTargetMatches({
      packageDir,
      distDir: tmpDistDir,
      expectedTargets,
    });
    const missingStaged = stagedExpectedTargetMatches
      .filter(({ paths }) => paths.length === 0)
      .map(({ target }) => target);
    if (missingStaged.length > 0) {
      throw new Error(
        `[local] build completed but expected staged outputs are still missing for ${packageJson?.name ?? packageDir}:\n`
        + missingStaged.map((path) => `- ${path}`).join('\n')
        + '\nFix: ensure the package build honors HAPPIER_WORKSPACE_DIST_OUTPUT_DIR or generates the files referenced by package.json exports/main/types.',
      );
    }
    for (const entryPath of distEntrypoints) {
      await assertNoMissingLocalImportsWithRetry({
        distDir: tmpDistDir,
        entryPath: remapDistPathToDir(entryPath, { packageDir, distDir: tmpDistDir }),
        label,
        env,
        onRetry: reportImportRetry,
      });
    }
    if (readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs }) !== inputFingerprint
      || JSON.stringify(readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs })) !== JSON.stringify(builtDependencies)) {
      // A successful compiler exit cannot identify which moving files it read.
      // Do not replace the last-green tree/receipt with an unproven mixture.
      throw new BuildInputDriftError(`[workspace-build] inputs changed while building ${packageJson.name ?? packageDir}; retained the last coherent output; rerun the phase`);
    }
    const record = {
      version: 2,
      builtAt: refreshOnly ? priorRecord.builtAt : new Date().toISOString(),
      fingerprint: inputFingerprint,
      dependencies: builtDependencies,
      outputs: refreshOnly && tmpDistDir === distDir ? priorRecord.outputs : collectOutputDigests(tmpDistDir, stagedExpectedTargetMatches),
      files: refreshOnly && tmpDistDir === distDir ? priorRecord.files : collectPublishedDistFiles(tmpDistDir),
    };
    // Reference-only refreshes replace the receipt, never the compiler output.
    await writeJsonAtomic(join(tmpDistDir, BUILD_INPUT_RECORD), record);
  };
  try {
    if (refreshOnly && !packageJson.scripts?.['build:ui']) {
      await publishOutputs(distDir);
    } else {
      await buildIntoTempThenReplace(distDir, publishOutputs, {
        preserveDestinationPath: publicationMode === 'live',
        pruneStale: publicationMode === 'artifact',
      });
    }
  } catch (error) {
    const diagnosticSummary = buildMode === 'qa-runtime' && !refreshOnly ? compilerDiagnosticSummary(error) : null;
    if (!diagnosticSummary || !isWorkspacePackageOutputValid(packageDir, { monorepoRoot, dependencyDirs })) throw error;
    const recordPath = join(distDir, BUILD_INPUT_RECORD);
    const record = await readJson(recordPath);
    const lastGreen = await inspectWorkspacePackageOutput(packageDir, packageJson, {
      env, inputFingerprint: record.fingerprint, builtDependencies, allowQaFailure: true,
    });
    if (!lastGreen.complete || !Array.isArray(record.files) || record.files.some((path) => !existsSync(join(distDir, path)))) throw error;
    await writeJsonAtomic(recordPath, { ...record, qaFailure: {
      diagnosticSummary,
      lastGreenBuiltAt: record.builtAt ?? record.qaFailure?.lastGreenBuiltAt ?? statSync(recordPath).mtime.toISOString(),
    } });
    const stalePackage = readQaStalePackage(packageDir, packageJson.name, { monorepoRoot, dependencyDirs });
    await onPackageBuildDone?.({ packageDir, packageName: packageJson.name, stalePackage });
    process.stderr.write(`[workspace-build] QA last-green fallback: ${packageJson.name}\n${diagnosticSummary}\n`);
    return { built: false, reason: 'qa-last-green', stalePackage };
  }
  if (!refreshOnly) await onPackageBuildDone?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });

  return { built: !refreshOnly, refreshed: refreshOnly, reason: refreshOnly ? 'runtime-outputs-refreshed' : 'rebuilt' };
}

async function ensureWorkspacePackageBuilt(packageDir, {
  monorepoRoot,
  quiet,
  env: envIn,
  force,
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  workspaceBuildBoundary,
  publicationMode,
  buildMode,
  dependencyDirs,
}) {
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return { built: false, reason: 'missing-package-json' };

  const packageJson = await readJson(packageJsonPath);
  const inputFingerprint = readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs });
  const initial = await inspectWorkspacePackageOutput(packageDir, packageJson, {
    env: envIn,
    inputFingerprint,
    builtDependencies: readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs }),
    publicationMode,
  });
  if (initial.expectedTargets.length === 0) return { built: false, reason: 'no-expected-files' };
  if (!force && initial.complete) return { built: false, reason: 'already-built' };

  const env = await workspaceBuildBoundary.prepareEnv(packageDir, envIn);
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  const workspaceBundleLockPath = buildEntersWorkspaceBundleLock(packageJson)
    ? resolveWorkspaceBundleLockPath(monorepoRoot)
    : null;
  const reportLockWait = createWorkspaceBuildWaitNotifier({
    env,
    label: initial.label,
    kind: 'lock',
  });
  const tryResolveWaiter = force
    ? undefined
    : async () => {
      const currentPackageJson = await readJson(packageJsonPath);
      const current = await inspectWorkspacePackageOutput(packageDir, currentPackageJson, {
        env,
        retryImports: true,
        inputFingerprint: readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs }),
        builtDependencies: readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs }),
        publicationMode,
      });
      return current.complete
        ? {
          resolved: true,
          value: { built: false, reason: 'concurrent_build_already_completed' },
        }
        : { resolved: false };
    };
  const buildUnderPackageLock = async (workspaceBundleLockValue = null) => (
    await withCliDistBuildLock(
      ({ waited, heldLockValue }) => ensureWorkspacePackageBuiltUnderLock({
        monorepoRoot,
        packageDir,
        packageJsonPath,
        quiet,
        env,
        force,
        timeoutMs,
        onPackageBuildStart,
        onPackageBuildDone,
        waited,
        // Preserve the outermost inherited publication lease through the
        // package lifecycle. This process retains the package lock while the
        // child runs, so replacing an inherited B lease with P would make a
        // nested B entry wait on its own ancestor (B -> P -> B).
        heldLockValue:
          workspaceBundleLockValue
          ?? env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
          ?? heldLockValue,
        workspaceBuildBoundary,
        publicationMode,
        buildMode,
        dependencyDirs,
      }),
      { lockPath, env, onWait: reportLockWait, tryResolveWaiter },
    )
  );
  if (!workspaceBundleLockPath) return await buildUnderPackageLock();

  return await withWorkspaceBundleLock(
    async ({ heldLockValue }) => await buildUnderPackageLock(heldLockValue),
    {
      lockPath: workspaceBundleLockPath,
      heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      env,
      onWait: reportLockWait,
    },
  );
}

async function ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, options) {
  const built = [];
  const refreshed = [];
  const pluginFailures = [];
  const stalePackages = new Map();
  return await withSingleTrailingBuildPass({
    run: async (trailing) => await ensureWorkspacePackageNamesBuiltPass(monorepoRoot, packageNames, {
      ...options,
      // Preserve explicit force for packages not reached before drift, while
      // completed siblings go through ordinary declaration admission again.
      forcePackageNames: trailing
        ? options.forcePackageNames?.filter((name) => !built.includes(name))
        : options.forcePackageNames,
      built,
      refreshed,
      pluginFailures,
      stalePackages,
    }),
    onTrailingPass: () => process.stderr.write('[workspace-build] inputs changed; rebuilding changed packages in the single trailing pass\n'),
  });
}

// Wait for already admitted siblings before retrying or returning a failure.
// Prefer a genuine build error over drift: movement must not hide compilation
// failures or leave old work running alongside a new pass.
async function settleWorkspaceBuilds(promises) {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw (failures.find((result) => !(result.reason instanceof BuildInputDriftError)) ?? failures[0]).reason;
  }
  return results.map((result) => result.value);
}

async function ensureWorkspacePackageNamesBuiltPass(monorepoRoot, packageNames, {
  quiet,
  env,
  forcePackageNames = [],
  timeoutMs,
  onPackageBuildStart,
  onPackageBuildDone,
  visitedNames = [],
  includeDevDependencies,
  packageDirsByName: packageDirsByNameIn = null,
  workspaceBuildBoundary,
  publicationMode,
  buildMode,
  maxConcurrentBuilds,
  isolatePluginFailures = false,
  built,
  refreshed,
  pluginFailures,
  stalePackages,
}) {
  const visited = new Set(visitedNames);
  const forced = new Set(forcePackageNames);
  const changedClosures = new Set();
  const closureBuildPromises = new Map();
  const packageDirsByName = packageDirsByNameIn
    ?? await collectWorkspacePackageDirsByName(monorepoRoot);
  const workspacePackageNames = new Set(packageDirsByName.keys());
  const admittedWorkspacePackageNames = await collectWorkspaceDependencyClosure(
    packageNames ?? [], packageDirsByName, { includeDevDependencies },
  );
  const scheduleConcurrentPackageBuild = createAsyncConcurrencyLimiter(maxConcurrentBuilds);
  const scheduleBundledWorkspacePackageBuild = createAsyncConcurrencyLimiter(1);
  const schedulePackageBuild = (packageJson, operation) => (
    buildEntersWorkspaceBundleLock(packageJson)
      // Queue before taking general build capacity: a sibling otherwise starts
      // waiting on the shared publication lease held by this same invocation.
      ? scheduleBundledWorkspacePackageBuild(() => scheduleConcurrentPackageBuild(operation))
      : scheduleConcurrentPackageBuild(operation)
  );

  const buildWorkspaceClosure = (packageDir, ancestors = new Set()) => {
    const resolvedPackageDir = resolve(packageDir);
    if (ancestors.has(resolvedPackageDir)) return Promise.resolve(false);

    const existing = closureBuildPromises.get(resolvedPackageDir);
    if (existing) return existing;

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(resolvedPackageDir);
    const buildPromise = (async () => {
      const packageJsonPath = join(resolvedPackageDir, 'package.json');
      if (!existsSync(packageJsonPath)) return false;

      const packageJson = await readJson(packageJsonPath);
      const packageName = typeof packageJson?.name === 'string' ? packageJson.name : '';
      // Optional compiler failures retain the existing isolation contract;
      // another package's drift must not retry a genuine failed command.
      if (pluginFailures.some((failure) => failure.packageName === packageName)) return false;
      if (packageName && visited.has(packageName)) return changedClosures.has(packageName);
      if (packageName) visited.add(packageName);

      const dependencyNames = [...new Set([
        ...collectInternalWorkspaceDependencyNames(
        packageJson,
        packageName,
        { includeDevDependencies, workspacePackageNames },
        ),
        ...collectAdmittedInternalWorkspacePeerDependencyNames(
          packageJson,
          packageName,
          { admittedWorkspacePackageNames, workspacePackageNames },
        ),
      ])];
      const dependencyResults = await settleWorkspaceBuilds(dependencyNames.map(async (dependencyName) => {
        const dependencyDir = packageDirsByName.get(dependencyName);
        return dependencyDir
          ? await buildWorkspaceClosure(dependencyDir, nextAncestors)
          : false;
      }));
      const failedDependency = dependencyNames.find((name) => (
        pluginFailures.some((failure) => failure.packageName === name)
      ));
      if (failedDependency) {
        const error = new Error(`Required workspace dependency '${failedDependency}' did not publish`);
        if (!isolatePluginFailures || publicationMode === 'artifact' || !packageName.startsWith('@happier-dev/plugins-')) throw error;
        pluginFailures.push(createBundledPluginPublicationFailure({
          repoRoot: monorepoRoot, packageName, error,
        }));
        return false;
      }
      const orderedDependencyNames = dependencyNames.filter((dependencyName) => {
        const dependencyDir = packageDirsByName.get(dependencyName);
        // A cycle has no dependency-before-consumer timestamp order. The
        // recursive owner already stops at this back-edge, so exclude it from
        // the cross-invocation freshness comparison as well.
        return dependencyDir && !nextAncestors.has(resolve(dependencyDir));
      });
      const dependencyDirs = collectWorkspacePackageFingerprintDependencyNames(
        packageJson,
        packageName,
        workspacePackageNames,
        { packageDirsByName },
      )
        .filter((dependencyName) => {
          const dependencyDir = packageDirsByName.get(dependencyName);
          return dependencyDir && !nextAncestors.has(resolve(dependencyDir));
        })
        .map((dependencyName) => packageDirsByName.get(dependencyName))
        .filter(Boolean);

      let result;
      try {
        result = await schedulePackageBuild(packageJson, async () => (
          await ensureWorkspacePackageBuilt(resolvedPackageDir, {
          monorepoRoot,
          quiet,
          env,
          force: forced.has(packageName),
          timeoutMs,
          onPackageBuildStart,
          onPackageBuildDone,
          workspaceBuildBoundary,
          publicationMode,
          buildMode,
          dependencyDirs,
          })
        ));
      } catch (error) {
        if (error instanceof BuildInputDriftError) throw error;
        if (!isolatePluginFailures || publicationMode === 'artifact' || !packageName.startsWith('@happier-dev/plugins-')) throw error;
        pluginFailures.push(createBundledPluginPublicationFailure({
          repoRoot: monorepoRoot, packageName, error,
        }));
        return false;
      }
      if (result.built && packageName) built.push(packageName);
      if (result.stalePackage) stalePackages.set(packageName, result.stalePackage);
      else stalePackages.delete(packageName);
      if (result.refreshed && packageName) refreshed.push(packageName);
      if ((dependencyResults.some(Boolean) || result.built) && packageName) changedClosures.add(packageName);
      return dependencyResults.some(Boolean) || result.built;
    })();
    closureBuildPromises.set(resolvedPackageDir, buildPromise);
    return buildPromise;
  };

  await settleWorkspaceBuilds((packageNames ?? []).map(async (packageName) => {
    const packageDir = packageDirsByName.get(packageName);
    if (packageDir) await buildWorkspaceClosure(packageDir);
  }));

  return {
    built: [...new Set(built)].sort((left, right) => left.localeCompare(right)),
    ...(stalePackages.size ? { stalePackages: [...stalePackages.values()].sort((a, b) => a.packageName.localeCompare(b.packageName)) } : {}),
    ...(refreshed.length > 0 ? { refreshed: [...new Set(refreshed)].sort((left, right) => left.localeCompare(right)) } : {}),
    ...(pluginFailures.length > 0 ? {
      pluginFailures: pluginFailures.sort((left, right) => left.packageName.localeCompare(right.packageName)),
    } : {}),
  };
}

export async function ensureWorkspacePackagesBuiltByName(monorepoPath, packageNames, {
  quiet = false,
  env = process.env,
  force = false,
  timeoutMs = null,
  onPackageBuildStart = null,
  onPackageBuildDone = null,
  includeDevDependencies = true,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
  publicationMode = 'live',
  maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS,
  isolatePluginFailures = false,
  buildMode,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(monorepoPath);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const normalizedPackageNames = [...new Set(
    (packageNames ?? [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean),
  )];
  const resolvedPublicationMode = resolveWorkspaceBundlePublicationMode({ mode: publicationMode });
  const resolvedBuildMode = resolveWorkspaceBuildMode({ buildMode, env });
  const result = await ensureWorkspacePackageNamesBuilt(monorepoRoot, normalizedPackageNames, {
    quiet,
    env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolvedBuildMode },
    forcePackageNames: force ? normalizedPackageNames : [],
    timeoutMs,
    onPackageBuildStart,
    onPackageBuildDone,
    includeDevDependencies,
    workspaceBuildBoundary,
    publicationMode: resolvedPublicationMode,
    buildMode: resolvedBuildMode,
    maxConcurrentBuilds,
    isolatePluginFailures,
  });
  return { ok: true, ...result, skipped: [] };
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, {
  quiet = false,
  env = process.env,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
  publicationMode = 'live',
  maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS,
  isolatePluginFailures = false,
  buildMode,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const componentPackageJsonPath = join(componentDir, 'package.json');
  if (!existsSync(componentPackageJsonPath)) {
    return { ok: true, built: [], skipped: ['missing-component-package-json'] };
  }

  const componentPackageJson = await readJson(componentPackageJsonPath);
  const componentName = typeof componentPackageJson?.name === 'string'
    ? componentPackageJson.name
    : '';
  const packageDirsByName = await collectWorkspacePackageDirsByName(monorepoRoot);
  const packageNames = collectInternalWorkspaceDependencyNames(componentPackageJson, componentName, {
    workspacePackageNames: packageDirsByName.keys(),
  });
  const resolvedPublicationMode = resolveWorkspaceBundlePublicationMode({ mode: publicationMode });
  const resolvedBuildMode = resolveWorkspaceBuildMode({ buildMode, env });
  const result = await ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
    quiet,
    env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolvedBuildMode },
    visitedNames: [componentName].filter(Boolean),
    includeDevDependencies: true,
    packageDirsByName,
    workspaceBuildBoundary,
    publicationMode: resolvedPublicationMode,
    buildMode: resolvedBuildMode,
    maxConcurrentBuilds,
    isolatePluginFailures,
  });
  if (hasBundledWorkspaceDependencies(componentPackageJson)) {
    await withWorkspaceBundleLock(
      async () => {
        syncBundledWorkspacePackages({
          repoRoot: monorepoRoot,
          hostPackageDirs: [componentDir],
          packages: collectBundledWorkspaceDependencyNames(componentPackageJson)
            .filter((packageName) => !result.pluginFailures?.some((failure) => failure.packageName === packageName))
            .map((packageName) => packageName.split('/').at(-1))
            .filter(Boolean),
          replaceExisting: true,
          pruneStale: resolvedPublicationMode === 'artifact',
          syncId: `component-workspace-preflight.${process.pid}`,
        });
      },
      {
        lockPath: resolveWorkspaceBundleLockPath(monorepoRoot),
        heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        env,
      },
    );
  }
  return { ok: true, ...result, skipped: [] };
}
