import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { readBundledPluginPackageNames } from '../../apps/cli/scripts/build-owned/bundledPluginMembership.ts';

import { buildIntoTempThenReplace } from '../../apps/stack/scripts/utils/fs/atomic_dir_swap.mjs';
import { readCachedFileDigestSync } from '../../apps/stack/scripts/utils/fs/cached_file_digest.mjs';
import { readSourceRuntimeDependencyIdentity } from '../../apps/stack/scripts/build/source_author_inputs.mjs';
import { collectExternalRuntimeDependencies } from '../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { readWorkspaceBuildInputs } from '../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';
export { readWorkspaceBuildInputs } from '../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { assertInheritedWorkspaceBuildResources, runWorkspaceBuildAdmission, withWorkspaceBuildResources } from '../../apps/stack/scripts/utils/proc/workspace_build_admission.mjs';
import { resolveDependencyInstallRoot, resolveDependencyRefreshLockPath } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { createWorkspaceBuildWaitNotifier } from '../../apps/stack/scripts/utils/proc/workspaceBuildWaitNotifier.mjs';
import { run } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import { resolveWorkspaceToolBinDirs } from '../../apps/stack/scripts/utils/proc/workspace_tool_bins.mjs';
import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import { resolvePnpmCommandInvocation } from './execPnpmCommand.mjs';
import { withWorkspaceOutputScriptArgs } from './workspaceOutputScriptArgs.mjs';
import { resolveTypeScriptCliInvocation, requiresTypeScriptAdmission } from './resolveTypeScriptCliInvocation.mjs';
import {
  WORKSPACE_PACKAGE_BUILD_INPUT_RECORD as BUILD_INPUT_RECORD,
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetMatches,
  resolvePackageBuildOutputTargetPath,
} from './packageBuildOutputTargets.mjs';
import {
  resolveWorkspaceBundleLockPath,
  callerHoldsWorkspaceBundleLock,
  withWorkspaceBundleLock,
} from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR, WORKSPACE_BUILD_MODE_ENV, WORKSPACE_DIST_CHECK_ONLY_ENV, resolveWorkspaceBuildMode } from './workspaceChildBuildEnv.mjs';
export { WORKSPACE_BUILD_MODE_ENV, resolveWorkspaceBuildMode } from './workspaceChildBuildEnv.mjs';
import { resolveWorkspaceBundlePublicationMode } from './workspaceBundlePublication.mjs';
import { syncBundledWorkspacePackages } from './syncBundledWorkspacePackages.mjs';
import { createBundledPluginPublicationFailure } from './bundledPluginPublicationFailure.mjs';
import { BuildInputDriftError, WorkspacePackageBuildError, captureBuildInputFiles, mountCapturedWorkspaceDependencies, withSingleTrailingBuildPass, withBuildInputDependencies } from './buildInputConvergence.mjs';
import {
  collectInternalWorkspaceDependencyNames,
  collectAdmittedInternalWorkspacePeerDependencyNames,
} from './workspacePackageDependencies.mjs';

const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH =
  'dist/happier-plugin-ui/ui-artifacts.json';
const DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS = 2;
const WORKSPACE_BUILD_EVENT_PREFIX = '[workspace-build-progress] ';
function serializeWorkspaceBuildError(error) {
  return { name: error.name, message: error.message, code: error.code,
    trailingPassExhausted: error.trailingPassExhausted,
    exitCode: error.exitCode, signal: error.signal,
    ...(error.cause instanceof Error ? { cause: serializeWorkspaceBuildError(error.cause) } : {}) };
}

function deserializeWorkspaceBuildError(value) {
  const cause = value.cause ? deserializeWorkspaceBuildError(value.cause) : undefined;
  const error = value.name === 'BuildInputDriftError'
    ? new BuildInputDriftError(value.message, { cause, trailingPassExhausted: value.trailingPassExhausted })
    : value.name === 'WorkspacePackageBuildError'
      ? new WorkspacePackageBuildError(cause ?? new Error(value.message))
      : new Error(value.message, { cause });
  if (value.code !== undefined) error.code = value.code;
  if (value.exitCode !== undefined) error.exitCode = value.exitCode;
  if (value.signal !== undefined) error.signal = value.signal;
  return error;
}

export { BUILD_INPUT_RECORD };

/** Startup requires runnable output, not freshness against a moving checkout.
 * Readers describe their producer-owned output; this owner decides whether to
 * wait. Development lifecycle owners may supply their existing refresh/reload
 * operation instead of starting another build.
 */
export async function prepareWorkspaceComponentStartup({
  readLastGreen, prepare, refresh = prepare, signal, logger = console,
} = {}) {
  signal?.throwIfAborted();
  const retained = await readLastGreen();
  signal?.throwIfAborted();
  if (!retained) return await prepare();
  if (!refresh) return retained;
  const pending = Promise.resolve().then(() => {
    signal?.throwIfAborted();
    return refresh();
  });
  void pending.catch(error => {
    if (!signal?.aborted) logger.warn(`[workspace-build] background refresh failed; retained last-green output. ${error instanceof Error ? error.message : String(error)}`);
  });
  return { ...retained, refresh: pending };
}

/** Inspect the recorded dependency closure, never current source fingerprints.
 * Source consumers with an atomic generated output supply that output's paths;
 * Metro's source graph is not described by CLI/package dist receipts.
 */
export async function hasUsableWorkspaceLastGreen(componentDir, { requiredFiles } = {}) {
  if (requiredFiles) {
    return requiredFiles.length > 0 && requiredFiles.every(path => {
      try { return statSync(path).isFile(); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      }
    });
  }
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot || !existsSync(join(componentDir, 'package.json'))) return false;
  const { packageDirsByName, packageJsonByDir, closure } = await readWorkspaceComponentDependencyGraph(componentDir, { monorepoRoot });
  for (const name of closure) {
    const packageDir = packageDirsByName.get(name);
    const metadata = packageJsonByDir.get(packageDir);
    if (collectExpectedPackageOutputTargets(metadata).length === 0) continue;
    const dependencyDirs = collectWorkspacePackageFingerprintDependencyNames(metadata, name,
      new Set(packageDirsByName.keys()), { packageDirsByName }).map(dependency => packageDirsByName.get(dependency));
    if (!isWorkspacePackageOutputValid(packageDir, { monorepoRoot, dependencyDirs })) return false;
    const record = await readJson(join(packageDir, 'dist', BUILD_INPUT_RECORD));
    const state = await inspectWorkspacePackageOutput(packageDir, metadata, {
      inputFingerprint: record.fingerprint,
      builtDependencies: readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs }),
      allowQaFailure: true,
      requireCompleteDigests: true,
      env: { [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' },
    });
    if (!state.complete) return false;
  }
  return true;
}

function compilerDiagnosticSummary(error) {
  if (!(error instanceof WorkspacePackageBuildError) || error.code !== 'EEXIT') return null;
  const cause = error.cause;
  if (cause?.signal || cause?.exitCode === null) return null;
  return summarizeTypeScriptDiagnostics(error.message)?.diagnosticSummary ?? null;
}

/** One semantic-diagnostic admission for retained-package and current CLI QA output. */
export function summarizeTypeScriptDiagnostics(text) {
  const lines = String(text).replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .filter((line) => /\berror TS\d+:/.test(line));
  if (!lines.length) return null;
  // TypeScript's 1000-range diagnostics are parser failures. A partial source
  // edit must abort both retained-output admission and current CLI publication.
  if (lines.some(line => /\berror TS1\d{3}:/.test(line))) return null;
  const files = [...new Set(lines.flatMap((line) => {
    const match = line.match(/^(.+?)\(\d+,\d+\):\s*error TS\d+:/);
    return match ? [match[1].replaceAll('\\', '/')] : [];
  }))].sort();
  return { diagnosticSummary: lines.join('\n'), errorCount: lines.length, files };
}

function readQaStalePackage(packageDir, packageName, { monorepoRoot, dependencyDirs }) {
  const record = JSON.parse(readFileSync(join(packageDir, 'dist', BUILD_INPUT_RECORD), 'utf8'));
  if (!record.qaFailure || !isWorkspacePackageOutputValid(packageDir, { monorepoRoot, dependencyDirs })) return null;
  const { qaFailure, ...lastGreenBuildRecord } = record;
  const hash = createHash('sha256').update('happier:qa-last-green-output:v1\0');
  hash.update(JSON.stringify({ fingerprint: record.fingerprint, dependencies: record.dependencies,
    outputs: record.outputs.map(({ path, digest }) => ({ path, digest })), files: record.files }));
  for (const path of record.files) {
    const outputPath = resolve(packageDir, 'dist', path);
    if (!outputPath.startsWith(`${resolve(packageDir, 'dist')}${sep}`)) throw new Error(`[workspace-build] invalid recorded output: ${path}`);
    hash.update(`${path}\0${readWorkspaceBuildFileDigestAtStat(outputPath, lstatSync(outputPath, { bigint: true }),
      record.outputs.find(output => output.path === path))}\0`);
  }
  return { packageName, lastGreenBuildRecord, lastGreenBuiltAt: qaFailure.lastGreenBuiltAt,
    diagnosticSummary: qaFailure.diagnosticSummary, outputIdentity: hash.digest('hex') };
}

/** Project QA failures from the same package records used by source-dev. */
export async function inspectWorkspaceQaStalePackages(monorepoPath, packageNames, { includeDevDependencies = false } = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(monorepoPath);
  if (!monorepoRoot) return [];
  const { packageDirsByName } = await readWorkspacePackageGraph(monorepoRoot);
  const closure = await collectWorkspaceDependencyClosure(packageNames, packageDirsByName, { includeDevDependencies });
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

/** Read the same dependency outputs admitted by the component preflight. */
export async function inspectWorkspaceQaStalePackagesForComponent(componentDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot || !existsSync(join(componentDir, 'package.json'))) return [];
  const component = await readJson(join(componentDir, 'package.json'));
  const { packageDirsByName } = await readWorkspacePackageGraph(monorepoRoot);
  const names = collectInternalWorkspaceDependencyNames(component, component.name, {
    workspacePackageNames: packageDirsByName.keys(),
  });
  return await inspectWorkspaceQaStalePackages(monorepoRoot, names, { includeDevDependencies: true });
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

async function readWorkspacePackageGraph(monorepoRoot) {
  const paths = await collectWorkspacePackageJsonPaths(monorepoRoot);
  const packageDirsByName = new Map();
  const packageJsonByDir = new Map();

  for (const packageJsonPath of paths) {
    let packageJson = null;
    try {
      packageJson = await readJson(packageJsonPath);
    } catch {
      continue;
    }
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
    if (packageName) {
      const packageDir = dirname(packageJsonPath);
      packageDirsByName.set(packageName, packageDir);
      packageJsonByDir.set(packageDir, packageJson);
    }
  }

  return { packageDirsByName, packageJsonByDir };
}

async function collectWorkspaceDependencyClosure(packageNames, packageDirsByName, { includeDevDependencies = true, packageJsonByDir } = {}) {
  const admitted = new Set();
  const workspacePackageNames = new Set(packageDirsByName.keys());
  const visit = async (name) => {
    if (admitted.has(name)) return;
    const dir = packageDirsByName.get(name);
    if (!dir) return;
    admitted.add(name);
    const packageJson = packageJsonByDir?.get(dir) ?? await readJson(join(dir, 'package.json'));
    await Promise.all(collectInternalWorkspaceDependencyNames(packageJson, name, {
      includeDevDependencies, workspacePackageNames,
    }).map(visit));
  };
  await Promise.all(packageNames.map(visit));
  return admitted;
}

/** Build admission, retained-output inspection and recovery watches consume
 * the same transitive workspace graph, including compiler dependencies.
 */
export async function readWorkspaceComponentDependencyGraph(componentDir, {
  monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir),
} = {}) {
  if (!monorepoRoot || !existsSync(join(componentDir, 'package.json'))) return null;
  const componentPackageJson = await readJson(join(componentDir, 'package.json'));
  const graph = await readWorkspacePackageGraph(monorepoRoot);
  const packageNames = collectInternalWorkspaceDependencyNames(componentPackageJson, componentPackageJson.name, {
    workspacePackageNames: graph.packageDirsByName.keys(),
  });
  const closure = await collectWorkspaceDependencyClosure(packageNames, graph.packageDirsByName, { packageJsonByDir: graph.packageJsonByDir });
  return { ...graph, componentPackageJson, packageNames, closure };
}

/** Failure-only reader diagnostic. This does not certify the reader or rebuild
 * anything; currentness remains the publisher's recorded-output decision. */
export async function findFirstNoncurrentWorkspaceDependency(componentDir, { env = process.env, buildMode = 'strict' } = {}) {
  const graph = await readWorkspaceComponentDependencyGraph(componentDir);
  if (!graph) return null;
  const { packageDirsByName, packageJsonByDir, packageNames, closure } = graph;
  const workspacePackageNames = new Set(packageDirsByName.keys());
  const visited = new Set();
  const visit = name => {
    if (visited.has(name)) return null;
    visited.add(name);
    const packageDir = packageDirsByName.get(name);
    if (!packageDir) return null;
    const metadata = packageJsonByDir.get(packageDir);
    const dependencies = [
      ...collectInternalWorkspaceDependencyNames(metadata, name, { workspacePackageNames }),
      ...collectAdmittedInternalWorkspacePeerDependencyNames(metadata, name, {
        admittedWorkspacePackageNames: closure, workspacePackageNames,
      }),
    ];
    for (const dependency of dependencies) {
      const first = visit(dependency);
      if (first) return first;
    }
    if (collectExpectedPackageOutputTargets(metadata).length === 0) return null;
    const dependencyDirs = collectWorkspacePackageFingerprintDependencyNames(metadata, name,
      workspacePackageNames, { packageDirsByName }).map(dependency => packageDirsByName.get(dependency));
    return isWorkspacePackageOutputCurrent(packageDir, { dependencyDirs, env, buildMode }) ? null : name;
  };
  for (const name of packageNames) {
    const first = visit(name);
    if (first) return first;
  }
  return null;
}

/** Collect before requesting capacity. Repeating this observation beneath the
 * admitted leases detects a changed graph without extending a held lock set. */
export async function collectWorkspaceBuildBatchResources(componentDirs, { env = process.env, admissionClass = 'compilation' } = {}) {
  const components = [...new Set(componentDirs.map(path => resolve(path)))].sort();
  if (components.length === 0) throw new Error('Workspace build batch requires a consuming component');
  const monorepoRoot = coerceHappyMonorepoRootFromPath(components[0]);
  if (!monorepoRoot || components.some(path => coerceHappyMonorepoRootFromPath(path) !== monorepoRoot)) {
    throw new Error('Workspace build batch components must belong to one monorepo');
  }
  const { packageDirsByName, packageJsonByDir } = await readWorkspacePackageGraph(monorepoRoot);
  const componentInputs = await Promise.all(components.map(async path => [path, await readJson(join(path, 'package.json'))]));
  const closures = await Promise.all(componentInputs.map(async ([, manifest]) => {
    const requested = collectInternalWorkspaceDependencyNames(manifest, manifest.name, {
      workspacePackageNames: packageDirsByName.keys(),
    });
    const closure = await collectWorkspaceDependencyClosure(requested, packageDirsByName, { packageJsonByDir });
    // Match the publisher's own visited consumer, while preserving this
    // component as a producer when another selected component needs its dist.
    closure.delete(manifest.name);
    return [...closure];
  }));
  const packageNames = [...new Set(closures.flat())].sort();
  const consumerOnlyPackageNames = componentInputs.map(([, manifest]) => manifest.name)
    .filter(name => typeof name === 'string' && !packageNames.includes(name)).sort();
  const { resolveWorkspacePackageBuildAdmissionClass, resolveHeavyweightMemoryFloorKiB } = await import(
    '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs'
  );
  const producerClasses = await Promise.all(packageNames.map(async name => {
    const cwd = packageDirsByName.get(name);
    const packageJson = packageJsonByDir.get(cwd);
    return packageJson.scripts?.build && collectExpectedPackageOutputTargets(packageJson).length
      ? await resolveWorkspacePackageBuildAdmissionClass({ packageJson, cwd, env, repoRoot: monorepoRoot }) : null;
  }));
  for (const required of producerClasses) {
    if (required && resolveHeavyweightMemoryFloorKiB(required) > resolveHeavyweightMemoryFloorKiB(admissionClass)) {
      admissionClass = required;
    }
  }
  const installDir = resolveDependencyInstallRoot(monorepoRoot);
  const locks = [
    { kind: 'dependency', installDir, path: resolveDependencyRefreshLockPath(installDir, env) },
    // Actual consuming components finish their existing bundled-host sync.
    { path: resolveWorkspaceBundleLockPath(monorepoRoot) },
    ...packageNames.map(name => {
      const dir = packageDirsByName.get(name);
      return { path: resolveWorkspacePackageBuildLockPath(dir, packageJsonByDir.get(dir)) };
    }),
  ];
  const identity = createHash('sha256').update(JSON.stringify({ componentInputs, locks, admissionClass,
    packages: packageNames.map(name => {
      const dir = packageDirsByName.get(name);
      return [name, dir, packageJsonByDir.get(dir)];
    }),
  })).digest('hex');
  return { locks, identity, packageNames, consumerOnlyPackageNames, admissionClass };
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

function isBundledPluginUiWorkspacePackage(packageJson, { monorepoRoot, packageDir }) {
  const packageName = String(packageJson.name ?? '');
  return packageName.startsWith('@happier-dev/plugins-')
    && typeof packageJson.scripts?.['build:ui'] === 'string'
    && Boolean(packageJson.scripts['build:ui'].trim())
    && resolve(packageDir) === resolve(monorepoRoot, 'packages/plugins', packageName.slice('@happier-dev/plugins-'.length))
    && readBundledPluginPackageNames(monorepoRoot).includes(packageName);
}

function buildEntersWorkspaceBundleLock(packageJson, context) {
  return hasBundledWorkspaceDependencies(packageJson)
    || isBundledPluginUiWorkspacePackage(packageJson, context);
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

export function readWorkspaceBuildFileDigest(path, { followSymlinks = false } = {}) {
  const stat = (followSymlinks ? statSync : lstatSync)(path, { bigint: true });
  return readWorkspaceBuildFileDigestAtStat(path, stat);
}

const OUTPUT_VERIFICATION_FIELDS = ['size', 'dev', 'ino', 'mtimeNs', 'ctimeNs'];

function outputVerification(stat) {
  return Object.fromEntries(OUTPUT_VERIFICATION_FIELDS.map(key => [key, String(stat[key])]));
}

function outputVerificationMatches(verification, stat) {
  return verification && OUTPUT_VERIFICATION_FIELDS.every(key =>
    typeof verification[key] === 'string' && verification[key] === String(stat[key]));
}

function readWorkspaceBuildFileDigestAtStat(path, stat, recordedOutput) {
  if (!stat.isFile()) throw new Error(`[workspace-build] expected a build input file: ${path}`);
  if (/^[a-f0-9]{64}$/.test(recordedOutput?.digest)
    && outputVerificationMatches(recordedOutput.verification, stat)) return recordedOutput.digest;
  const digest = readCachedFileDigestSync(path, stat);
  if (digest.startsWith('metadata:')) throw new Error(`[workspace-build] unreadable build input: ${path}`);
  return digest;
}

function digestDirectory(path, hash, { declarationsOnly = false, root = path, followSymlinks = false, recordedOutputs } = {}) {
  if (!existsSync(path)) return;
  for (const name of readdirSync(path).sort()) {
    if (name === BUILD_INPUT_RECORD) continue;
    const child = join(path, name);
    const stat = (followSymlinks ? statSync : lstatSync)(child, { bigint: true });
    if (stat.isDirectory()) digestDirectory(child, hash, { declarationsOnly, root, followSymlinks, recordedOutputs });
    else if (!declarationsOnly || /\.d\.(?:ts|mts|cts)$/.test(name)) {
      hash.update(`${relative(root, child).split(sep).join('/')}\0`);
      if (stat.isFile()) hash.update(readWorkspaceBuildFileDigestAtStat(child, stat,
        recordedOutputs?.get(relative(root, child).split(sep).join('/'))));
      else hash.update(`other:${stat.mode}:${stat.size}:${stat.mtimeNs}`);
      hash.update('\0');
    }
  }
}

function digestDependencyOutputs(packageDir, packageJson, hash, { declarationsOnly = false } = {}) {
  const distDir = join(packageDir, 'dist');
  let recordedOutputs;
  try {
    const record = JSON.parse(readFileSync(join(distDir, BUILD_INPUT_RECORD), 'utf8'));
    if (record.version === 2 && Array.isArray(record.outputs)) {
      recordedOutputs = new Map([...(Array.isArray(record.outputVerification) ? record.outputVerification : []),
        ...record.outputs].map(output => [output.path, output]));
    }
  } catch { /* An unrecorded dependency still uses real content verification. */ }
  digestDirectory(distDir, hash, { declarationsOnly, recordedOutputs });
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
  env = process.env,
  includeShippedFiles = false,
  excludeGeneratedPluginManifest,
  excludeGeneratedPluginArtifacts = false,
  identitySourceRepoDir = coerceHappyMonorepoRootFromPath(packageDir) ?? env.HAPPIER_STACK_REPO_DIR,
  identityRepoDir = env.HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR,
  installedDependencyRepoDir = env.HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR,
  resolveTypeScriptCliInvocationImpl = resolveTypeScriptCliInvocation,
}) {
  const hash = createHash('sha256');
  hash.update('happier:workspace-package-build:v2\0');
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const inputPaths = readWorkspaceBuildInputs(packageDir, {
    includeShippedFiles,
    // First-party plugin compilation consumes authored src/manifest.ts. Its
    // serialized plugin.json is downstream publisher output; full shipped
    // byte/integrity consumers still include it unless explicitly excluded.
    excludeGeneratedPluginManifest: excludeGeneratedPluginManifest
      ?? (!includeShippedFiles && String(packageJson.name ?? '').startsWith('@happier-dev/plugins-')),
    excludeGeneratedPluginArtifacts,
  })
    .map((path) => join(packageDir, path));
  const invocation = resolveTypeScriptCliInvocationImpl({ args: [], env, invocationKind: 'build' });
  const compilerPath = invocation.compilerPath ?? invocation.argsPrefix[0];
  const compilerPackageJson = resolve(dirname(compilerPath), '..', 'package.json');
  // The canonical selector's @typescript installation owns the actual native
  // executable and launcher helpers. Its launcher alone is not tool identity.
  const compilerInstallationDir = dirname(dirname(dirname(compilerPath)));
  const buildOwnerPaths = ['ensureWorkspacePackagesBuilt.mjs', 'buildTypeScriptPackageDist.mjs', 'workspaceOutputScriptArgs.mjs'].map(name => {
    const capturedPath = identitySourceRepoDir && join(identitySourceRepoDir, 'scripts/workspaces', name);
    return capturedPath && existsSync(capturedPath) ? capturedPath : fileURLToPath(new URL(`./${name}`, import.meta.url));
  });
  const identityPathFor = path => {
    if (!identityRepoDir || !identitySourceRepoDir) return path;
    const capturedIdentity = remapPathToDirectory(path, { sourceDir: identitySourceRepoDir, destinationDir: identityRepoDir });
    // Package captures mount installed tools from their immediate source repo.
    // Keep those compiler paths in the same producer frame as captured inputs.
    return installedDependencyRepoDir && capturedIdentity === path
      ? remapPathToDirectory(capturedIdentity, { sourceDir: installedDependencyRepoDir, destinationDir: identityRepoDir })
      : capturedIdentity;
  };
  const paths = [...new Set([
    ...inputPaths,
    compilerPath,
    compilerPackageJson,
    ...buildOwnerPaths,
  ])].sort((a, b) => identityPathFor(a) < identityPathFor(b) ? -1 : identityPathFor(a) > identityPathFor(b) ? 1 : 0);
  for (const path of paths) {
    const identityPath = identityPathFor(path);
    hash.update(`${identityPath}\0${readWorkspaceBuildFileDigest(path)}\0`);
  }
  hash.update(`compiler-installation:${identityPathFor(compilerInstallationDir)}\0`);
  digestDirectory(compilerInstallationDir, hash, { followSymlinks: true });
  // Installation policy is not a package's dependency identity: unrelated UI
  // lock/patch updates must not invalidate every workspace. Reuse the installed
  // closure owner. Runtime dependencies consume bytes; development and peer
  // dependencies supply declarations to this TypeScript compilation.
  const resolveFrom = join(installedDependencyRepoDir && identitySourceRepoDir
    ? remapPathToDirectory(packageDir, { sourceDir: identitySourceRepoDir, destinationDir: installedDependencyRepoDir })
    : packageDir, 'package.json');
  const runtimeDependencies = collectExternalRuntimeDependencies(packageJson)
    .filter(dependency => !dependency.declaredSpec.startsWith('workspace:'));
  const runtimeDependencyNames = new Set(runtimeDependencies.map(dependency => dependency.name));
  const declarationDependencies = collectExternalRuntimeDependencies({
    dependencies: { ...packageJson.peerDependencies, ...packageJson.devDependencies },
  }).filter(dependency => !dependency.declaredSpec.startsWith('workspace:') && !runtimeDependencyNames.has(dependency.name));
  for (const [dependencies, declarationsOnly] of [[runtimeDependencies, false], [declarationDependencies, true]]) {
    hash.update(readSourceRuntimeDependencyIdentity({
      imports: dependencies.map(dependency => ({ path: dependency.name, resolveFrom })),
      declarationsOnly,
      identityPathFor,
    }));
  }
  for (const dependencyDir of [...dependencyDirs].sort()) {
    const identityDependencyDir = identityRepoDir && identitySourceRepoDir
      ? remapPathToDirectory(dependencyDir, { sourceDir: identitySourceRepoDir, destinationDir: identityRepoDir }) : dependencyDir;
    hash.update(`dependency:${identityDependencyDir}\0`);
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
  return [...new Set([
    ...expectedTargetMatches.flatMap(({ paths }) => paths),
    ...collectPublishedDistFiles(distDir).map((path) => join(distDir, path)),
  ])]
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

function readVerifiedOutputRecord(distDir, inputFingerprint, { requirePruned = false, requireCompleteDigests = false, allowQaFailure = true, buildMode = 'qa-runtime' } = {}) {
  try {
    const record = JSON.parse(readFileSync(join(distDir, BUILD_INPUT_RECORD), 'utf8'));
    if (!allowQaFailure && record.qaFailure) return false;
    if (buildMode === 'strict' && record.buildMode === 'qa-runtime') return false;
    if (record.version !== 2 || record.fingerprint !== inputFingerprint || !Array.isArray(record.outputs) || record.outputs.length === 0) {
      return false;
    }
    // Older receipts may cover only declared exports. A semantic-only check
    // can retain emitted bytes only when every recorded file is integrity-bound.
    if (requireCompleteDigests && (!Array.isArray(record.files) || record.files.length === 0
      || record.files.some((path) => !record.outputs.some((output) => output.path === path)))) return false;
    if (requirePruned) {
      const actualFiles = collectPublishedDistFiles(distDir);
      if (
        !Array.isArray(record.files)
        || record.files.length !== actualFiles.length
        || record.files.some((path, index) => path !== actualFiles[index])
      ) return false;
    }
    let verificationNeeded = false;
    const outputs = record.outputs.map(output => {
      const { path, digest } = output;
      if (typeof path !== 'string' || !path || !/^[a-f0-9]{64}$/.test(digest)) return false;
      const outputPath = resolve(distDir, path);
      if (!outputPath.startsWith(`${resolve(distDir)}${sep}`)) return false;
      const stat = lstatSync(outputPath, { bigint: true });
      if (readWorkspaceBuildFileDigestAtStat(outputPath, stat, output) !== digest) return false;
      if (!outputVerificationMatches(output.verification, stat)) verificationNeeded = true;
      return { ...output, verification: outputVerification(stat) };
    });
    if (outputs.some(output => output === false)) return false;
    // Live publication retains older files for already-loaded readers. They
    // still participate in dependency identity, but are not current compiler
    // output. Persist their stat proof in this same publisher-owned record.
    const recordedPaths = new Set(outputs.map(output => output.path));
    const previousVerification = new Map((Array.isArray(record.outputVerification) ? record.outputVerification : [])
      .map(output => [output.path, output]));
    const verification = collectPublishedDistFiles(distDir).flatMap(path => {
      if (recordedPaths.has(path)) return [];
      const outputPath = join(distDir, path);
      const stat = lstatSync(outputPath, { bigint: true });
      if (!stat.isFile()) return [];
      return [{ path, digest: readWorkspaceBuildFileDigestAtStat(outputPath, stat, previousVerification.get(path)),
        verification: outputVerification(stat) }];
    });
    if (JSON.stringify(record.outputVerification ?? []) !== JSON.stringify(verification)) verificationNeeded = true;
    return { record: { ...record, outputs, outputVerification: verification }, verificationNeeded };
  } catch {
    return false;
  }
}

function publishedOutputsMatch(distDir, inputFingerprint, options) {
  return Boolean(readVerifiedOutputRecord(distDir, inputFingerprint, options));
}

export function isWorkspacePackageOutputCurrent(packageDir, { dependencyDirs = [], buildMode = 'qa-runtime', env = process.env } = {}) {
  return publishedOutputsMatch(
    join(packageDir, 'dist'),
    readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs, env }),
    { allowQaFailure: false, buildMode },
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

function publishedDependencyOutputsMatch(distDir, dependencies, { requireRecorded = false } = {}) {
  if (dependencies.length === 0 && !requireRecorded) return true;
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
  entryPaths,
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
      await assertNoMissingLocalImports({ distDir, entryPath, entryPaths, label });
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
  outputDir = join(packageDir, 'dist'),
  requireCompleteDigests = false,
} = {}) {
  const expectedTargets = collectExpectedPackageOutputTargets(packageJson);
  const distDir = outputDir;
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

  const verifiedOutput = missing.length === 0 && inputFingerprint
    && readVerifiedOutputRecord(distDir, inputFingerprint, {
      requirePruned: publicationMode === 'artifact',
      requireCompleteDigests,
      allowQaFailure,
      buildMode: resolveWorkspaceBuildMode({ env }),
    });
  if (verifiedOutput) {
    try {
      if (
        retryImports
        && String(env.HAPPIER_WORKSPACE_DIST_IMPORT_VALIDATION_RETRY_ATTEMPTS ?? '').trim()
      ) {
        await assertNoMissingLocalImportsWithRetry({ distDir, entryPath: distEntrypoints[0], entryPaths: distEntrypoints, label, env });
      } else {
        await assertNoMissingLocalImports({ distDir, entryPaths: distEntrypoints, label });
      }
      return {
        complete: publishedDependencyOutputsMatch(distDir, builtDependencies, { requireRecorded: requireCompleteDigests }),
        compileComplete: true,
        verifiedOutput,
        invalidation: 'dependencies-changed',
        expectedTargets,
        expectedFiles,
        missing,
        distDir,
        distEntrypoints,
        label,
      };
    } catch {
      // A partial import graph is stale even when every package.json target exists.
      return { complete: false, compileComplete: false, invalidation: 'incomplete-imports',
        expectedTargets, expectedFiles, missing, distDir, distEntrypoints, label };
    }
  }

  let invalidation = 'outputs-changed';
  if (missing.length > 0) invalidation = 'missing-outputs';
  else {
    try {
      const record = await readJson(join(distDir, BUILD_INPUT_RECORD));
      if (record.qaFailure && !allowQaFailure) invalidation = 'previous-compiler-failure';
      else if (record.buildMode === 'qa-runtime' && resolveWorkspaceBuildMode({ env }) === 'strict') invalidation = 'unchecked-qa-output';
      else if (record.fingerprint !== inputFingerprint) invalidation = 'inputs-changed';
    } catch { invalidation = 'missing-build-record'; }
  }
  return {
    complete: false,
    compileComplete: false,
    invalidation,
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

async function runPnpm(args, {
  cwd,
  env,
  quiet,
  input = null,
  timeoutMs = null,
  captureFailureDiagnostic = false,
}) {
  const invocation = resolvePnpmCommandInvocation(args, { npmExecPath: env?.npm_execpath });
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

async function runWorkspacePackageBuild(packageDir, { env, quiet, timeoutMs, captureFailureDiagnostic = quiet }) {
  try {
    await runPnpm(['run', '--silent', 'build'], {
      cwd: packageDir,
      env,
      quiet,
      timeoutMs,
      captureFailureDiagnostic,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `[local] pnpm is required for component at ${packageDir}. Run \`node scripts/ci/setup-pnpm.mjs\` from the repository.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export const defaultWorkspaceBuildBoundary = {
  workerModule: import.meta.url,
  workerExport: 'defaultWorkspaceBuildBoundary',
  prepareEnv: async (packageDir, env) => prepareWorkspaceBuildEnv(packageDir, env),
  runPackageBuild: runWorkspacePackageBuild,
  runPackageScript: (packageDir, script, options) => withWorkspaceOutputScriptArgs(
    { packageDir, scriptName: script, env: options.env },
    args => runPnpm(args, { cwd: packageDir, ...options }),
  ),
};

async function captureWorkspacePackage({ monorepoRoot, packageDir, dependencyDirs, env }) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-workspace-capture-'));
  const repoDir = join(directory, 'repo');
  const capturedDirs = [packageDir, ...dependencyDirs];
  try {
    const readPaths = async () => {
      const paths = new Set();
      const visit = async path => {
        const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) return;
        paths.add(relative(monorepoRoot, path));
        if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
      };
      for (const dir of capturedDirs) {
        for (const path of readWorkspaceBuildInputs(dir, { includeShippedFiles: true })) await visit(resolve(dir, path));
        await visit(join(dir, 'dist'));
      }
      for (const name of await readdir(monorepoRoot, { withFileTypes: true })) {
        if (name.isFile()) await visit(join(monorepoRoot, name.name));
      }
      // Package scripts execute the canonical build owner and its process/FS
      // adapters; capture that consumed code as well as the package sources.
      await visit(join(monorepoRoot, 'scripts/workspaces'));
      await visit(join(monorepoRoot, 'apps/stack/scripts/utils'));
      return [...paths];
    };
    const capture = await captureBuildInputFiles({ sourceDir: monorepoRoot, captureDir: repoDir, readPaths });
    const branchDirs = new Set(capture.files.flatMap(file => {
      const dirs = [];
      for (let path = dirname(join(monorepoRoot, file)); path !== monorepoRoot; path = dirname(path)) dirs.push(path);
      return dirs;
    }));
    // Installed tools and unrelated workspaces keep their existing resolution
    // paths. Authored inputs and dependency outputs are physical capture files.
    const mount = async (source, target) => {
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (['.git', '.project', '.happier', 'node_modules'].includes(entry.name) || entry.name.startsWith('.dist.')) continue;
        const path = join(source, entry.name);
        const destination = join(target, entry.name);
        if (existsSync(destination)) {
          if (entry.isDirectory() && !capturedDirs.includes(source) && branchDirs.has(path)) await mount(path, destination);
          continue;
        }
        if (capturedDirs.includes(source)) continue;
        if (entry.isDirectory()) await symlink(path, destination, process.platform === 'win32' ? 'junction' : 'dir');
        else await cp(path, destination, { verbatimSymlinks: true });
      }
    };
    await mount(monorepoRoot, repoDir);
    await mountCapturedWorkspaceDependencies({ sourceDir: monorepoRoot, captureDir: repoDir,
      workspaceDirs: capturedDirs.map(dir => relative(monorepoRoot, dir)) });
    const capturePackageDir = join(repoDir, relative(monorepoRoot, packageDir));
    const captureDependencyDirs = dependencyDirs.map(dir => join(repoDir, relative(monorepoRoot, dir)));
    const identityRepoDir = env.HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR || monorepoRoot;
    const inputFingerprint = readWorkspacePackageInputFingerprint({ packageDir: capturePackageDir, dependencyDirs: captureDependencyDirs, env,
      identitySourceRepoDir: repoDir, identityRepoDir, installedDependencyRepoDir: monorepoRoot });
    const builtDependencies = readWorkspaceBuiltDependencies({ monorepoRoot: repoDir, dependencyDirs: captureDependencyDirs });
    return { packageDir: capturePackageDir, dependencyDirs: captureDependencyDirs, repoDir, inputFingerprint, builtDependencies,
      env: { ...env, HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR: monorepoRoot,
        HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: identityRepoDir },
      cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}


async function ensureWorkspacePackageBuiltUnderLock(options) {
  return await withBuildInputDependencies({ sourceDir: options.monorepoRoot, env: options.env, signal: options.signal },
    env => consumeWorkspacePackageBuildInputs({ ...options, env }));
}

async function consumeWorkspacePackageBuildInputs({
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
  trailingPass,
  dependencyDirs,
}) {
  const packageJson = await readJson(packageJsonPath);
  let preparedInputFingerprint = null;
  if (isBundledPluginUiWorkspacePackage(packageJson, { monorepoRoot, packageDir })) {
    // Joint admission owns dependency, publication and package custody before
    // the canonical writer prepares the package-root input consumed by capture.
    const { prepareBundledPluginUiManifestForWorkspaceBuild } = await import(
      '../../apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'
    );
    const manifestInputFingerprint = readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs, env });
    const prepared = await prepareBundledPluginUiManifestForWorkspaceBuild({
      repoRoot: monorepoRoot, packageName: packageJson.name,
      heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, env,
    });
    if (prepared) preparedInputFingerprint = manifestInputFingerprint;
  }
  let inputFingerprint = readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs, env });
  if (preparedInputFingerprint && inputFingerprint !== preparedInputFingerprint) {
    throw new BuildInputDriftError(`[workspace-build] inputs changed after preparing the UI manifest for ${packageJson.name ?? packageDir}; retained the last coherent output; rerun the phase`);
  }
  let builtDependencies = readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs });
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
    if (state.verifiedOutput.verificationNeeded) {
      // Initial inspection is read-only. Only this admitted publisher may
      // persist successful migration/reverification of worker-local identity.
      await writeJsonAtomic(join(distDir, BUILD_INPUT_RECORD), state.verifiedOutput.record);
    }
    return {
      built: false,
      reason: waited ? 'concurrent_build_already_completed' : 'already-built',
    };
  }

  let refreshOnly = !force && state.compileComplete;
  const checkOnly = !force && buildMode === 'strict' && state.invalidation === 'unchecked-qa-output'
    && publishedOutputsMatch(distDir, inputFingerprint, {
      requireCompleteDigests: true, allowQaFailure: false,
    }) && publishedDependencyOutputsMatch(distDir, builtDependencies);
  const priorRecord = refreshOnly || checkOnly ? await readJson(join(distDir, BUILD_INPUT_RECORD)) : null;

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
  // Typecheck prerequisites retain strict semantic checking, but consume the
  // same bounded input capture as source-dev instead of requiring a quiet tree.
  const capture = buildMode !== 'strict' || env.HAPPIER_WORKSPACE_CAPTURE_INPUTS === '1'
    ? await captureWorkspacePackage({ monorepoRoot, packageDir, dependencyDirs, env }) : null;
  const buildPackageDir = capture?.packageDir ?? packageDir;
  const buildDependencyDirs = capture?.dependencyDirs ?? dependencyDirs;
  if (capture) {
    if (capture.inputFingerprint !== inputFingerprint) refreshOnly = false;
    inputFingerprint = capture.inputFingerprint;
    builtDependencies = capture.builtDependencies;
  }
  let publishedRecord;
  const publishOutputs = async (tmpDistDir) => {
    // Capture may legitimately converge to newer authored source. Its staged
    // UI input must not be the manifest prepared from an earlier source basis.
    if (preparedInputFingerprint && inputFingerprint !== preparedInputFingerprint) {
      throw new BuildInputDriftError(`[workspace-build] inputs changed while capturing the UI manifest for ${packageJson.name ?? packageDir}; retained the last coherent output; rerun the phase`);
    }
    const buildEnv = {
      ...(capture?.env ?? env),
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: tmpDistDir,
      [WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR]: '1',
      [WORKSPACE_DIST_CHECK_ONLY_ENV]: checkOnly ? '1' : '0',
    };
    // QA fallback needs the compiler's diagnostic even when preparation is
    // verbose. The adapters transport evidence; this owner decides eligibility.
    const options = { env: buildEnv, quiet, timeoutMs, captureFailureDiagnostic: quiet || buildMode !== 'strict' };
    try {
      if (refreshOnly) {
        const runScript = workspaceBuildBoundary.runPackageScript ?? defaultWorkspaceBuildBoundary.runPackageScript;
        if (packageJson.scripts?.prebuild) await runScript(buildPackageDir, 'prebuild', options);
        if (packageJson.scripts?.['build:ui']) {
          // Live dist may retain prior generations. Only the recorded current
          // tree may seed an output-only refresh or an artifact publication.
          for (const path of priorRecord.files) {
            const sourceDistDir = join(buildPackageDir, 'dist');
            const sourcePath = resolve(sourceDistDir, path);
            if (!sourcePath.startsWith(`${resolve(sourceDistDir)}${sep}`)) throw new Error(`[workspace-build] invalid recorded output: ${path}`);
            const destinationPath = join(tmpDistDir, path);
            await mkdir(dirname(destinationPath), { recursive: true });
            await cp(sourcePath, destinationPath);
          }
          await runScript(buildPackageDir, 'build:ui', options);
        }
      } else {
        if (checkOnly) {
          for (const path of priorRecord.files) {
            const sourcePath = resolve(distDir, path);
            if (!sourcePath.startsWith(`${resolve(distDir)}${sep}`)) throw new Error(`[workspace-build] invalid recorded output: ${path}`);
            const destinationPath = join(tmpDistDir, path);
            await mkdir(dirname(destinationPath), { recursive: true });
            await cp(sourcePath, destinationPath, { preserveTimestamps: true });
          }
        }
        await workspaceBuildBoundary.runPackageBuild(buildPackageDir, options);
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
    const stagedEntrypoints = distEntrypoints.map(entryPath => remapDistPathToDir(entryPath, { packageDir, distDir: tmpDistDir }));
    await assertNoMissingLocalImportsWithRetry({
      distDir: tmpDistDir,
      entryPath: stagedEntrypoints[0],
      entryPaths: stagedEntrypoints,
      label,
      env,
      onRetry: reportImportRetry,
    });
    if ((!capture && readWorkspacePackageInputFingerprint({ packageDir: buildPackageDir, dependencyDirs: buildDependencyDirs, env: buildEnv }) !== inputFingerprint)
      || JSON.stringify(readWorkspaceBuiltDependencies({ monorepoRoot: capture?.repoDir ?? monorepoRoot, dependencyDirs: buildDependencyDirs })) !== JSON.stringify(builtDependencies)
      || (checkOnly && !publishedOutputsMatch(distDir, inputFingerprint, { requireCompleteDigests: true, allowQaFailure: false }))) {
      // Uncaptured compilation still needs the live-tree fence. A private
      // capture belongs to this build: generators may derive source there
      // before compilation without changing the admitted producer identity.
      // Later producer edits belong to the next build, not this publication.
      throw new BuildInputDriftError(`[workspace-build] inputs changed while building ${packageJson.name ?? packageDir}; retained the last coherent output; rerun the phase`);
    }
    const record = {
      version: 2,
      // A runtime-only refresh cannot upgrade emit-only compiler evidence.
      buildMode: refreshOnly ? priorRecord.buildMode ?? 'strict' : buildMode === 'source-dev' ? 'qa-runtime' : buildMode,
      builtAt: refreshOnly ? priorRecord.builtAt : new Date().toISOString(),
      fingerprint: inputFingerprint,
      dependencies: builtDependencies,
      outputs: refreshOnly && tmpDistDir === distDir
        ? priorRecord.outputs
        : collectOutputDigests(tmpDistDir, stagedExpectedTargetMatches),
      files: refreshOnly && tmpDistDir === distDir ? priorRecord.files : collectPublishedDistFiles(tmpDistDir),
      ...(refreshOnly && tmpDistDir === distDir && priorRecord.outputVerification
        ? { outputVerification: priorRecord.outputVerification } : {}),
    };
    // Reference-only refreshes replace the receipt, never the compiler output.
    await writeJsonAtomic(join(tmpDistDir, BUILD_INPUT_RECORD), record);
    publishedRecord = record;
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
    // Mounted publication can preserve existing inodes or move staged ones.
    // Certify the actual final paths, and replace the record atomically last.
    // The staged record intentionally contains no reusable inode proof.
    const verifiedOutput = readVerifiedOutputRecord(distDir, publishedRecord.fingerprint, { buildMode });
    if (!verifiedOutput) throw new Error(`[workspace-build] published output verification failed for ${packageJson.name ?? packageDir}`);
    await writeJsonAtomic(join(distDir, BUILD_INPUT_RECORD), verifiedOutput.record);
  } catch (error) {
    // Keep the phase's existing trailing pass before admitting retained bytes.
    // Drift can also reject an output-only refresh; neither case certifies the
    // moving staged output, and both use the same last-green integrity checks.
    // Finite preparation may retain coherent output after exhausted drift too.
    // Reuse capture admission; release/artifact publication still requires a
    // fresh successful build, and strict compiler errors never admit fallback.
    const canRetainDrift = publicationMode === 'live'
      && resolveWorkspaceBuildMode({ buildMode: 'source-dev', env }) !== 'strict'
      && (buildMode !== 'strict' || env.HAPPIER_WORKSPACE_CAPTURE_INPUTS === '1');
    const diagnosticSummary = error instanceof BuildInputDriftError && trailingPass && canRetainDrift
      ? error.message
      : buildMode !== 'strict' && !refreshOnly ? compilerDiagnosticSummary(error) : null;
    if (!diagnosticSummary || !isWorkspacePackageOutputValid(packageDir, { monorepoRoot, dependencyDirs })) throw error;
    const recordPath = join(distDir, BUILD_INPUT_RECORD);
    const record = await readJson(recordPath);
    const lastGreen = await inspectWorkspacePackageOutput(packageDir, packageJson, {
      env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' },
      inputFingerprint: record.fingerprint, builtDependencies, allowQaFailure: true,
    });
    if (!lastGreen.complete || !Array.isArray(record.files) || record.files.some((path) => !existsSync(join(distDir, path)))) throw error;
    await writeJsonAtomic(recordPath, { ...record, qaFailure: {
      diagnosticSummary,
      lastGreenBuiltAt: record.builtAt ?? record.qaFailure?.lastGreenBuiltAt ?? statSync(recordPath).mtime.toISOString(),
    } });
    const stalePackage = readQaStalePackage(packageDir, packageJson.name, { monorepoRoot, dependencyDirs });
    if (!stalePackage) throw error;
    await onPackageBuildDone?.({ packageDir, packageName: packageJson.name, stalePackage });
    process.stderr.write(`[workspace-build] QA last-green fallback: ${packageJson.name}; output=${stalePackage.outputIdentity}; builtAt=${stalePackage.lastGreenBuiltAt}; dist=${distDir}\n${diagnosticSummary}\n`);
    return { built: false, reason: 'qa-last-green', stalePackage };
  } finally {
    await capture?.cleanup();
  }
  if (!refreshOnly) await onPackageBuildDone?.({
    packageDir,
    packageName: String(packageJson?.name ?? '').trim(),
  });


  return { built: !refreshOnly, refreshed: refreshOnly, reason: refreshOnly ? 'runtime-outputs-refreshed' : 'rebuilt',
    invalidation: force ? 'forced' : state.invalidation };
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
  trailingPass,
  dependencyDirs,
  signal,
  inheritedAdmission,
}) {
  signal?.throwIfAborted();
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return { built: false, reason: 'missing-package-json' };

  const packageJson = await readJson(packageJsonPath);
  const inputFingerprint = readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs, env: envIn });
  const initial = await inspectWorkspacePackageOutput(packageDir, packageJson, {
    env: envIn,
    inputFingerprint,
    builtDependencies: readWorkspaceBuiltDependencies({ monorepoRoot, dependencyDirs }),
    publicationMode,
  });
  if (initial.expectedTargets.length === 0) return { built: false, reason: 'no-expected-files' };
  if (!force && initial.complete && !initial.verifiedOutput.verificationNeeded) return { built: false, reason: 'already-built' };

  const env = await workspaceBuildBoundary.prepareEnv(packageDir, envIn);
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  const workspaceBundleLockPath = buildEntersWorkspaceBundleLock(packageJson, { monorepoRoot, packageDir })
    ? resolveWorkspaceBundleLockPath(monorepoRoot)
    : null;
  if (inheritedAdmission) assertInheritedWorkspaceBuildResources({
    locks: [...(workspaceBundleLockPath ? [{ path: workspaceBundleLockPath }] : []), { path: lockPath }],
    dependencyInstallDir: monorepoRoot, env,
  });
  // Real process adapters run the complete publication transaction beneath
  // the joint admission owner. Injected compiler boundaries remain in-process
  // so tests can exercise this same deterministic publisher without mocking it.
  if (workspaceBuildBoundary.workerModule) {
    const { resolveWorkspacePackageBuildAdmissionClass } = await import('../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs');
    const resultDir = await mkdtemp(join(tmpdir(), 'happier-workspace-build-result-'));
    const resultPath = join(resultDir, 'result.json');
    const request = { monorepoRoot, packageDir, packageJsonPath, quiet, force, timeoutMs,
      publicationMode, buildMode, trailingPass, dependencyDirs, resultPath,
      boundaryModule: workspaceBuildBoundary.workerModule,
      boundaryExport: workspaceBuildBoundary.workerExport,
      locks: [...(workspaceBundleLockPath ? [workspaceBundleLockPath] : []), lockPath] };
    // The admission adapter already transports stdout incrementally. Keep
    // compiler output visible, while serializing callbacks before returning
    // the worker's terminal result (including failure with an active package).
    const decoder = new StringDecoder('utf8');
    let buffered = '', callbackError, callbacks = Promise.resolve();
    const consumeLine = line => {
      if (!line.startsWith(WORKSPACE_BUILD_EVENT_PREFIX)) {
        process.stdout.write(line);
        return;
      }
      callbacks = callbacks.then(async () => {
        const event = JSON.parse(line.slice(WORKSPACE_BUILD_EVENT_PREFIX.length));
        if (event.kind !== 'start' && event.kind !== 'done') throw new Error('Invalid workspace build progress event');
        await (event.kind === 'start' ? onPackageBuildStart : onPackageBuildDone)?.(event.value);
      }).catch(error => { callbackError ??= error; });
    };
    const consumeStdout = chunk => {
      buffered += decoder.write(chunk);
      for (let index; (index = buffered.indexOf('\n')) !== -1;) {
        consumeLine(buffered.slice(0, index + 1));
        buffered = buffered.slice(index + 1);
      }
    };
    try {
      const terminal = await runWorkspaceBuildAdmission({
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), '--workspace-package-worker', JSON.stringify(request)],
        locks: request.locks.map(path => ({ path })),
        ...(workspaceBuildBoundary.workerLauncherPath ? { launcherPath: workspaceBuildBoundary.workerLauncherPath } : {}),
        cwd: packageDir,
        env,
        signal,
        dependencyInstallDir: monorepoRoot,
        admissionRequired: requiresTypeScriptAdmission({ env }),
        admissionClass: await resolveWorkspacePackageBuildAdmissionClass({ packageJson, cwd: packageDir, env, repoRoot: monorepoRoot }),
        inheritedAdmission,
        stdio: ['inherit', 'pipe', 'inherit'],
        onStdout: consumeStdout,
      });
      buffered += decoder.end();
      if (buffered) consumeLine(buffered);
      await callbacks;
      if (callbackError) throw callbackError;
      if (!existsSync(resultPath)) {
        if (terminal.error) throw terminal.error;
        const error = new Error(`[workspace-build] preparation worker failed for ${packageJson.name ?? packageDir}`);
        error.code = 'EEXIT';
        error.exitCode = terminal.status;
        error.signal = terminal.signal;
        throw error;
      }
      const response = JSON.parse(await readFile(resultPath, 'utf8'));
      if (response.error) throw deserializeWorkspaceBuildError(response.error);
      if (terminal.error || terminal.status !== 0 || terminal.signal) {
        throw terminal.error ?? new Error(`[workspace-build] preparation worker did not complete for ${packageJson.name ?? packageDir}`);
      }
      return response.result;
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }
  // The in-process compiler boundary uses the same joint resource owner.
  // Never retain dependency/global publication custody while awaiting a
  // package publisher. The under-lock inspection already resolves completed
  // concurrent builds, so a second waiter-specific currentness probe is redundant.
  const resources = {
    locks: [...(workspaceBundleLockPath ? [{ path: workspaceBundleLockPath }] : []), { path: lockPath }],
    dependencyInstallDir: monorepoRoot, env, signal,
  };
  const publish = (env, { waited }) => ensureWorkspacePackageBuiltUnderLock({
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
    heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    workspaceBuildBoundary,
    publicationMode,
    buildMode,
    trailingPass,
    dependencyDirs,
  });
  if (inheritedAdmission) {
    return await publish(env, { waited: false });
  }
  return await withWorkspaceBuildResources(resources, publish);
}

async function ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, options) {
  const built = [];
  const refreshed = [];
  const pluginFailures = [];
  const stalePackages = new Map();
  return await withSingleTrailingBuildPass({
    run: async (trailing) => await ensureWorkspacePackageNamesBuiltPass(monorepoRoot, packageNames, {
      ...options,
      trailingPass: trailing,
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
  onPackageBuildResult,
  visitedNames = [],
  includeDevDependencies,
  workspaceGraph: workspaceGraphIn = null,
  workspaceBuildBoundary,
  publicationMode,
  buildMode,
  trailingPass,
  maxConcurrentBuilds,
  inheritedAdmission,
  isolatePluginFailures = false,
  built,
  refreshed,
  pluginFailures,
  stalePackages,
  signal,
}) {
  signal?.throwIfAborted();
  const visited = new Set(visitedNames);
  const forced = new Set(forcePackageNames);
  const changedClosures = new Set();
  const closureBuildPromises = new Map();
  // Scheduling shares one graph observation. Admission and publication still
  // read current inputs independently, and drift starts a fresh graph pass.
  const { packageDirsByName, packageJsonByDir } = !trailingPass && workspaceGraphIn
    ? workspaceGraphIn : await readWorkspacePackageGraph(monorepoRoot);
  const workspacePackageNames = new Set(packageDirsByName.keys());
  const admittedWorkspacePackageNames = await collectWorkspaceDependencyClosure(
    packageNames ?? [], packageDirsByName, { includeDevDependencies, packageJsonByDir },
  );
  const scheduleConcurrentPackageBuild = createAsyncConcurrencyLimiter(inheritedAdmission ? 1 : maxConcurrentBuilds);
  const scheduleBundledWorkspacePackageBuild = createAsyncConcurrencyLimiter(1);
  const schedulePackageBuild = (packageJson, packageDir, operation) => (
    buildEntersWorkspaceBundleLock(packageJson, { monorepoRoot, packageDir })
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
      if (JSON.stringify(packageJson) !== JSON.stringify(packageJsonByDir.get(resolvedPackageDir))) {
        throw new BuildInputDriftError(`[workspace-build] package graph changed: ${resolvedPackageDir}`);
      }
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
      const queuedAt = performance.now();
      let startedAt = queuedAt;
      try {
        result = await schedulePackageBuild(packageJson, resolvedPackageDir, async () => {
          signal?.throwIfAborted();
          startedAt = performance.now();
          return await ensureWorkspacePackageBuilt(resolvedPackageDir, {
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
            trailingPass,
            dependencyDirs,
            signal,
            inheritedAdmission,
          });
        });
      } catch (error) {
        await onPackageBuildResult?.({ packageDir: resolvedPackageDir, packageName, reason: 'failed',
          elapsedMs: performance.now() - startedAt, queueWaitMs: startedAt - queuedAt });
        if (signal?.aborted || error instanceof BuildInputDriftError) throw error;
        if (!isolatePluginFailures || publicationMode === 'artifact' || !packageName.startsWith('@happier-dev/plugins-')) throw error;
        pluginFailures.push(createBundledPluginPublicationFailure({
          repoRoot: monorepoRoot, packageName, error,
        }));
        return false;
      }
      await onPackageBuildResult?.({ packageDir: resolvedPackageDir, packageName, ...result,
        elapsedMs: performance.now() - startedAt, queueWaitMs: startedAt - queuedAt });
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
  onPackageBuildResult = null,
  includeDevDependencies = true,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
  publicationMode = 'live',
  maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS,
  isolatePluginFailures = false,
  buildMode,
  signal,
  inheritedAdmission = false,
  visitedNames = [],
} = {}) {
  signal?.throwIfAborted();
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
    onPackageBuildResult,
    includeDevDependencies,
    workspaceBuildBoundary,
    publicationMode: resolvedPublicationMode,
    buildMode: resolvedBuildMode,
    maxConcurrentBuilds,
    isolatePluginFailures,
    signal,
    inheritedAdmission,
    visitedNames,
  });
  return { ok: true, ...result, skipped: [] };
}

async function runWorkspacePackageWorker(rawRequest) {
  const request = JSON.parse(rawRequest);
  const leases = JSON.parse(process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]');
  const values = [process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, ...leases];
  if (!Array.isArray(request.locks) || request.locks.some(path =>
    !values.some(value => callerHoldsWorkspaceBundleLock(path, value)))) {
    throw new Error('Workspace package worker requires its exact inherited publication leases');
  }
  const workspaceBuildBoundary = (await import(request.boundaryModule))[request.boundaryExport];
  const reportProgress = (kind, value) => new Promise((resolveWritten, rejectWritten) => {
    process.stdout.write(`${WORKSPACE_BUILD_EVENT_PREFIX}${JSON.stringify({ kind, value })}\n`, error => {
      if (error) rejectWritten(error); else resolveWritten();
    });
  });
  let response;
  try {
    response = { result: await ensureWorkspacePackageBuiltUnderLock({ ...request,
      env: process.env, workspaceBuildBoundary, waited: true,
      heldLockValue: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      onPackageBuildStart: value => reportProgress('start', value),
      onPackageBuildDone: value => reportProgress('done', value),
    }) };
  } catch (error) {
    response = { error: serializeWorkspaceBuildError(error) };
    process.exitCode = 1;
  }
  await writeFile(request.resultPath, JSON.stringify(response));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  && process.argv[2] === '--workspace-package-worker') {
  runWorkspacePackageWorker(process.argv[3]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, {
  quiet = false,
  env = process.env,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
  publicationMode = 'live',
  maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_WORKSPACE_BUILDS,
  isolatePluginFailures = false,
  buildMode,
  signal,
  startup = false,
  refresh,
  logger = console,
  onPackageBuildResult = null,
  deferBundledWorkspaceSync = false,
  inheritedAdmission = false,
} = {}) {
  signal?.throwIfAborted();
  if (startup && resolveWorkspaceBuildMode({ buildMode, env }) !== 'strict' && publicationMode === 'live') {
    const prepare = () => ensureWorkspacePackagesBuiltForComponent(componentDir, {
      quiet, env, workspaceBuildBoundary, publicationMode, maxConcurrentBuilds,
      isolatePluginFailures, buildMode, signal,
      onPackageBuildResult, deferBundledWorkspaceSync,
      inheritedAdmission,
    });
    return await prepareWorkspaceComponentStartup({
      readLastGreen: async () => await hasUsableWorkspaceLastGreen(componentDir)
        ? { ok: true, built: [], skipped: [], lastGreen: true } : null,
      prepare,
      refresh: refresh === undefined ? prepare : refresh,
      signal,
      logger,
    });
  }
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const componentPackageJsonPath = join(componentDir, 'package.json');
  if (!existsSync(componentPackageJsonPath)) {
    return { ok: true, built: [], skipped: ['missing-component-package-json'] };
  }

  const workspaceGraph = await readWorkspaceComponentDependencyGraph(componentDir, { monorepoRoot });
  const { componentPackageJson, packageNames } = workspaceGraph;
  const componentName = typeof componentPackageJson?.name === 'string'
    ? componentPackageJson.name
    : '';
  const resolvedPublicationMode = resolveWorkspaceBundlePublicationMode({ mode: publicationMode });
  const resolvedBuildMode = resolveWorkspaceBuildMode({ buildMode, env });
  const result = await ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
    quiet,
    env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolvedBuildMode },
    visitedNames: [componentName].filter(Boolean),
    includeDevDependencies: true,
    workspaceGraph,
    workspaceBuildBoundary,
    publicationMode: resolvedPublicationMode,
    buildMode: resolvedBuildMode,
    maxConcurrentBuilds,
    isolatePluginFailures,
    signal,
    onPackageBuildResult,
    inheritedAdmission,
  });
  if (!deferBundledWorkspaceSync) {
    await syncWorkspaceComponentBundledDependencies(componentDir, {
      env, publicationMode: resolvedPublicationMode, pluginFailures: result.pluginFailures, signal,
    });
  }
  return { ok: true, ...result, skipped: [] };
}

export async function syncWorkspaceComponentBundledDependencies(componentDir, {
  env = process.env,
  publicationMode = 'live',
  pluginFailures = [],
  signal,
} = {}) {
  signal?.throwIfAborted();
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const componentPackageJsonPath = join(componentDir, 'package.json');
  if (!monorepoRoot || !existsSync(componentPackageJsonPath)) return;
  const componentPackageJson = await readJson(componentPackageJsonPath);
  const resolvedPublicationMode = resolveWorkspaceBundlePublicationMode({ mode: publicationMode });
  if (hasBundledWorkspaceDependencies(componentPackageJson)) {
    await withWorkspaceBundleLock(
      async () => {
        syncBundledWorkspacePackages({
          repoRoot: monorepoRoot,
          hostPackageDirs: [componentDir],
          packages: collectBundledWorkspaceDependencyNames(componentPackageJson)
            .filter((packageName) => !pluginFailures.some((failure) => failure.packageName === packageName))
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
        signal,
      },
    );
  }
}
