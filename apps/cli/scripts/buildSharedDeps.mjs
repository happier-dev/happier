import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUILD_INPUT_RECORD,
  collectWorkspacePackageFingerprintDependencyNames,
  ensureWorkspacePackagesBuiltByName,
  inspectWorkspaceQaStalePackages,
  isWorkspacePackageOutputCurrent,
  isWorkspacePackageOutputValid,
  readWorkspaceBuildFileDigest,
  readWorkspacePackageInputFingerprint,
} from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import {
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetPath,
  resolvePackageBuildOutputTargetMatches,
} from '../../../scripts/workspaces/packageBuildOutputTargets.mjs';
import {
  loadCliCommonWorkspacesModule,
} from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import {
  resolveSourceDevSharedDepsStampPath,
} from '../../../scripts/workspaces/sourceDevReadiness.mjs';
import {
  syncBundledWorkspacePackages,
  vendorBundledPackageRuntimeDependenciesFallback,
} from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import {
  assertResolvedRuntimeDependencyMatchesDeclaration,
  copyDirDereferenceContainedSync,
  resolveInstalledRuntimePackage,
} from '../../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import * as workspaceDependencyBuildOrder from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import { createWorkspaceChildBuildEnv, WORKSPACE_BUILD_MODE_ENV, resolveWorkspaceBuildMode } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  WORKSPACE_BUNDLE_PUBLICATION_MODES,
  resolveWorkspaceBundlePublicationMode,
} from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import { hasMissingLocalImportsSync } from '../../../scripts/workspaces/distLocalImports.mjs';
import {
  createBundledPluginPublicationFailure,
  readBundledPluginPublicationFailures,
  writeBundledPluginPublicationFailures,
} from '../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import {
  assertBundledPluginPackageCorrespondence,
} from './build-owned/bundledPluginPackageCorrespondence.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BUNDLED_HOST_APPS = ['cli'];
const PLUGINS_WORKSPACE_PREFIX = 'plugins-';
// v8 keeps content identities, not copies of output bodies, across scope stamps.
// Older readiness caches are reconstructible from the canonical package trees.
const SOURCE_DEV_SHARED_DEPS_STAMP_VERSION = 8;
const SOURCE_DEV_SHARED_DEPS_STAMP_HEADER = new RegExp(
  `^\\s*\\{\\s*"version"\\s*:\\s*${SOURCE_DEV_SHARED_DEPS_STAMP_VERSION}\\s*[,}]`, 'u',
);
const SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_PROGRESS';
const SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACES';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE = 'json-v1';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX = '[happier-source-dev-shared-deps-progress] ';
const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH = 'dist/happier-plugin-ui/ui-artifacts.json';
const BUNDLED_PLUGIN_MANIFEST_ARTIFACT_RELATIVE_PATH = '.happier-plugin/plugin.json';
const BUNDLED_PLUGIN_GENERATOR_RELATIVE_PATH = 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts';
const CHILD_FAILURE_DIAGNOSTIC_MAX_BYTES = 8_000;
const SECRET_ENV_KEY_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

function trimUtf8HeadToMaxBytes(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let head = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    head += character;
    bytes += characterBytes;
  }
  return head;
}

function appendChildFailureDiagnostic(current, chunk, maxBytes) {
  const next = `${current}${String(chunk)}`;
  return trimUtf8HeadToMaxBytes(next, maxBytes);
}

function resolveChildFailureDiagnosticCaptureMaxBytes(env) {
  const maximumSecretBytes = Object.entries(env ?? {})
    .filter(([key, value]) => SECRET_ENV_KEY_PATTERN.test(key) && String(value ?? '').length >= 4)
    .reduce((maximum, [, value]) => Math.max(maximum, Buffer.byteLength(String(value), 'utf8')), 0);
  // Retain exactly enough lookahead for an exact secret beginning at the
  // diagnostic boundary to be fully redacted before the public head bound.
  return CHILD_FAILURE_DIAGNOSTIC_MAX_BYTES + maximumSecretBytes;
}

function formatChildFailureDiagnostic(stderr, env, truncated) {
  let redacted = String(stderr ?? '');
  const secretValues = Object.entries(env ?? {})
    .filter(([key, value]) => SECRET_ENV_KEY_PATTERN.test(key) && String(value ?? '').length >= 4)
    .map(([, value]) => String(value))
    .sort((left, right) => right.length - left.length);
  for (const value of secretValues) {
    redacted = redacted.replaceAll(value, '<redacted>');
  }
  redacted = redacted.trim();
  if (!redacted) return '';
  const bounded = trimUtf8HeadToMaxBytes(redacted, CHILD_FAILURE_DIAGNOSTIC_MAX_BYTES);
  const didTruncate = truncated || bounded !== redacted;
  return `\n\nChild stderr${didTruncate ? ' (head; later output omitted)' : ''}:\n${bounded}`;
}

function resolveRepoRootOption(repoRootArg) {
  return typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
}

function readPositiveIntegerEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSourceDevSharedDepsLockOptions(lockOptions = {}) {
  const lockTimeoutMs = readPositiveIntegerEnv(SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV);
  return {
    ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs, staleAfterMs: lockTimeoutMs } : {}),
    ...lockOptions,
  };
}

function resolvePositiveIntegerOption(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSourceDevWorkspaceBuildTimeoutMs(value) {
  return resolvePositiveIntegerOption(value) ?? readPositiveIntegerEnv(SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV);
}

function createSourceDevSharedDepsProgressReporter(opts = {}) {
  const directReporter = typeof opts.reportProgress === 'function' ? opts.reportProgress : null;
  const emitToStderr = process.env[SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV] === SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE;
  if (!directReporter && !emitToStderr) return null;

  const startedAtMs = Date.now();
  return (event) => {
    const payload = {
      ...event,
      elapsedMs: Date.now() - startedAtMs,
    };
    if (directReporter) {
      directReporter(payload);
    }
    if (emitToStderr) {
      process.stderr.write(`${SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX}${JSON.stringify(payload)}\n`);
    }
  };
}

function reportSourceDevSharedDepsProgress(reportProgress, event) {
  reportProgress?.(event);
}

export async function withBuildSharedDepsLock(fn, options = {}) {
  const lockPath = options.lockPath ?? DEFAULT_BUILD_LOCK_PATH;
  return await withOptionalCliSharedDepsBuildLock(fn, {
    ...options,
    repoRoot: options.repoRoot ?? repoRoot,
    lockPath,
  });
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback for older layouts (repoRoot/apps/cli/scripts).
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);
const DEFAULT_BUILD_LOCK_PATH = resolveCliSharedDepsBuildLockPath(repoRoot);

export async function resolveCliCommonWorkspacesHelpersAfterBuild(options = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(options.repoRoot);
  const env = options.env ?? process.env;
  const loadedModule = await loadCliCommonWorkspacesModule(
    resolvedRepoRoot,
    env,
    options.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName,
    {
      includeDevDependencies: false,
      quiet: options.quiet === true,
    },
  );
  return loadedModule?.helpers ?? loadedModule;
}

/**
 * Spawns the canonical bundled-plugin generator. `workspaceNames` are bundled
 * plugin workspace names forwarded verbatim as the generator's plugin-only
 * `--workspace` selectors; omit them to publish the complete bundled set.
 * Callers holding a mixed CLI bundled workspace selection must route through
 * `publishBundledPluginArtifactsAfterWorkspaceBuild`, which selects the plugin
 * subset; the generator rejects non-plugin selectors.
 */
export async function runCanonicalBundledPluginArtifactPublisher({
  repoRoot,
  workspaceNames = [],
  env = process.env,
  quiet = false,
  progress = false,
  mode = String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1' ? 'check' : 'write',
  aggregateOnly = false,
  compilerInputsOnly = false,
  targetOwnedOnly = false,
  pluginFailures = [],
  publicationMode = 'live',
}) {
  const generatorPath = resolve(repoRoot, BUNDLED_PLUGIN_GENERATOR_RELATIVE_PATH);
  if (!existsSync(generatorPath)) {
    throw new Error(`Canonical bundled plugin artifact publisher is missing: ${generatorPath}`);
  }

  const command = process.execPath;
  const args = [
    resolve(repoRoot, 'apps', 'cli', 'scripts', 'withNodeHeapLimit.mjs'),
    process.execPath,
    '--experimental-strip-types',
    generatorPath,
    '--root',
    repoRoot,
    '--mode',
    mode,
    ...(pluginFailures.length > 0 ? ['--inherited-failures-stdin'] : []),
    ...(compilerInputsOnly
      ? ['--compiler-inputs']
      : aggregateOnly
        ? ['--aggregate']
        : [
            ...workspaceNames.flatMap((workspaceName) => ['--workspace', workspaceName]),
            ...(targetOwnedOnly ? ['--target-owned-only'] : []),
          ]),
  ];
  await new Promise((resolvePromise, reject) => {
    let stderr = '';
    let stderrTruncated = false;
    const captureMaxBytes = resolveChildFailureDiagnosticCaptureMaxBytes(env);
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE: publicationMode,
      },
      stdio: pluginFailures.length > 0
        ? ['pipe', quiet ? 'ignore' : 'inherit', quiet ? 'pipe' : 'inherit']
        : quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    });
    if (pluginFailures.length > 0) child.stdin.end(JSON.stringify(pluginFailures));
    child.stderr?.on('data', (chunk) => {
      if (progress) process.stderr.write(chunk);
      stderrTruncated ||= Buffer.byteLength(`${stderr}${String(chunk)}`, 'utf8') > captureMaxBytes;
      stderr = appendChildFailureDiagnostic(stderr, chunk, captureMaxBytes);
    });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === 0 && signal === null) {
        resolvePromise();
        return;
      }

      const diagnostic = formatChildFailureDiagnostic(stderr, env, stderrTruncated);
      const error = new Error(
        `Command failed: ${command} ${args.join(' ')} `
        + `(code=${status ?? 'null'}, sig=${signal ?? 'null'})${diagnostic}`,
      );
      error.status = status;
      error.signal = signal;
      error.output = [null, null, null];
      error.pid = child.pid;
      error.stdout = null;
      error.stderr = null;
      reject(error);
    });
  });
  return true;
}

/**
 * The single pre-build choke point for the manifest-derived generated
 * TypeScript *compiler inputs*.
 *
 * `packages/agents/src/generated/agentIds.ts` compiles into
 * `@happier-dev/agents/agent-ids`, which `packages/cli-common` imports for
 * `BUNDLED_AGENT_CONTRIBUTION_IDENTITIES`, and `plugin-sdk` depends on
 * `cli-common`. The canonical bundled-plugin publisher imports that same
 * `cli-common` output, so it cannot be what first publishes those inputs: a
 * newly manifested bundled Agent would need its own generated id to exist
 * before the generator that emits it could run. This runs the one canonical
 * producer in its `--compiler-inputs` mode, which reads only committed plugin
 * manifest artifacts plus the Protocol/Agents runtime, before any workspace in
 * that cycle compiles.
 *
 * There is no second generator, lock owner, or receipt here. The generator's
 * `--compiler-inputs` branch serializes its bounded read/compare/write under
 * the canonical publication lock and reuses an inherited owner lease when this
 * choke point is called from an already-running workspace publication.
 */
export async function runCanonicalGeneratedCompilerInputs({
  repoRoot,
  env = process.env,
  quiet = false,
  mode = String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1' ? 'check' : 'write',
} = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(repoRoot);
  if (!existsSync(resolve(resolvedRepoRoot, BUNDLED_PLUGIN_GENERATOR_RELATIVE_PATH))) return false;
  await runCanonicalBundledPluginArtifactPublisher({
    repoRoot: resolvedRepoRoot,
    env,
    quiet,
    mode,
    compilerInputsOnly: true,
  });
  return true;
}

function resolveSelectedBundledPluginWorkspaceNames({ repoRoot, workspaceNames }) {
  const bundledPluginWorkspaceNames = new Set(resolveCliBundledWorkspacePackageNames({
    repoRoot: resolveRepoRootOption(repoRoot),
  }).filter((workspaceName) => workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX)));
  return normalizeSourceDevSharedDepsWorkspaceNames(workspaceNames).filter(
    (workspaceName) => bundledPluginWorkspaceNames.has(workspaceName),
  );
}

function collectInstalledBundledPluginWorkspaceNamesDivergingFromSource({
  repoRoot,
  workspaceNames,
}) {
  const selectedWorkspaceNames = resolveSelectedBundledPluginWorkspaceNames({ repoRoot, workspaceNames });
  if (selectedWorkspaceNames.length === 0) return [];
  const admission = createBundledPluginPreparedPackageValidator({ repoRoot });

  const cliPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'package.json');
  return selectedWorkspaceNames.filter((workspaceName) => {
    const packageName = `@happier-dev/${workspaceName}`;
    try {
      const packageDir = resolveInstalledRuntimePackage({
        packageName,
        resolveFromPackageJsonPath: cliPackageJsonPath,
        dereferenceRootDir: repoRoot,
      }).packageDir;
      return !admission.isPackageCurrent({ packageName, packageDir });
    } catch {
      return true;
    }
  });
}

async function ensureWorkspacePackagesBuiltWithPluginIsolation({
  repoRoot,
  workspaceNames,
  ensureWorkspacePackagesBuiltByNameImpl,
  buildOptions,
  onBatchFailure,
  // Live/dev preparation isolates a failing plugin so the rest of the closure keeps
  // refreshing. A publication build has no such freedom: the artifact it feeds copies
  // generator-owned plugin trees verbatim, so an unbuilt plugin would ship its previous
  // generation's bytes.
  isolatePluginBuildFailures = true,
  maxConcurrentPluginBuilds = 2,
}) {
  const normalizedWorkspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(workspaceNames);
  const builtWorkspaceNames = [];
  const failedPluginBuilds = [];

  const runBatch = async (batchWorkspaceNames) => {
    try {
      const result = await ensureWorkspacePackagesBuiltByNameImpl(
        repoRoot,
        batchWorkspaceNames.map((workspaceName) => `@happier-dev/${workspaceName}`),
        {
          ...buildOptions,
          isolatePluginFailures: isolatePluginBuildFailures,
          maxConcurrentBuilds: maxConcurrentPluginBuilds,
        },
      );
      builtWorkspaceNames.push(
        ...normalizeSourceDevSharedDepsWorkspaceNames(result?.built),
        ...normalizeSourceDevSharedDepsWorkspaceNames(result?.refreshed),
      );
      failedPluginBuilds.push(...(result?.pluginFailures ?? []));
      return null;
    } catch (error) {
      await onBatchFailure?.({ workspaceNames: batchWorkspaceNames, error });
      return error;
    }
  };

  // One package graph owns dependency admission, concurrency and optional
  // failures. Per-plugin graphs rechecked the same SDK closure for every
  // plugin and misclassified shared dependency failures as optional failures.
  const error = normalizedWorkspaceNames.length > 0 ? await runBatch(normalizedWorkspaceNames) : null;
  if (error) throw error;

  const builtWorkspaceNameSet = new Set(normalizeSourceDevSharedDepsWorkspaceNames(builtWorkspaceNames));
  return {
    builtWorkspaceNames: normalizedWorkspaceNames.filter((workspaceName) => (
      builtWorkspaceNameSet.has(workspaceName)
    )),
    failedPluginBuilds,
  };
}

/**
 * Canonical select-then-publish operation for bundled-plugin artifacts given a
 * CLI bundled workspace selection. `workspaceNames` (or an already-rebuilt
 * `pluginWorkspaceNames` selection) may name any CLI bundled workspace; the
 * selection owner intersects it with this checkout's bundled plugin
 * workspaces, so host names such as `protocol` or `agents` never reach the
 * plugin-only generator CLI. Returns false — without invoking the publisher —
 * when the selection contains no bundled plugin workspace; throws when the
 * publisher does not complete for a non-empty selection.
 */
export async function publishBundledPluginArtifactsAfterWorkspaceBuild(opts = {}) {
  const pluginFailures = opts.pluginFailures ?? [];
  // A failed package was evaluated too. Keep it in the selector scope even
  // though the generator excludes its executable artifacts via pluginFailures.
  const pluginWorkspaceNames = resolveSelectedBundledPluginWorkspaceNames({
    repoRoot: opts.repoRoot,
    workspaceNames: [
      ...(opts.pluginWorkspaceNames ?? opts.workspaceNames ?? []),
      ...pluginFailures.map((failure) => failure.packageName.replace(/^@happier-dev\//, '')),
    ],
  });
  if (pluginWorkspaceNames.length === 0 && pluginFailures.length === 0) return false;

  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const publish = opts.publishBundledPluginArtifactsImpl ?? runCanonicalBundledPluginArtifactPublisher;
  const published = await publish({
    repoRoot,
    workspaceNames: pluginWorkspaceNames,
    pluginFailures,
    publicationMode: opts.publicationMode ?? 'live',
    env: opts.env ?? process.env,
    quiet: opts.quiet === true,
    progress: opts.progress === true,
    mode: opts.bundledPluginArtifactPublication?.mode
      ?? (String(opts.env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1'
        ? 'check'
        : 'write'),
    aggregateOnly: pluginWorkspaceNames.length === 0
      || opts.bundledPluginArtifactPublication?.aggregateOnly === true,
    targetOwnedOnly: opts.bundledPluginArtifactPublication?.targetOwnedOnly === true,
  });
  if (published === false) {
    throw new Error('Canonical bundled plugin artifact publisher did not complete');
  }
  return true;
}

export async function rebuildWorkspacesInvalidatedByBundledPluginPublication(opts = {}) {
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(opts.workspaceNames);
  const staleBuilds = collectStaleSourceDevWorkspaceBuilds({
    repoRoot: resolveRepoRootOption(opts.repoRoot),
    workspaceNames,
    includeUiArtifacts: opts.includeUiArtifacts !== false,
  });
  if (staleBuilds.length === 0) return [];

  // Generated Protocol/Agents source can affect every later host workspace in
  // the dependency order. Rebuild that bounded host closure, but never run the
  // ordinary workspace compiler over plugin runtimes after their canonical
  // staged artifacts have been published.
  const workspacesToRebuild = workspaceNames.filter(
    (workspaceName) => !workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX),
  );
  if (workspacesToRebuild.length === 0) return [];

  const ensureWorkspacePackagesBuilt =
    opts.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName;
  const resolvedRepoRoot = resolveRepoRootOption(opts.repoRoot);
  const buildResult = await ensureWorkspacePackagesBuilt(
    resolvedRepoRoot,
    workspacesToRebuild.map((workspaceName) => `@happier-dev/${workspaceName}`),
    {
      quiet: opts.quiet === true,
      env: opts.env ?? process.env,
      // Re-check under each package lock so a concurrent canonical publisher can satisfy this
      // generated-source repair without a duplicate compilation.
      force: false,
      includeDevDependencies: opts.includeDevDependencies === true,
      timeoutMs: opts.timeoutMs,
    },
  );
  return normalizeSourceDevSharedDepsWorkspaceNames([...(buildResult?.built ?? []), ...(buildResult?.refreshed ?? [])]);
}

export function resolveBundledWorkspacePackageDir({ repoRoot, workspaceName }) {
  const name = String(workspaceName ?? '').trim();
  if (!name) return '';

  if (name.startsWith(PLUGINS_WORKSPACE_PREFIX)) {
    const pluginId = name.slice(PLUGINS_WORKSPACE_PREFIX.length);
    if (pluginId) {
      return resolve(repoRoot, 'packages', 'plugins', pluginId);
    }
  }

  return resolve(repoRoot, 'packages', name);
}

export function resolveBundledWorkspaceTsconfigPath({ repoRoot, workspaceName }) {
  const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
  if (!packageDir) return '';
  return resolve(packageDir, 'tsconfig.json');
}

export function resolveCliBundledWorkspacePackageNames({ repoRoot: repoRootArg, exists = existsSync } = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(repoRootArg);
  return workspaceDependencyBuildOrder.resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot: resolvedRepoRoot,
    hostPackageDir: resolve(resolvedRepoRoot, 'apps', 'cli'),
    existsSync: exists,
  }).filter((name) => exists(resolveBundledWorkspaceTsconfigPath({ repoRoot: resolvedRepoRoot, workspaceName: name })));
}

function readJsonFile(path, readFile = readFileSync) {
  return JSON.parse(readFile(path, 'utf8'));
}

function collectInternalRuntimeWorkspaceDepNames(rawPackageJson) {
  const out = [];
  for (const deps of [rawPackageJson?.dependencies, rawPackageJson?.optionalDependencies]) {
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) {
      if (typeof name === 'string' && name.startsWith('@happier-dev/')) {
        out.push(name);
      }
    }
  }
  return out;
}

function readBundledWorkspacePackageNames(rawPackageJson) {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies.filter((value) => typeof value === 'string' && value.startsWith('@happier-dev/'));
}

function resolveWorkspaceSourceDirFallback({ repoRoot, packageName }) {
  const name = String(packageName ?? '').trim();
  const workspaceName = name.split('/').pop();
  if (!workspaceName) {
    throw new Error(`Unable to resolve workspace name from bundled dependency: ${name}`);
  }

  if (workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX)) {
    const pluginId = workspaceName.slice(PLUGINS_WORKSPACE_PREFIX.length);
    if (pluginId) return resolve(repoRoot, 'packages', 'plugins', pluginId);
  }

  return resolve(repoRoot, 'packages', workspaceName);
}

function resolveInternalWorkspacePackageNameClosureFallback({ repoRoot, packageNames, exists = existsSync, readFile = readFileSync }) {
  const visited = new Set();

  const visit = (packageName) => {
    const normalizedName = String(packageName ?? '').trim();
    if (!normalizedName.startsWith('@happier-dev/') || visited.has(normalizedName)) return;
    visited.add(normalizedName);

    const sourcePackageJsonPath = resolve(resolveWorkspaceSourceDirFallback({ repoRoot, packageName: normalizedName }), 'package.json');
    if (!exists(sourcePackageJsonPath)) return;

    const sourcePackageJson = readJsonFile(sourcePackageJsonPath, readFile);
    for (const dependencyName of collectInternalRuntimeWorkspaceDepNames(sourcePackageJson)) {
      visit(dependencyName);
    }
  };

  for (const packageName of packageNames) {
    visit(packageName);
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

function resolveWorkspaceBundlesFromPackageJsonFallback({ repoRoot, hostPackageDir, exists = existsSync, readFile = readFileSync }) {
  const hostPackageJsonPath = resolve(hostPackageDir, 'package.json');
  if (!exists(hostPackageJsonPath)) {
    throw new Error(`Missing host package.json: ${hostPackageJsonPath}`);
  }

  const hostPackageJson = readJsonFile(hostPackageJsonPath, readFile);
  const bundledWorkspaceNames = readBundledWorkspacePackageNames(hostPackageJson);
  const bundledWorkspaceNameSet = new Set(bundledWorkspaceNames);
  const bundledWorkspaceClosureNames = resolveInternalWorkspacePackageNameClosureFallback({
    repoRoot,
    packageNames: bundledWorkspaceNames,
    exists,
    readFile,
  });
  const missingClosureNames = bundledWorkspaceClosureNames.filter((packageName) => !bundledWorkspaceNameSet.has(packageName));
  if (missingClosureNames.length > 0) {
    throw new Error(
      [
        `Missing bundled internal workspace dependencies in ${hostPackageJsonPath}:`,
        ...missingClosureNames.map((packageName) => `- ${packageName}`),
      ].join('\n'),
    );
  }

  return bundledWorkspaceClosureNames.map((packageName) => ({
    packageName,
    srcDir: resolveWorkspaceSourceDirFallback({ repoRoot, packageName }),
    destDir: resolve(hostPackageDir, 'node_modules', ...packageName.split('/')),
  }));
}

function bundleInstalledPackageWithRuntimeDependenciesFallback({
  packageName,
  declaredSpec,
  resolveFromPackageJsonPath,
  destNodeModulesDir,
  dereferenceRootDir,
}) {
  const resolved = resolveInstalledRuntimePackage({
    packageName,
    resolveFromPackageJsonPath,
    dereferenceRootDir,
  });
  assertResolvedRuntimeDependencyMatchesDeclaration({
    dependency: {
      name: packageName,
      optional: false,
      declaredSpec: declaredSpec ?? '',
    },
    resolvedPackageJsonPath: resolved.packageJsonPath,
    resolvedPackageJson: resolved.packageJson,
  });
  const sourcePackageDir = realpathSync(resolved.packageDir);
  const sourcePackageJsonPath = realpathSync(resolved.packageJsonPath);
  const destPackageDir = resolve(destNodeModulesDir, ...packageName.split('/'));

  mkdirSync(destNodeModulesDir, { recursive: true });
  rmSync(destPackageDir, { recursive: true, force: true });
  copyDirDereferenceContainedSync({
    sourceDir: sourcePackageDir,
    destDir: destPackageDir,
    dereferenceRootDir: dereferenceRootDir ?? sourcePackageDir,
  });
  vendorBundledPackageRuntimeDependenciesFallback({
    srcPackageJsonPath: sourcePackageJsonPath,
    resolveFromPackageJsonPath: sourcePackageJsonPath,
    destPackageDir,
    dereferenceRootDir,
  });
}

export function syncBundledWorkspaceDist(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(opts.workspaceNames);
  syncBundledWorkspacePackages({
    repoRoot,
    hostApps: Array.isArray(opts.bundledHostApps) && opts.bundledHostApps.length > 0 ? opts.bundledHostApps : CLI_BUNDLED_HOST_APPS,
    ...(workspaceNames.length > 0 ? { packages: workspaceNames } : {}),
    replaceExisting: opts.replaceExisting,
    // This path publishes the current workspace build into CLI node_modules. Reconcile the
    // mounted package exactly once its complete staged tree is available.
    pruneStale: true,
    syncId: opts.syncId,
    staleSwapDirAgeMs: opts.staleSwapDirAgeMs,
    nowMs: opts.nowMs,
    isPidAlive: opts.isPidAlive,
    existsSync: opts.existsSync,
    cpSync: opts.cpSync,
    mkdirSync: opts.mkdirSync,
    rmSync: opts.rmSync,
    readFileSync: opts.readFileSync,
    writeFileSync: opts.writeFileSync,
    validatePreparedPackage: opts.validatePreparedPackage,
    cliCommonWorkspacesModule: opts.cliCommonWorkspacesModule,
  });
}

export function syncCliRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const bundleInstalledPackageWithRuntimeDependencies =
    typeof opts.bundleInstalledPackageWithRuntimeDependencies === 'function'
      ? opts.bundleInstalledPackageWithRuntimeDependencies
      : bundleInstalledPackageWithRuntimeDependenciesFallback;
  const cliPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'package.json');
  const cliNodeModulesDir = resolve(repoRoot, 'apps', 'cli', 'node_modules');
  const cliPackageJson = readJsonFile(cliPackageJsonPath);
  const declaredSpec = cliPackageJson?.dependencies?.tweetnacl
    ?? cliPackageJson?.optionalDependencies?.tweetnacl;
  if (typeof declaredSpec !== 'string' || !declaredSpec.trim()) {
    throw new Error(`Missing CLI runtime dependency declaration for tweetnacl: ${cliPackageJsonPath}`);
  }
  const resolvedTweetnacl = resolveInstalledRuntimePackage({
    packageName: 'tweetnacl',
    resolveFromPackageJsonPath: cliPackageJsonPath,
    dereferenceRootDir: repoRoot,
  });
  assertResolvedRuntimeDependencyMatchesDeclaration({
    dependency: {
      name: 'tweetnacl',
      optional: false,
      declaredSpec: declaredSpec.trim(),
    },
    resolvedPackageJsonPath: resolvedTweetnacl.packageJsonPath,
    resolvedPackageJson: resolvedTweetnacl.packageJson,
  });
  const bundledTweetnaclDir = resolve(cliNodeModulesDir, 'tweetnacl');
  if (
    existsSync(bundledTweetnaclDir)
    && realpathSync(resolvedTweetnacl.packageDir) === realpathSync(bundledTweetnaclDir)
  ) {
    return;
  }

  bundleInstalledPackageWithRuntimeDependencies({
    packageName: 'tweetnacl',
    declaredSpec: declaredSpec.trim(),
    resolveFromPackageJsonPath: cliPackageJsonPath,
    destNodeModulesDir: cliNodeModulesDir,
    dereferenceRootDir: repoRoot,
  });
}

export function syncBundledWorkspaceRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const resolveWorkspaceBundlesFromPackageJson =
    typeof opts.resolveWorkspaceBundlesFromPackageJson === 'function'
      ? opts.resolveWorkspaceBundlesFromPackageJson
      : (params) => resolveWorkspaceBundlesFromPackageJsonFallback({
        ...params,
        exists: opts.existsSync,
        readFile: opts.readFileSync,
      });
  const vendorBundledPackageRuntimeDependencies =
    typeof opts.vendorBundledPackageRuntimeDependencies === 'function'
      ? opts.vendorBundledPackageRuntimeDependencies
      : vendorBundledPackageRuntimeDependenciesFallback;
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
  });
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(opts.workspaceNames);
  const targetPackageNames = workspaceNames.length > 0
    ? new Set(workspaceNames.map((workspaceName) => `@happier-dev/${workspaceName}`))
    : null;

  for (const bundle of targetPackageNames
    ? bundles.filter((candidate) => targetPackageNames.has(candidate.packageName))
    : bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(bundle.srcDir, 'package.json'),
      destPackageDir: bundle.destDir,
      dereferenceRootDir: repoRoot,
    });
  }
}

function normalizeSourceDevSharedDepsWorkspaceName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('@happier-dev/')) {
    return raw.slice('@happier-dev/'.length).trim();
  }
  return raw;
}

function normalizeSourceDevSharedDepsWorkspaceNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const workspaceName = normalizeSourceDevSharedDepsWorkspaceName(value);
    if (!workspaceName || seen.has(workspaceName)) continue;
    seen.add(workspaceName);
    result.push(workspaceName);
  }
  return result;
}

export function readSourceDevSharedDepsWorkspaceNamesFromEnv(env = process.env) {
  const raw = env?.[SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV];
  if (typeof raw !== 'string') return undefined;
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(raw.split(','));
  return workspaceNames.length > 0 ? workspaceNames : undefined;
}

export function readSourceDevSharedDepsWorkspaceNamesFromArgv(argv = process.argv.slice(2)) {
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(
    argv.filter((value) => !String(value).trim().startsWith('--')),
  );
  return workspaceNames.length > 0 ? workspaceNames : undefined;
}

function resolveSourceDevWorkspaceNames({
  repoRoot,
  workspaceNames,
  includeDevDependencies = false,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const targetedWorkspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(workspaceNames);
  if (targetedWorkspaceNames.length > 0) {
    const resolveWorkspaceDependencyBuildOrder =
      typeof workspaceDependencyBuildOrder.resolveWorkspaceDependencyBuildOrder === 'function'
        ? workspaceDependencyBuildOrder.resolveWorkspaceDependencyBuildOrder
        : ({ seedPackageNames }) => normalizeSourceDevSharedDepsWorkspaceNames(seedPackageNames);
    return resolveWorkspaceDependencyBuildOrder({
      repoRoot,
      seedPackageNames: targetedWorkspaceNames,
      includeDevDependencies,
      existsSync: exists,
      readFileSync: readFile,
    });
  }

  return resolveCliBundledWorkspacePackageNames({ repoRoot, exists });
}

function readSmallFileSignature(path, { exists = existsSync, readFile = readFileSync } = {}) {
  if (!exists(path)) return { exists: false };
  try {
    return { exists: true, digest: createHash('sha256').update(readFile(path)).digest('hex') };
  } catch {
    return { exists: false };
  }
}

function readPublishedPackageRootTargetSignature(
  path,
  {
    exists = existsSync,
    readFile = readFileSync,
    readDir = readdirSync,
    stat = statSync,
  } = {},
) {
  if (!exists(path)) return { exists: false };
  try {
    const stats = stat(path);
    if (stats.isDirectory()) {
      return {
        exists: true,
        type: 'dir',
        tree: readRuntimeDistTreeSignature(path, { exists, readDir, stat }),
      };
    }
    if (!stats.isFile()) return { exists: true, type: 'other' };
    return {
      exists: true,
      type: 'file',
      digest: createHash('sha256').update(readFile(path)).digest('hex'),
    };
  } catch {
    return { exists: false };
  }
}

function readPublishedPackageRootTargetSignatures(
  packageDir,
  {
    exists = existsSync,
    readFile = readFileSync,
    readDir = readdirSync,
    stat = statSync,
  } = {},
) {
  let packageJson;
  try {
    packageJson = readJsonFile(resolve(packageDir, 'package.json'), readFile);
  } catch {
    return [];
  }

  const targetPaths = new Set();
  for (const target of collectPackageBuildOutputTargets(packageJson)) {
    if (!isLocalPackageBuildOutputTarget(target) || isPackageBuildDistOutputTarget(target)) continue;
    const matches = resolvePackageBuildOutputTargetMatches({
      packageDir,
      outputDir: resolve(packageDir, 'dist'),
      target,
      existsSyncImpl: exists,
      readdirSyncImpl: readDir,
    });
    if (matches.length > 0) {
      matches.forEach((match) => targetPaths.add(match));
    } else {
      targetPaths.add(resolvePackageBuildOutputTargetPath({
        packageDir,
        outputDir: resolve(packageDir, 'dist'),
        target,
      }));
    }
  }

  return [...targetPaths]
    .map((targetPath) => ({
      relativePath: relative(packageDir, targetPath).split(sep).join('/'),
      signature: readPublishedPackageRootTargetSignature(targetPath, {
        exists,
        readFile,
        readDir,
        stat,
      }),
    }))
    .filter(({ relativePath }) => (
      relativePath !== 'package.json'
      && relativePath !== '..'
      && !relativePath.startsWith('../')
    ))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function readTreeSignature(rootPath, { exists = existsSync, readDir = readdirSync, stat = statSync } = {}) {
  if (!exists(rootPath)) return { exists: false, entries: [] };

  const entries = [];
  const visit = (dir, prefix) => {
    let children;
    try {
      children = readDir(dir, { withFileTypes: true });
    } catch {
      entries.push([prefix, 'unreadable']);
      return;
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === BUILD_INPUT_RECORD) continue;
      const childPath = resolve(dir, child.name);
      const childRelativePath = prefix ? `${prefix}/${child.name}` : child.name;
      let stats;
      try {
        stats = stat(childPath);
      } catch {
        entries.push([childRelativePath, 'missing']);
        continue;
      }

      if (stats.isDirectory()) {
        entries.push([childRelativePath, 'dir']);
        visit(childPath, childRelativePath);
        continue;
      }

      entries.push([
        childRelativePath,
        stats.isFile() ? 'file' : 'other',
        Number(stats.size ?? 0),
        stats.isFile()
          ? readWorkspaceBuildFileDigest(childPath)
          : String(stats.mode),
      ]);
    }
  };

  visit(rootPath, '');
  return { exists: true, entries };
}

function readRuntimeDistTreeSignature(rootPath, fsOps = {}) {
  const signature = readTreeSignature(rootPath, fsOps);
  return {
    ...signature,
    entries: signature.entries.filter(([relativePath]) =>
      !String(relativePath).replaceAll('\\', '/').endsWith('.tsbuildinfo')),
  };
}

function resolveWorkspaceExpectedOutputPaths({
  packageDir,
  includeUiArtifacts = true,
  readFile = readFileSync,
}) {
  const outputPaths = new Set();
  try {
    const raw = readJsonFile(resolve(packageDir, 'package.json'), readFile);
    for (const target of collectPackageBuildOutputTargets(raw).filter(isPackageBuildDistOutputTarget)) {
      const matches = resolvePackageBuildOutputTargetMatches({
        packageDir,
        outputDir: resolve(packageDir, 'dist'),
        target,
      });
      for (const match of matches) {
        outputPaths.add(match);
      }
      if (matches.length === 0) {
        outputPaths.add(resolvePackageBuildOutputTargetPath({
          packageDir,
          outputDir: resolve(packageDir, 'dist'),
          target,
        }));
      }
    }
    if (
      includeUiArtifacts
      && typeof raw?.scripts?.['build:ui'] === 'string'
      && raw.scripts['build:ui'].trim()
    ) {
      outputPaths.add(GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH);
    }
  } catch {
    outputPaths.add('dist/index.js');
  }

  if (outputPaths.size === 0) outputPaths.add('dist/index.js');
  return [...outputPaths].map((relativePath) => resolve(packageDir, relativePath));
}

function isSourceDevWorkspaceBuildStale({
  packageDir,
  dependencyDirs = [],
  buildMode = 'qa-runtime',
  includeUiArtifacts = true,
  exists = existsSync,
  readFile = readFileSync,
}) {
  if (!exists(resolve(packageDir, 'src')) && !exists(resolve(packageDir, 'sources'))) {
    return false;
  }

  const expectedOutputPaths = resolveWorkspaceExpectedOutputPaths({
    packageDir,
    includeUiArtifacts,
    readFile,
  });
  if (!expectedOutputPaths.every((candidatePath) => exists(candidatePath))) {
    return true;
  }

  const distDir = resolve(packageDir, 'dist');
  const runtimeEntrypoints = expectedOutputPaths.filter((candidatePath) => (
    /\.(?:mjs|cjs|js)$/.test(candidatePath)
    && (candidatePath === distDir || candidatePath.startsWith(distDir + sep))
  ));
  if (runtimeEntrypoints.length > 0 && hasMissingLocalImportsSync({
    distDir,
    entryPaths: runtimeEntrypoints,
  })) {
    return true;
  }

  return !isWorkspacePackageOutputCurrent(packageDir, { dependencyDirs, buildMode });
}

function resolveSourceDevWorkspaceDependencyDirs({ repoRoot, workspaceNames, workspaceName, readFile }) {
  const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
  const packageJson = readJsonFile(resolve(packageDir, 'package.json'), readFile);
  const currentPackageName = `@happier-dev/${workspaceName}`;
  const packageNames = new Set([
    ...workspaceNames.map((name) => `@happier-dev/${name}`),
    ...Object.keys(packageJson.peerDependencies ?? {}).filter((name) => (
      name.startsWith('@happier-dev/')
      && existsSync(resolve(resolveBundledWorkspacePackageDir({
        repoRoot,
        workspaceName: name.replace(/^@happier-dev\//, ''),
      }), 'package.json'))
    )),
  ]);
  const dependencyNames = collectWorkspacePackageFingerprintDependencyNames(
    packageJson,
    currentPackageName,
    packageNames,
    { packageDirsByName: new Map([...packageNames].map((name) => [name, resolveBundledWorkspacePackageDir({
      repoRoot, workspaceName: name.replace(/^@happier-dev\//, ''),
    })])) },
  );
  return [...dependencyNames].map((name) => resolveBundledWorkspacePackageDir({
    repoRoot,
    workspaceName: name.replace(/^@happier-dev\//, ''),
  }));
}

function collectStaleSourceDevWorkspaceBuilds({
  repoRoot,
  workspaceNames,
  buildMode = 'qa-runtime',
  includeUiArtifacts = true,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  const staleBuilds = [];
  for (const workspaceName of workspaceNames) {
    const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
    const tsconfigPath = resolveBundledWorkspaceTsconfigPath({ repoRoot, workspaceName });
    if (!exists(tsconfigPath)) continue;
    if (!isSourceDevWorkspaceBuildStale({
      packageDir,
      buildMode,
      dependencyDirs: resolveSourceDevWorkspaceDependencyDirs({
        repoRoot, workspaceNames, workspaceName, readFile,
      }),
      includeUiArtifacts,
      exists,
      readFile,
      readDir,
      stat,
    })) continue;
    staleBuilds.push({ workspaceName, tsconfigPath });
  }
  return staleBuilds;
}

export function computeSourceDevSharedDepsSignature(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    includeDevDependencies: opts.includeDevDependencies === true,
    exists,
    readFile,
  });

  return {
    version: SOURCE_DEV_SHARED_DEPS_STAMP_VERSION,
    workspaceNames,
    packages: workspaceNames.map((workspaceName) => {
      const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
      return {
        workspaceName,
        ...(opts.includeBuildInputs === false ? {} : { buildInputs: readWorkspacePackageInputFingerprint({ packageDir }) }),
        buildRecord: readSmallFileSignature(
          resolve(packageDir, 'dist', BUILD_INPUT_RECORD),
          { exists, readFile },
        ),
        rootRuntimeTargets: readPublishedPackageRootTargetSignatures(packageDir, {
          exists,
          readFile,
          readDir,
          stat,
        }),
        pluginManifest: readSmallFileSignature(
          resolve(packageDir, BUNDLED_PLUGIN_MANIFEST_ARTIFACT_RELATIVE_PATH),
          { exists, readFile },
        ),
        dist: readRuntimeDistTreeSignature(resolve(packageDir, 'dist'), { exists, readDir, stat }),
      };
    }),
  };
}

function createSourceDevBuildInputSignature(signature, workspaceNames) {
  const selectedWorkspaceNames = workspaceNames
    ? new Set([...workspaceNames].map((workspaceName) => String(workspaceName)))
    : null;
  return {
    version: signature?.version,
    workspaceNames: (signature?.workspaceNames ?? []).filter(
      (workspaceName) => !selectedWorkspaceNames || selectedWorkspaceNames.has(String(workspaceName)),
    ),
    packages: (signature?.packages ?? [])
      .filter((pkg) => !selectedWorkspaceNames || selectedWorkspaceNames.has(String(pkg.workspaceName)))
      .map((pkg) => ({
        workspaceName: pkg.workspaceName,
        buildInputs: pkg.buildInputs,
      })),
  };
}

function sourceDevBuildInputsEqual(left, right, workspaceNames) {
  return JSON.stringify(createSourceDevBuildInputSignature(left, workspaceNames))
    === JSON.stringify(createSourceDevBuildInputSignature(right, workspaceNames));
}

function collectSourceDevWorkspaceNamesWithChangedBuildInputs(left, right, workspaceNames) {
  return [...workspaceNames].filter((workspaceName) => !sourceDevBuildInputsEqual(
    left,
    right,
    new Set([workspaceName]),
  ));
}

function readSourceDevSharedDepsStamp(stampPath, readFile = readFileSync) {
  try {
    const raw = String(readFile(stampPath, 'utf8'));
    // The canonical writer puts the version first. Check that header before
    // parsing: v7 histories can contain hundreds of MB of repeated output bodies.
    if (!SOURCE_DEV_SHARED_DEPS_STAMP_HEADER.test(raw)) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createSourceDevSharedDepsStampKey(signature) {
  return JSON.stringify((signature?.workspaceNames ?? []).map((workspaceName) => String(workspaceName)));
}

function readSourceDevSharedDepsStampEntry({ stamp, signature }) {
  const stampKey = createSourceDevSharedDepsStampKey(signature);
  if (
    stamp?.version === SOURCE_DEV_SHARED_DEPS_STAMP_VERSION &&
    stamp.entries &&
    typeof stamp.entries === 'object' &&
    !Array.isArray(stamp.entries)
  ) {
    const entry = stamp.entries[stampKey];
    if (JSON.stringify(entry?.signature) === JSON.stringify(signature)) {
      return entry;
    }
    const supersetEntry = findSourceDevSharedDepsSupersetStampEntry({ stamp, signature });
    if (supersetEntry) {
      return supersetEntry;
    }
  }

  return null;
}

function readCompatiblePreviousSourceDevSharedDepsSignature({ stamp, signature }) {
  if (
    stamp?.version !== SOURCE_DEV_SHARED_DEPS_STAMP_VERSION ||
    !stamp.entries ||
    typeof stamp.entries !== 'object' ||
    Array.isArray(stamp.entries)
  ) {
    return null;
  }

  const previousSignature = stamp.entries[createSourceDevSharedDepsStampKey(signature)]?.signature;
  if (
    previousSignature?.version !== signature?.version ||
    JSON.stringify(previousSignature.workspaceNames) !== JSON.stringify(signature?.workspaceNames) ||
    !Array.isArray(previousSignature.packages) ||
    previousSignature.packages.length !== signature?.packages?.length
  ) {
    return null;
  }

  const previousWorkspaceNames = previousSignature.packages.map((pkg) => String(pkg?.workspaceName ?? ''));
  if (new Set(previousWorkspaceNames).size !== previousWorkspaceNames.length) return null;
  if (JSON.stringify(previousWorkspaceNames) !== JSON.stringify(signature.workspaceNames)) return null;
  return previousSignature;
}

function findSourceDevSharedDepsSupersetStampEntry({ stamp, signature }) {
  const requestedWorkspaceNames = new Set((signature?.workspaceNames ?? []).map((workspaceName) => String(workspaceName)));
  if (requestedWorkspaceNames.size === 0) return null;

  for (const entry of Object.values(stamp.entries)) {
    const entrySignature = entry?.signature;
    if (entrySignature?.version !== signature?.version) continue;
    const entryWorkspaceNames = new Set((entrySignature.workspaceNames ?? []).map((workspaceName) => String(workspaceName)));
    if (![...requestedWorkspaceNames].every((workspaceName) => entryWorkspaceNames.has(workspaceName))) continue;
    if (sourceDevSharedDepsSignaturePackagesInclude({ supersetSignature: entrySignature, signature })) {
      return entry;
    }
  }

  return null;
}

function sourceDevSharedDepsSignaturePackagesInclude({ supersetSignature, signature }) {
  const packagesByWorkspaceName = new Map();
  for (const pkg of supersetSignature?.packages ?? []) {
    const workspaceName = String(pkg?.workspaceName ?? '');
    if (workspaceName) {
      packagesByWorkspaceName.set(workspaceName, pkg);
    }
  }

  for (const pkg of signature?.packages ?? []) {
    const workspaceName = String(pkg?.workspaceName ?? '');
    if (!workspaceName) return false;
    if (JSON.stringify(packagesByWorkspaceName.get(workspaceName)) !== JSON.stringify(pkg)) {
      return false;
    }
  }

  return true;
}

function createSourceDevSharedDepsStampPayload({ previousStamp, signature, syncedAtMs }) {
  const entries = {};
  if (
    previousStamp?.version === SOURCE_DEV_SHARED_DEPS_STAMP_VERSION &&
    previousStamp.entries &&
    typeof previousStamp.entries === 'object' &&
    !Array.isArray(previousStamp.entries)
  ) {
    Object.assign(entries, previousStamp.entries);
  }

  entries[createSourceDevSharedDepsStampKey(signature)] = {
    signature,
    syncedAtMs,
  };

  return {
    version: SOURCE_DEV_SHARED_DEPS_STAMP_VERSION,
    entries,
  };
}

function collectTreeEntryShape(treeSignature) {
  if (treeSignature?.exists !== true) return [];
  return (treeSignature.entries ?? []).map((entry) => {
    const [relativePath, entryType, entrySize] = entry;
    if (entryType === 'file' || entryType === 'other') {
      return [relativePath, entryType, entrySize];
    }
    return [relativePath, entryType];
  });
}

function treeEntryShapesEqual(leftTree, rightTree) {
  return JSON.stringify(collectTreeEntryShape(leftTree)) === JSON.stringify(collectTreeEntryShape(rightTree));
}

function treeContainsRecordedShape(recordedTree, currentTree) {
  if (recordedTree?.exists !== true) return true;
  if (currentTree?.exists !== true) return false;

  const currentEntries = new Map(
    collectTreeEntryShape(currentTree).map((entry) => [String(entry[0]), entry]),
  );
  return collectTreeEntryShape(recordedTree).every((recordedEntry) => {
    const currentEntry = currentEntries.get(String(recordedEntry[0]));
    if (!currentEntry || currentEntry[1] !== recordedEntry[1]) return false;
    if (recordedEntry[1] !== 'file' && recordedEntry[1] !== 'other') return true;
    const recordedSize = Number(recordedEntry[2]);
    const currentSize = Number(currentEntry[2]);
    return recordedSize > 0 ? currentSize > 0 : currentSize === 0;
  });
}

function sourceDevWorkspacePackageOutputExists({
  repoRoot,
  pkg,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
  requireExactOutputs = false,
  workspaceNames,
}) {
  const workspaceName = String(pkg?.workspaceName ?? '').trim();
  if (!workspaceName) return false;
  const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
  if (!packageDir || !exists(resolve(packageDir, 'package.json'))) return false;
  if (requireExactOutputs) {
    if (JSON.stringify(readSmallFileSignature(resolve(packageDir, 'dist', BUILD_INPUT_RECORD), { exists, readFile }))
      !== JSON.stringify(pkg.buildRecord)) return false;
    if ((exists(resolve(packageDir, 'src')) || exists(resolve(packageDir, 'sources')))
      && !isWorkspacePackageOutputValid(packageDir, {
        dependencyDirs: resolveSourceDevWorkspaceDependencyDirs({ repoRoot, workspaceNames, workspaceName, readFile }),
        monorepoRoot: repoRoot,
      })) return false;
    if (JSON.stringify(readSmallFileSignature(resolve(packageDir, BUNDLED_PLUGIN_MANIFEST_ARTIFACT_RELATIVE_PATH), { exists, readFile }))
      !== JSON.stringify(pkg.pluginManifest)) return false;
  }

  const declaredOutputPaths = resolveWorkspaceExpectedOutputPaths({ packageDir, readFile });
  if (!declaredOutputPaths.every((candidatePath) => exists(candidatePath))) return false;
  for (const target of pkg.rootRuntimeTargets ?? []) {
    const targetPath = resolve(packageDir, String(target?.relativePath ?? ''));
    if (
      JSON.stringify(readPublishedPackageRootTargetSignature(targetPath, {
        exists,
        readFile,
        readDir,
        stat,
      })) !== JSON.stringify(target?.signature)
    ) return false;
  }
  if (pkg.dist?.exists !== true) return true;

  if (requireExactOutputs) return JSON.stringify(pkg.dist)
    === JSON.stringify(readRuntimeDistTreeSignature(resolve(packageDir, 'dist'), { exists, readDir, stat }));

  return treeContainsRecordedShape(
    pkg.dist,
    readRuntimeDistTreeSignature(resolve(packageDir, 'dist'), { exists, readDir, stat }),
  );
}

function sourceDevWorkspaceOutputsContainRecordedPublication({
  repoRoot,
  signature,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
  requireExactOutputs = false,
}) {
  return (signature?.packages ?? []).every((pkg) => sourceDevWorkspacePackageOutputExists({
    repoRoot,
    pkg,
    exists,
    readFile,
    readDir,
    stat,
    requireExactOutputs,
    workspaceNames: signature.workspaceNames,
  }));
}

function sourceDevSharedDepsPackageOutputExists({
  repoRoot,
  pkg,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
  requireExactOutputs = false,
}) {
  const workspaceName = String(pkg?.workspaceName ?? '').trim();
  if (!workspaceName) return false;
  const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', workspaceName);
  if (!exists(resolve(destPackageDir, 'package.json'))) return false;
  const declaredOutputPaths = resolveWorkspaceExpectedOutputPaths({
    packageDir: destPackageDir,
    readFile,
  });
  if (!declaredOutputPaths.every((candidatePath) => exists(candidatePath))) return false;
  if (pkg.pluginManifest?.exists === true) {
    const destPluginManifestPath = resolve(
      destPackageDir,
      BUNDLED_PLUGIN_MANIFEST_ARTIFACT_RELATIVE_PATH,
    );
    if (!exists(destPluginManifestPath)) return false;
    if (JSON.stringify(readSmallFileSignature(destPluginManifestPath, { exists, readFile }))
      !== JSON.stringify(pkg.pluginManifest)) return false;
  }
  for (const target of pkg.rootRuntimeTargets ?? []) {
    const targetPath = resolve(destPackageDir, String(target?.relativePath ?? ''));
    if (
      JSON.stringify(readPublishedPackageRootTargetSignature(targetPath, {
        exists,
        readFile,
        readDir,
        stat,
      })) !== JSON.stringify(target?.signature)
    ) return false;
  }
  if (pkg.dist?.exists === true) {
    const destDist = resolve(destPackageDir, 'dist');
    if (!exists(destDist)) return false;
    const destDistSignature = readRuntimeDistTreeSignature(destDist, { exists, readDir, stat });
    if (requireExactOutputs
      ? JSON.stringify(pkg.dist) !== JSON.stringify(destDistSignature)
      : !treeEntryShapesEqual(pkg.dist, destDistSignature)) return false;
  }
  return true;
}

function sourceDevSharedDepsOutputsExist({
  repoRoot,
  signature,
  includeRuntimeDependencies = true,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
  requireExactOutputs = false,
}) {
  for (const pkg of signature.packages ?? []) {
    if (!sourceDevSharedDepsPackageOutputExists({ repoRoot, pkg, exists, readFile, readDir, stat, requireExactOutputs })) return false;
  }

  return includeRuntimeDependencies
    ? exists(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'package.json'))
    : true;
}

function resolveSourceDevSharedDepsWorkspaceNamesToSync({
  repoRoot,
  stamp,
  signature,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  const previousSignature = readCompatiblePreviousSourceDevSharedDepsSignature({ stamp, signature });
  if (!previousSignature) return signature.workspaceNames;

  const previousPackagesByWorkspaceName = new Map(
    previousSignature.packages.map((pkg) => [String(pkg.workspaceName), pkg]),
  );
  return signature.packages
    .filter((pkg) => {
      const workspaceName = String(pkg.workspaceName);
      return (
        JSON.stringify(previousPackagesByWorkspaceName.get(workspaceName)) !== JSON.stringify(pkg) ||
        !sourceDevSharedDepsPackageOutputExists({ repoRoot, pkg, exists, readFile, readDir, stat })
      );
    })
    .map((pkg) => String(pkg.workspaceName));
}

function isSourceDevSharedDepsCurrent({
  repoRoot,
  stampPath,
  signature,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
  includeRuntimeDependencies = true,
}) {
  const stamp = readSourceDevSharedDepsStamp(stampPath, readFile);
  if (!readSourceDevSharedDepsStampEntry({ stamp, signature })) return false;
  return sourceDevSharedDepsOutputsExist({
    repoRoot,
    signature,
    exists,
    readFile,
    readDir,
    stat,
    includeRuntimeDependencies,
  });
}

function writeSourceDevSharedDepsStamp({
  stampPath,
  signature,
  syncedAtMs,
  mkdir = mkdirSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
}) {
  mkdir(dirname(stampPath), { recursive: true });
  writeFile(
    stampPath,
    `${JSON.stringify(createSourceDevSharedDepsStampPayload({
      previousStamp: readSourceDevSharedDepsStamp(stampPath, readFile),
      signature,
      syncedAtMs,
    }), null, 2)}\n`,
    'utf8',
  );
}

export function publishSourceDevReadinessFromRuntimeClosure(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    includeDevDependencies: false,
    exists,
    readFile,
  });
  const signature = computeSourceDevSharedDepsSignature({
    repoRoot,
    workspaceNames,
    includeDevDependencies: false,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const staleBuilds = collectStaleSourceDevWorkspaceBuilds({
    repoRoot,
    workspaceNames,
    includeUiArtifacts: true,
    exists,
    readFile,
    readDir,
    stat,
  });
  if (staleBuilds.length > 0) {
    return {
      stamped: false,
      reason: 'stale-workspace-builds',
      workspaceNames: staleBuilds.map((build) => build.workspaceName),
    };
  }
  if (
    !sourceDevSharedDepsOutputsExist({
      repoRoot,
      signature,
      exists,
      readFile,
      readDir,
      stat,
      includeRuntimeDependencies: true,
    })
  ) {
    return { stamped: false, reason: 'runtime-outputs-incomplete' };
  }

  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  const syncedAtMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  writeSourceDevSharedDepsStamp({
    stampPath,
    signature,
    syncedAtMs,
    mkdir,
    readFile,
    writeFile,
  });
  return { stamped: true };
}

export function publishSourceDevReadinessAfterRuntimeBuild(opts = {}) {
  const publishReadiness =
    opts.publishSourceDevReadinessFromRuntimeClosureImpl
    ?? publishSourceDevReadinessFromRuntimeClosure;
  return publishReadiness({
    repoRoot: resolveRepoRootOption(opts.repoRoot),
    workspaceNames: opts.workspaceNames,
  });
}

export function inspectSourceDevSharedDepsForSourceDev(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const includeRuntimeDependencies = opts.includeRuntimeDependencies !== false;
  let workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    // Source-dev readiness tracks the runtime closure. A plugin's test-only
    // workspace dependencies are neither inputs to its shipped artifact nor
    // inputs to coherent artifact publication.
    includeDevDependencies: false,
    exists,
    readFile,
  });
  const signature = computeSourceDevSharedDepsSignature({
    repoRoot,
    workspaceNames,
    includeDevDependencies: false,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  const current = isSourceDevSharedDepsCurrent({
    repoRoot,
    stampPath,
    signature,
    exists,
    readFile,
    readDir,
    stat,
    includeRuntimeDependencies,
  });
  if (!current) return { current: false, reason: 'not-current' };
  if (collectInstalledBundledPluginWorkspaceNamesDivergingFromSource({
    repoRoot,
    workspaceNames,
  }).length > 0) {
    return { current: false, reason: 'not-current' };
  }
  return { current: true, reason: 'current' };
}

export function inspectUsableSourceDevSharedDepsLastGreen(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  let workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    // Targeted source-dev work must not widen into a plugin's test-only
    // workspace graph before the canonical package build owner sees it.
    includeDevDependencies: false,
    exists,
    readFile,
  });

  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  const stamp = readSourceDevSharedDepsStamp(stampPath, readFile);
  const hasReadinessHistory = stamp?.version === SOURCE_DEV_SHARED_DEPS_STAMP_VERSION
    && stamp.entries && typeof stamp.entries === 'object' && !Array.isArray(stamp.entries);
  const requiredWorkspaceNames = new Set(workspaceNames.map((workspaceName) => String(workspaceName)));
  const candidates = Object.values(hasReadinessHistory ? stamp.entries : {})
    .filter((entry) => {
      const signatureWorkspaceNames = new Set(
        (entry?.signature?.workspaceNames ?? []).map((workspaceName) => String(workspaceName)),
      );
      return [...requiredWorkspaceNames].every((workspaceName) => signatureWorkspaceNames.has(workspaceName));
    })
    .sort((left, right) => Number(right?.syncedAtMs ?? 0) - Number(left?.syncedAtMs ?? 0));
  const recordedCandidateCount = candidates.length;

  const inspectPublication = (entry) => {
    if (!sourceDevWorkspaceOutputsContainRecordedPublication({
      repoRoot,
      signature: entry.signature,
      exists,
      readFile,
      readDir,
      stat,
      requireExactOutputs: opts.requireExactOutputs === true,
    })) return null;
    if (opts.verifyMaterializedOutputs === true && !sourceDevSharedDepsOutputsExist({
      repoRoot, signature: entry.signature, exists, readFile, readDir, stat,
      requireExactOutputs: opts.requireExactOutputs === true,
      includeRuntimeDependencies: opts.includeRuntimeDependencies !== false,
    })) return null;
    return {
      usable: true,
      reason: 'recorded-outputs-complete',
      syncedAtMs: Number(entry.syncedAtMs ?? 0),
      ...(opts.requireExactOutputs === true ? { signature: entry.signature } : {}),
    };
  };
  for (const entry of candidates) {
    const publication = inspectPublication(entry);
    if (publication) return publication;
  }

  // A coherent QA capture can be published after newer source arrives without
  // stamping that source current. Exact source + installed-output verification
  // can admit those bytes through their canonical package build records; a
  // stale materialization history must not become a second build authority.
  if (opts.requireExactOutputs === true && opts.verifyMaterializedOutputs === true) {
    const publication = inspectPublication({
      signature: computeSourceDevSharedDepsSignature({
        repoRoot, workspaceNames, includeDevDependencies: false,
        existsSync: exists, readFileSync: readFile, readdirSync: readDir, statSync: stat,
      }),
      // This is output admission, not evidence of a current-source sync time.
      syncedAtMs: 0,
    });
    if (publication) return publication;
  }

  return {
    usable: false,
    reason: recordedCandidateCount > 0 ? 'recorded-outputs-incomplete' : 'readiness-unavailable',
  };
}

export async function syncSharedDepsForSourceDev(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const inheritedEnv = opts.env ?? process.env;
  const env = { ...inheritedEnv, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    env: inheritedEnv,
    buildMode: inheritedEnv[WORKSPACE_BUILD_MODE_ENV] ?? 'source-dev',
  }) };
  const exists = opts.existsSync ?? existsSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const includeRuntimeDependencies = opts.includeRuntimeDependencies !== false;
  // The canonical bundled-plugin generator is itself the sole publisher for
  // one invocation. It still needs this owner to build and materialize the
  // source runtime closure before loading authoring modules, but it must not
  // recursively invoke its own publisher while holding that invocation's
  // workspace lock.
  const shouldPublishBundledPluginArtifacts = opts.publishBundledPluginArtifacts !== false;
  const prepareBundledPluginCompilerInputs = opts.prepareBundledPluginCompilerInputsImpl
    ?? runCanonicalGeneratedCompilerInputs;
  const generatedCompilerInputMode = opts.generatedCompilerInputMode
    ?? (String(env.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1' ? 'check' : 'write');
  const childBuildEnv = createWorkspaceChildBuildEnv({
    env,
    heldLockValue:
      opts.lockOptions?.heldLockValue
      ?? opts.lockOptions?.heldLockPath,
  });
  // Bundled Agent ids reach `packages/agents` and `packages/protocol`, which are
  // upstream of `cli-common`. Action declarations are type-only and their
  // drift check belongs to the SDK declaration/package consumers, not runtime
  // readiness admission (which can reuse already-current package outputs).
  //
  // A caller that makes several bounded passes over one unchanged set of
  // committed plugin manifests opts later passes out: the projection reads only
  // those manifests, so re-running it re-derives identical bytes. The canonical
  // generator does exactly that. The projection measured ~20s on an idle machine
  // and 565s on a saturated one, so the repeat is cheap in the normal case and
  // lengthens a workspace-lock convoy in exactly the case that already hurts.
  const shouldPrepareBundledPluginCompilerInputs =
    opts.prepareBundledPluginCompilerInputs !== false;
  if (
    shouldPrepareBundledPluginCompilerInputs
    && (
      opts.prepareBundledPluginCompilerInputsImpl
      || exists(resolve(repoRoot, BUNDLED_PLUGIN_GENERATOR_RELATIVE_PATH))
    )
  ) {
    await prepareBundledPluginCompilerInputs({
      repoRoot,
      env: childBuildEnv,
      quiet: opts.quiet === true,
      mode: generatedCompilerInputMode,
    });
  }
  let workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    exists,
    readFile,
  });
  const withStalePackages = async (result) => {
    const stalePackages = await inspectWorkspaceQaStalePackages(
      repoRoot, workspaceNames.map((name) => `@happier-dev/${name}`),
    );
    return stalePackages.length > 0 ? { ...result, stalePackages } : result;
  };
  const reportProgress = createSourceDevSharedDepsProgressReporter(opts);
  const workspaceBuildTimeoutMs = resolveSourceDevWorkspaceBuildTimeoutMs(opts.workspaceBuildTimeoutMs);
  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  const lockOptions = resolveSourceDevSharedDepsLockOptions(opts.lockOptions ?? {});
  const lockPath = lockOptions.lockPath ?? resolveCliSharedDepsBuildLockPath(repoRoot);
  const resolvedLockOptions = { ...lockOptions, lockPath };
  const computeSignature = () => computeSourceDevSharedDepsSignature({
    repoRoot,
    workspaceNames,
    // This is the actual package dependency closure of the requested source
    // target. It intentionally does not expand one plugin into every bundled
    // plugin; global projection coherence is validated from final artifacts.
    includeDevDependencies: false,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const collectStaleBuilds = () => collectStaleSourceDevWorkspaceBuilds({
    repoRoot,
    workspaceNames,
    buildMode: env[WORKSPACE_BUILD_MODE_ENV],
    includeUiArtifacts: includeRuntimeDependencies,
    exists,
    readFile,
    readDir,
    stat,
  });
  const isCurrentRuntimeClosure = (candidateSignature) => (
    isSourceDevSharedDepsCurrent({
      repoRoot,
      stampPath,
      signature: candidateSignature,
      exists,
      readFile,
      readDir,
      stat,
      includeRuntimeDependencies,
    })
    && collectInstalledBundledPluginWorkspaceNamesDivergingFromSource({
      repoRoot,
      workspaceNames,
    }).length === 0
    // A source-dev stamp proves materialization, not a successful current
    // compile. Strict callers must re-enter package admission after QA reuse.
    && (env[WORKSPACE_BUILD_MODE_ENV] !== 'strict' || collectStaleBuilds().length === 0)
  );
  resolvedLockOptions.tryResolveWaiter = async () => {
    const waitSignature = computeSignature();
    if (!isCurrentRuntimeClosure(waitSignature)) {
      return { resolved: false };
    }
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'complete',
      event: 'done',
      reason: 'current-after-wait',
    });
    return {
      resolved: true,
      value: { synced: false, reason: 'current-after-wait' },
    };
  };

  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'signature',
    event: 'start',
    workspaceCount: workspaceNames.length,
  });
  let signature = computeSignature();
  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'signature',
    event: 'done',
    workspaceCount: workspaceNames.length,
  });
  if (isCurrentRuntimeClosure(signature) && !(opts.pluginFailures?.length)) {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'complete',
      event: 'done',
      reason: 'current',
    });
    return await withStalePackages({ synced: false, reason: 'current' });
  }

  const withLock = opts.withBuildSharedDepsLockImpl ?? withBuildSharedDepsLock;
  const ensureWorkspacePackagesBuilt =
    opts.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName;
  const selectWorkspaceBuilds = (staleBuilds) => (
    opts.preserveBundledPluginArtifacts === true
      ? staleBuilds.filter(({ workspaceName }) => !workspaceName.startsWith('plugins-'))
      : staleBuilds
  );
  const buildWorkspaceCandidates = async (workspaceBuilds, staleBuilds) => {
    if (workspaceBuilds.length === 0) {
      return { builtWorkspaceNames: [], failedPluginBuilds: [] };
    }
    const staleBuildByWorkspaceName = new Map(
      staleBuilds.map((staleBuild) => [staleBuild.workspaceName, staleBuild]),
    );
    const describePackageBuild = ({ packageDir, packageName }) => {
      const workspaceName = packageName.replace(/^@happier-dev\//, '');
      return staleBuildByWorkspaceName.get(workspaceName) ?? {
        workspaceName,
        tsconfigPath: resolve(packageDir, 'tsconfig.json'),
      };
    };
    const activeBuilds = new Map();
    return await ensureWorkspacePackagesBuiltWithPluginIsolation({
      repoRoot,
      workspaceNames: workspaceBuilds.map(({ workspaceName }) => workspaceName),
      ensureWorkspacePackagesBuiltByNameImpl: ensureWorkspacePackagesBuilt,
      buildOptions: {
        quiet: opts.quiet !== false,
        env: childBuildEnv,
        // Each package owner rechecks currentness after taking its own lock.
        force: false,
        includeDevDependencies: false,
        timeoutMs: workspaceBuildTimeoutMs,
        isolatePluginFailures: true,
        onPackageBuildStart: (context) => {
          const activeBuild = describePackageBuild(context);
          activeBuilds.set(activeBuild.workspaceName, activeBuild);
          reportSourceDevSharedDepsProgress(reportProgress, {
            stage: 'workspace-build',
            event: 'start',
            workspaceName: activeBuild.workspaceName,
            tsconfigPath: activeBuild.tsconfigPath,
          });
        },
        onPackageBuildDone: (context) => {
          const completedBuild = describePackageBuild(context);
          activeBuilds.delete(completedBuild.workspaceName);
          reportSourceDevSharedDepsProgress(reportProgress, {
            stage: 'workspace-build',
            event: 'done',
            workspaceName: completedBuild.workspaceName,
            tsconfigPath: completedBuild.tsconfigPath,
          });
        },
      },
      onBatchFailure: ({ workspaceNames: failedWorkspaceNames }) => {
        const failedBuild = activeBuilds.values().next().value
          ?? staleBuildByWorkspaceName.get(failedWorkspaceNames[0])
          ?? workspaceBuilds[0];
        reportSourceDevSharedDepsProgress(reportProgress, {
          stage: 'workspace-build',
          event: 'failed',
          workspaceName: failedBuild.workspaceName,
          tsconfigPath: failedBuild.tsconfigPath,
        });
      },
    });
  };

  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'stale-scan',
    event: 'start-before-lock',
    workspaceCount: workspaceNames.length,
  });
  const staleBuildsBeforeLock = collectStaleBuilds();
  const workspaceBuildsBeforeLock = selectWorkspaceBuilds(staleBuildsBeforeLock);
  const workspaceNamesPreparedBeforeLock = new Set(
    workspaceBuildsBeforeLock.map(({ workspaceName }) => workspaceName),
  );
  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'stale-scan',
    event: 'done-before-lock',
    staleWorkspaceCount: staleBuildsBeforeLock.length,
  });
  const buildInputSignature = signature;
  const prebuildResult = await buildWorkspaceCandidates(
    workspaceBuildsBeforeLock,
    staleBuildsBeforeLock,
  );
  const sourceChangedWorkspaceNames = new Set();
  if (workspaceBuildsBeforeLock.length > 0) {
    const signatureAfterWorkspaceBuild = computeSignature();
    for (const workspaceName of collectSourceDevWorkspaceNamesWithChangedBuildInputs(
      buildInputSignature,
      signatureAfterWorkspaceBuild,
      workspaceNamesPreparedBeforeLock,
    )) {
      sourceChangedWorkspaceNames.add(workspaceName);
    }
  }

  const canPublishPreparedWorkspaceDist = (workspaceName) => {
    if (!sourceChangedWorkspaceNames.has(workspaceName)) return true;
    // The package owner certifies QA captures independently of later source
    // edits. Consume that coherent output, but leave readiness unstamped so
    // the next request still rebuilds. Plugin projections also consume authored
    // manifests, so their existing source-coherence fence remains necessary.
    return env[WORKSPACE_BUILD_MODE_ENV] === 'qa-runtime'
      && !workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX)
      && isWorkspacePackageOutputValid(resolveBundledWorkspacePackageDir({ repoRoot, workspaceName }), {
        monorepoRoot: repoRoot,
        dependencyDirs: resolveSourceDevWorkspaceDependencyDirs({ repoRoot, workspaceNames, workspaceName, readFile }),
      });
  };

  const rebuiltWorkspaceNames = prebuildResult.builtWorkspaceNames.filter(
    canPublishPreparedWorkspaceDist,
  );
  const pluginFailures = [
    ...(opts.pluginFailures ?? []),
    ...prebuildResult.failedPluginBuilds.filter((failure) => (
      !(opts.pluginFailures ?? []).some((prior) => prior.packageName === failure.packageName)
    )),
  ];
  const failedPluginWorkspaceNames = new Set(
    pluginFailures.map(({ packageName }) => packageName.replace(/^@happier-dev\//, '')),
  );
  const rebuiltPluginWorkspaceNames = resolveSelectedBundledPluginWorkspaceNames({
    repoRoot,
    workspaceNames: rebuiltWorkspaceNames,
  });
  const bundledPluginWorkspaceNamesToPublish = normalizeSourceDevSharedDepsWorkspaceNames([
    ...rebuiltPluginWorkspaceNames,
  ]).filter((workspaceName) => (
    !sourceChangedWorkspaceNames.has(workspaceName)
    && !failedPluginWorkspaceNames.has(workspaceName)
  ));
  let publishedBundledPluginArtifacts = false;
  let rebuiltGeneratedSourceWorkspaces = [];
  // The compiler and publisher have disjoint outputs: compilation owns `dist/**`,
  // while the publisher owns `.happier-plugin/**` plus the coherent generated
  // projections describing the package. A rebuilt compiled tree invalidates those
  // projections, so refresh publication after a selected plugin rebuild. The publisher's own
  // re-entrant dependency sync (`publishBundledPluginArtifacts: false`) is exempt.
  if (
    shouldPublishBundledPluginArtifacts
    && (includeRuntimeDependencies || bundledPluginWorkspaceNamesToPublish.length > 0 || pluginFailures.length > 0)
  ) {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-plugin-publish',
      event: 'start',
    });
    publishedBundledPluginArtifacts = await publishBundledPluginArtifactsAfterWorkspaceBuild({
      repoRoot,
      // E2 reports the actual rebuilt closure after its package locks and
      // post-lock currentness checks, so a plugin another owner made current
      // while we waited is not treated as changed.
      pluginWorkspaceNames: bundledPluginWorkspaceNamesToPublish,
      pluginFailures,
      syncId: `source-dev-publish.${process.pid}`,
      syncBundledWorkspaceDistImpl: opts.syncBundledWorkspaceDistImpl,
      // Generated source publication owns the CLI distribution lock. Never
      // hide an already-held outer lease behind the later shared-copy lease.
      env: childBuildEnv,
      quiet: opts.quiet === true,
      progress: opts.progress === true,
      bundledPluginArtifactPublication: opts.bundledPluginArtifactPublication
        ?? (String(childBuildEnv.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1'
          ? {
              // A one-way dev-target replica owns the ignored plugin build trees
              // consumed by its daemon. Publish only the matching target-owned
              // inventories; source-synchronized projections remain validation
              // inputs and must not be repaired by a replica writer.
              mode: 'write',
              targetOwnedOnly: true,
            }
          : undefined),
      publishBundledPluginArtifactsImpl: opts.publishBundledPluginArtifactsImpl,
    });
    if (publishedBundledPluginArtifacts) {
      rebuiltGeneratedSourceWorkspaces = await rebuildWorkspacesInvalidatedByBundledPluginPublication({
        repoRoot,
        workspaceNames,
        includeUiArtifacts: includeRuntimeDependencies,
        env: childBuildEnv,
        quiet: opts.quiet === true,
        includeDevDependencies: false,
        timeoutMs: workspaceBuildTimeoutMs,
        syncId: `source-dev-generated.${process.pid}`,
        ensureWorkspacePackagesBuiltByNameImpl: ensureWorkspacePackagesBuilt,
      });
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'bundled-plugin-generated-source-build',
        event: 'done',
        staleWorkspaceCount: rebuiltGeneratedSourceWorkspaces.length,
      });
    }
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-plugin-publish',
      event: 'done',
      published: publishedBundledPluginArtifacts,
    });
  }

  if (staleBuildsBeforeLock.length > 0 || publishedBundledPluginArtifacts) {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'signature',
      event: 'start-after-build',
      workspaceCount: workspaceNames.length,
    });
    signature = computeSignature();
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'signature',
      event: 'done-after-build',
      workspaceCount: workspaceNames.length,
    });
  }
  const preparedSignature = signature;
  const preparedWorkspaceNames = new Set([
    ...[...workspaceNamesPreparedBeforeLock].filter(
      (workspaceName) => !sourceChangedWorkspaceNames.has(workspaceName),
    ),
    ...rebuiltGeneratedSourceWorkspaces,
  ]);

  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'workspace-lock',
    event: 'waiting',
    lockTimeoutMs: resolvedLockOptions.timeoutMs,
  });
  const result = await withLock(async () => {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'workspace-lock',
      event: 'acquired',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'signature',
      event: 'start-after-lock',
      workspaceCount: workspaceNames.length,
    });
    signature = computeSignature();
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'signature',
      event: 'done-after-lock',
      workspaceCount: workspaceNames.length,
    });
    if (isCurrentRuntimeClosure(signature) && pluginFailures.length === 0) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'complete',
        event: 'done',
        reason: 'current-after-lock',
      });
      return { synced: false, reason: 'current-after-lock' };
    }

    for (const workspaceName of collectSourceDevWorkspaceNamesWithChangedBuildInputs(
      preparedSignature,
      signature,
      preparedWorkspaceNames,
    )) {
      sourceChangedWorkspaceNames.add(workspaceName);
    }

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stale-scan',
      event: 'start-after-lock',
      workspaceCount: workspaceNames.length,
    });
    const staleBuilds = collectStaleBuilds();
    const workspaceBuilds = selectWorkspaceBuilds(staleBuilds).filter(
      ({ workspaceName }) => !workspaceNamesPreparedBeforeLock.has(workspaceName),
    );
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stale-scan',
      event: 'done-after-lock',
      staleWorkspaceCount: staleBuilds.length,
    });
    const syncBundledDist = opts.syncBundledWorkspaceDistImpl ?? syncBundledWorkspaceDist;
    const syncBundledRuntimeDependencies =
      opts.syncBundledWorkspaceRuntimeDependenciesImpl ?? syncBundledWorkspaceRuntimeDependencies;
    const unpreparedStaleWorkspaceNames = new Set(
      workspaceBuilds.map(({ workspaceName }) => workspaceName),
    );

    const syncId = opts.syncId ?? `source-dev.${process.pid}`;
    const syncCliDependencies = opts.syncCliRuntimeDependenciesImpl ?? syncCliRuntimeDependencies;
    const workspaceNamesToSyncBeforeIncrementalPublication = normalizeSourceDevSharedDepsWorkspaceNames([
      ...rebuiltWorkspaceNames,
      ...rebuiltPluginWorkspaceNames,
      ...rebuiltGeneratedSourceWorkspaces,
      // A canonical package builder can satisfy this request while we wait on
      // its package lock and therefore report no package as rebuilt here. The
      // root dist is nevertheless newer than the installed runtime copy. Keep
      // the signature/output comparison authoritative even when this run also
      // published plugin artifacts, rather than inferring copy currentness from
      // the work this individual caller happened to perform.
      ...resolveSourceDevSharedDepsWorkspaceNamesToSync({
        repoRoot,
        stamp: readSourceDevSharedDepsStamp(stampPath, readFile),
        signature,
        exists,
        readFile,
        readDir,
        stat,
      }),
      ...collectInstalledBundledPluginWorkspaceNamesDivergingFromSource({
        repoRoot,
        workspaceNames,
      }),
    ]);
    const workspaceNamesToSync = workspaceNamesToSyncBeforeIncrementalPublication.filter(
      (workspaceName) => (
        !failedPluginWorkspaceNames.has(workspaceName)
        && canPublishPreparedWorkspaceDist(workspaceName)
        && !unpreparedStaleWorkspaceNames.has(workspaceName)
      ),
    );
    // Dist publication and bundled-runtime closure refresh own different facts.
    // A dependency rebuilt in this invocation (for example Protocol) can leave a
    // still-current host package's nested bundled copy stale (for example Plugin
    // SDK's private Protocol copy). Refresh every requested host's runtime
    // dependency closure in the same pass; the runtime-dependency owner filters
    // this list to actual bundled hosts. Do not narrow this to the workspaces whose
    // own dist changed or the generator can immediately load a stale nested copy.
    const runtimeDependencyWorkspaceNamesToSync = (
      workspaceNamesToSyncBeforeIncrementalPublication.length > 0
        ? workspaceNames.filter(
            (workspaceName) => !failedPluginWorkspaceNames.has(workspaceName),
          )
        : []
    );

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-sync',
      event: 'start',
      syncId,
      workspaceCount: workspaceNamesToSync.length,
    });
    if (workspaceNamesToSync.length > 0) {
      syncBundledDist({
        repoRoot,
        replaceExisting: false,
        syncId,
        workspaceNames: workspaceNamesToSync,
      });
    }
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-sync',
      event: 'done',
      syncId,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-runtime-deps-sync',
      event: 'start',
    });
    if (includeRuntimeDependencies && runtimeDependencyWorkspaceNamesToSync.length > 0) {
      syncBundledRuntimeDependencies({
        repoRoot,
        workspaceNames: runtimeDependencyWorkspaceNamesToSync,
      });
    }
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-runtime-deps-sync',
      event: 'done',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'cli-runtime-deps-sync',
      event: 'start',
    });
    if (includeRuntimeDependencies) syncCliDependencies({ repoRoot });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'cli-runtime-deps-sync',
      event: 'done',
    });

    if (sourceChangedWorkspaceNames.size > 0 || unpreparedStaleWorkspaceNames.size > 0) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'complete',
        event: 'done',
        stamped: false,
        reason: 'source-changed-during-build',
      });
      return {
        synced: true,
        stamped: false,
        reason: 'source-changed-during-build',
      };
    }

    if (!sourceDevSharedDepsOutputsExist({
      repoRoot,
      signature,
      exists,
      readFile,
      readDir,
      stat,
      includeRuntimeDependencies,
    })) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'complete',
        event: 'done',
        stamped: false,
      });
      return { synced: true, stamped: false };
    }

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stamp-write',
      event: 'start',
      stampPath,
    });
    const syncedAtMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    writeSourceDevSharedDepsStamp({
      stampPath,
      signature,
      syncedAtMs,
      mkdir,
      readFile,
      writeFile,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stamp-write',
      event: 'done',
      stampPath,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'complete',
      event: 'done',
      stamped: true,
    });
    return { synced: true, stamped: true };
  }, resolvedLockOptions);
  return await withStalePackages(result);
}

/**
 * Resolves the publication mode a shared-deps build runs under through the canonical
 * workspace-bundle owner. `live` is development/watch preparation; `artifact` is the
 * publication build whose outputs a tarball ships.
 */
export function resolveSharedDepsPublicationMode(opts = {}) {
  return resolveWorkspaceBundlePublicationMode({
    mode: opts.publicationMode ?? '',
    argv: opts.argv ?? [],
    env: opts.env ?? {},
  });
}

function isArtifactPublicationMode(publicationMode) {
  return publicationMode === WORKSPACE_BUNDLE_PUBLICATION_MODES.ARTIFACT;
}

export async function prepareBundledWorkspaceDependenciesForCli(opts = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(opts.repoRoot);
  const workspaceNames = Array.isArray(opts.workspaceNames)
    ? opts.workspaceNames
    : resolveCliBundledWorkspacePackageNames({ repoRoot: resolvedRepoRoot });
  const publicationMode = resolveSharedDepsPublicationMode(opts);
  const publishesArtifact = isArtifactPublicationMode(publicationMode);
  const reportProgress = createSourceDevSharedDepsProgressReporter(opts);
  const ensureWorkspacePackagesBuilt =
    opts.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName;
  const buildResult = await ensureWorkspacePackagesBuiltWithPluginIsolation({
    repoRoot: resolvedRepoRoot,
    // The runtime entrypoint defers Plugin builds until the generator has
    // serialized source manifests. The generator then calls this preparation
    // owner directly to compile the selected Plugins once.
    workspaceNames: opts.deferPluginBuildToGenerator === true
      ? workspaceNames.filter((name) => !name.startsWith(PLUGINS_WORKSPACE_PREFIX))
      : workspaceNames,
    ensureWorkspacePackagesBuiltByNameImpl: ensureWorkspacePackagesBuilt,
    isolatePluginBuildFailures: !publishesArtifact,
    maxConcurrentPluginBuilds: opts.maxConcurrentPluginBuilds,
    buildOptions: {
      quiet: opts.quiet === true,
      env: opts.env ?? process.env,
      includeDevDependencies: false,
      publicationMode,
      isolatePluginFailures: !publishesArtifact,
      onPackageBuildResult: ({ packageName, reason, invalidation, elapsedMs, queueWaitMs }) => {
        reportSourceDevSharedDepsProgress(reportProgress, {
          stage: 'workspace-build', event: 'result',
          workspaceName: packageName.replace(/^@happier-dev\//, ''),
          reason, invalidation, durationMs: elapsedMs, queueWaitMs,
        });
      },
      // Both live and artifact publication use the package owner's content
      // identity, including deleted inputs and changed build scripts.
    },
  });
  // A current compiler output can still have a missing or stale installed daemon
  // runtime. Select those packages through the same source-to-installed admission
  // as runtime synchronization, so the canonical publisher repairs them too.
  const failedPluginWorkspaceNames = new Set(
    buildResult.failedPluginBuilds.map(({ packageName }) => packageName.replace(/^@happier-dev\//, '')),
  );
  const rebuiltPluginWorkspaceNames = resolveSelectedBundledPluginWorkspaceNames({
    repoRoot: resolvedRepoRoot,
    workspaceNames: (opts.deferPluginBuildToGenerator === true || publishesArtifact)
      ? workspaceNames
      : [
          ...buildResult.builtWorkspaceNames,
          ...collectInstalledBundledPluginWorkspaceNamesDivergingFromSource({
            repoRoot: resolvedRepoRoot,
            workspaceNames,
          }),
        ],
  }).filter((workspaceName) => !failedPluginWorkspaceNames.has(workspaceName));

  return {
    resolvedRepoRoot,
    publicationMode,
    workspaceNames,
    rebuiltPluginWorkspaceNames,
    failedPluginBuilds: buildResult.failedPluginBuilds,
  };
}

function createBundledPluginPreparedPackageValidator({ repoRoot }) {
  const verifyPackage = ({ packageName, packageDir }) => {
    const workspaceName = String(packageName).replace(/^@happier-dev\//u, '');
    assertBundledPluginPackageCorrespondence({
      packageName,
      sourceDir: resolveBundledWorkspacePackageDir({ repoRoot, workspaceName }),
      packageDir,
      // Live refresh admission is about the publisher-owned daemon runtime. The
      // compiler owns `dist`; a failed current compile must not invalidate an
      // otherwise coherent last-green daemon package.
      runtimeRoots: ['.happier-plugin'],
    });
  };
  return {
    validatePreparedPackage: verifyPackage,
    isPackageCurrent({ packageName, packageDir }) {
      try {
        verifyPackage({ packageName, packageDir });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function syncPreparedRuntimeWorkspacePackages({
  repoRoot,
  workspaceNames,
  failedPluginBuilds = [],
  cliCommonWorkspacesModule,
  syncBundledDist,
  syncBundledRuntimeDependencies,
}) {
  const ordinaryWorkspaceNames = workspaceNames.filter(
    (workspaceName) => !workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX),
  );
  const pluginWorkspaceNames = workspaceNames.filter(
    (workspaceName) => workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX),
  );
  const syncedWorkspaceNames = [];
  const pluginFailures = [];

  if (ordinaryWorkspaceNames.length > 0) {
    syncBundledDist({
      repoRoot,
      workspaceNames: ordinaryWorkspaceNames,
      cliCommonWorkspacesModule,
    });
    syncedWorkspaceNames.push(...ordinaryWorkspaceNames);
  }

  const pluginAdmission = createBundledPluginPreparedPackageValidator({ repoRoot });
  for (const workspaceName of pluginWorkspaceNames) {
    const packageName = `@happier-dev/${workspaceName}`;
    const installedPackageDir = resolve(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      ...packageName.split('/'),
    );
    if (pluginAdmission?.isPackageCurrent({ packageName, packageDir: installedPackageDir })) {
      continue;
    }
    try {
      syncBundledDist({
        repoRoot,
        workspaceNames: [workspaceName],
        cliCommonWorkspacesModule,
        ...(pluginAdmission
          ? { validatePreparedPackage: pluginAdmission.validatePreparedPackage }
          : {}),
      });
      syncedWorkspaceNames.push(workspaceName);
    } catch (error) {
      // The package publisher validates its staged tree before replacing the installed
      // package. Keep that exact previous package as last-green while unrelated plugins
      // continue to publish. The complete installed closure is verified below before it
      // can receive a daemon-readiness stamp.
      pluginFailures.push(createBundledPluginPublicationFailure({ repoRoot, packageName, error }));
    }
  }

  const recordedPluginFailures = new Set(
    pluginFailures.map((failure) => failure.packageName),
  );
  for (const failure of failedPluginBuilds) {
    const packageName = failure.packageName;
    if (recordedPluginFailures.has(packageName)) continue;
    pluginFailures.push(failure);
  }

  if (syncedWorkspaceNames.length > 0) {
    syncBundledRuntimeDependencies({
      repoRoot,
      workspaceNames: syncedWorkspaceNames,
    });
  }
  return pluginFailures;
}

export function reconcilePostSyncBundledPluginFailures(repoRoot, syncFailures) {
  if (syncFailures.length === 0) return;
  const failures = new Map(
    readBundledPluginPublicationFailures(repoRoot).map((failure) => [failure.packageName, failure]),
  );
  for (const failure of syncFailures) failures.set(failure.packageName, failure);
  writeBundledPluginPublicationFailures(repoRoot, [...failures.values()]);
}

async function publishPreparedBundledWorkspaceDependenciesForCli(prepared, opts = {}) {
  const {
    resolvedRepoRoot,
    workspaceNames,
    rebuiltPluginWorkspaceNames,
  } = prepared;
  const ensureWorkspacePackagesBuilt =
    opts.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName;
  const publicationEnv = opts.publishBundledPluginArtifactsEnv ?? opts.env ?? process.env;

  let bundledPluginPublicationAttempted = false;
  try {
    bundledPluginPublicationAttempted = await publishBundledPluginArtifactsAfterWorkspaceBuild({
      repoRoot: resolvedRepoRoot,
      workspaceNames: rebuiltPluginWorkspaceNames,
      pluginFailures: prepared.failedPluginBuilds,
      publicationMode: prepared.publicationMode,
      syncId: opts.syncId ?? `build-shared-publish.${process.pid}`,
      syncBundledWorkspaceDistImpl: opts.syncBundledWorkspaceDistImpl,
      env: publicationEnv,
      quiet: opts.quiet === true,
      progress: opts.progress === true,
      bundledPluginArtifactPublication: opts.bundledPluginArtifactPublication
        ?? (String(publicationEnv.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1'
          ? {
              // A one-way execution replica owns the ignored build and installed-package
              // trees consumed by this run. Keep only its excluded installed artifacts
              // and inventories coherent; source-synchronized projections remain read-only.
              mode: 'write',
              targetOwnedOnly: true,
            }
          : undefined),
      publishBundledPluginArtifactsImpl: opts.publishBundledPluginArtifactsImpl,
    });
  } catch (error) {
    if (typeof opts.onBundledPluginPublicationError !== 'function') throw error;
    bundledPluginPublicationAttempted = rebuiltPluginWorkspaceNames.length > 0;
    opts.onBundledPluginPublicationError(error);
  }
  if (bundledPluginPublicationAttempted) {
    await rebuildWorkspacesInvalidatedByBundledPluginPublication({
      repoRoot: resolvedRepoRoot,
      workspaceNames,
      includeUiArtifacts: true,
      env: opts.env ?? process.env,
      quiet: opts.quiet === true,
      includeDevDependencies: false,
      syncId: opts.syncId ?? `build-shared-generated.${process.pid}`,
      ensureWorkspacePackagesBuiltByNameImpl: ensureWorkspacePackagesBuilt,
    });
  }

  return workspaceNames;
}

export async function buildBundledWorkspaceDependenciesForCli(opts = {}) {
  const prepared = await prepareBundledWorkspaceDependenciesForCli(opts);
  return await publishPreparedBundledWorkspaceDependenciesForCli(prepared, opts);
}

function isCurrentRuntimeClosureReusable(options = {}) {
  const inspectCurrent = options.inspectSourceDevSharedDepsForSourceDevImpl
    ?? inspectSourceDevSharedDepsForSourceDev;
  try {
    return inspectCurrent({
      repoRoot: resolveRepoRootOption(options.repoRoot),
      workspaceNames: options.workspaceNames,
      includeRuntimeDependencies: true,
    })?.current === true;
  } catch {
    return false;
  }
}

export async function main(options = {}) {
  if (options.mode === 'declarations' || options.mode === 'source-dev') {
    const syncSharedDeps = options.syncSharedDepsForSourceDevImpl ?? syncSharedDepsForSourceDev;
    return syncSharedDeps({
      ...options,
      includeRuntimeDependencies: options.mode === 'source-dev',
      workspaceNames: options.workspaceNames ?? readSourceDevSharedDepsWorkspaceNamesFromEnv(options.env ?? process.env),
    });
  }

  // The source-dev stamp describes the installed closure. Package derivation
  // remains owned by the content identity at ensureWorkspacePackagesBuilt.
  const publicationMode = resolveSharedDepsPublicationMode(options);
  const publishesArtifact = isArtifactPublicationMode(publicationMode);
  const canReuseCurrentRuntimeClosure = () => (
    !publishesArtifact && isCurrentRuntimeClosureReusable(options)
  );
  if (canReuseCurrentRuntimeClosure()) return;

  const lockOptions = {
    ...options,
    tryResolveWaiter: options.tryResolveWaiter ?? (async () => (
      canReuseCurrentRuntimeClosure()
        ? { resolved: true, value: undefined }
        : { resolved: false }
    )),
  };

  const prepared = await prepareBundledWorkspaceDependenciesForCli({
    ...options,
    publicationMode,
    deferPluginBuildToGenerator: true,
  });
  const buildRepoRoot = prepared.resolvedRepoRoot;
  let bundledPluginPublicationError = null;
  const workspaceNames = await publishPreparedBundledWorkspaceDependenciesForCli(prepared, {
    ...options,
    onBundledPluginPublicationError: (error) => {
      bundledPluginPublicationError = error;
    },
  });
  if (publishesArtifact && bundledPluginPublicationError) {
    throw bundledPluginPublicationError;
  }
  const withLock = options.withBuildSharedDepsLockImpl ?? withBuildSharedDepsLock;
  return withLock(async () => {
    // The closure may have become current before this caller acquired the
    // repository-wide publication lock. Reuse that exact stamped generation
    // instead of rebuilding the same workspace packages again.
    if (canReuseCurrentRuntimeClosure()) return undefined;

    // Resolve helpers after every package/generator writer has completed and
    // after the exact-closure recheck above: a closure another caller made
    // current while this caller waited for the lock must be reused without
    // rebuilding the cli-common helper bundle. Resolving under this lock keeps
    // the shared runtime copy and its helper snapshot one coherent generation.
    const resolveCliCommonHelpers = options.resolveCliCommonWorkspacesHelpersAfterBuildImpl
      ?? resolveCliCommonWorkspacesHelpersAfterBuild;
    const cliCommonWorkspacesModule = await resolveCliCommonHelpers({
      ...options,
      repoRoot: buildRepoRoot,
      env: options.env ?? process.env,
    });

    const protocolDist = resolve(buildRepoRoot, 'packages', 'protocol', 'dist', 'index.js');
    const exists = options.existsSync ?? existsSync;
    if (!exists(protocolDist)) {
      throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
    }

    const readFile = options.readFileSync ?? readFileSync;
    const readDir = options.readdirSync ?? readdirSync;
    const stat = options.statSync ?? statSync;
    const runtimeSignature = computeSourceDevSharedDepsSignature({
      repoRoot: buildRepoRoot,
      workspaceNames,
      includeDevDependencies: false,
      existsSync: exists,
      readFileSync: readFile,
      readdirSync: readDir,
      statSync: stat,
    });
    const runtimeStampPath = options.stampPath ?? resolveSourceDevSharedDepsStampPath(buildRepoRoot);
    const runtimeStamp = readSourceDevSharedDepsStamp(runtimeStampPath, readFile);
    const workspaceNamesToSync = normalizeSourceDevSharedDepsWorkspaceNames([
      ...resolveSourceDevSharedDepsWorkspaceNamesToSync({
        repoRoot: buildRepoRoot,
        stamp: runtimeStamp,
        signature: runtimeSignature,
        exists,
        readFile,
        readDir,
        stat,
      }),
      ...collectInstalledBundledPluginWorkspaceNamesDivergingFromSource({
        repoRoot: buildRepoRoot,
        workspaceNames,
      }),
    ]);

    // If the CLI currently has bundled workspace deps under apps/cli/node_modules,
    // keep their dist outputs in sync so local builds/tests do not consume stale artifacts.
    const syncBundledDist = options.syncBundledWorkspaceDistImpl ?? syncBundledWorkspaceDist;
    const syncBundledRuntimeDependencies = options.syncBundledWorkspaceRuntimeDependenciesImpl
      ?? syncBundledWorkspaceRuntimeDependencies;
    const syncCliDependencies = options.syncCliRuntimeDependenciesImpl ?? syncCliRuntimeDependencies;
    const pluginSyncFailures = syncPreparedRuntimeWorkspacePackages({
      repoRoot: buildRepoRoot,
      workspaceNames: workspaceNamesToSync,
      failedPluginBuilds: prepared.failedPluginBuilds,
      cliCommonWorkspacesModule,
      syncBundledDist,
      syncBundledRuntimeDependencies,
    });
    syncCliDependencies({ repoRoot: buildRepoRoot, ...cliCommonWorkspacesModule });
    // Release publication requires every included package. Live publication
    // projects failed plugins as catalog diagnostics and keeps the host closure.
    const unrecoveredPluginFailures = publishesArtifact
      ? pluginSyncFailures
      : [];
    if (unrecoveredPluginFailures.length > 0) {
      const failureDetails = unrecoveredPluginFailures.map((failure) => (
        `${failure.packageName}: ${failure.diagnostic.message}`
      ));
      throw new AggregateError(
        unrecoveredPluginFailures.map((failure) => new Error(failure.diagnostic.message)),
        '[build-shared] bundled plugin publication build failed: ' + failureDetails.join('; '),
      );
    }
    reconcilePostSyncBundledPluginFailures(buildRepoRoot, pluginSyncFailures);
    if (bundledPluginPublicationError || pluginSyncFailures.length > 0) {
      const reportFallback = options.reportBundledPluginRuntimeFallback
        ?? ((message) => console.warn(message));
      const failedWorkspaceNames = pluginSyncFailures.map((failure) => failure.packageName);
      reportFallback(
        '[build-shared] excluded failed bundled plugin packages after a partial plugin refresh'
        + (failedWorkspaceNames.length > 0
          ? `: ${failedWorkspaceNames.join(', ')}`
          : ''),
      );
    }
    publishSourceDevReadinessAfterRuntimeBuild({
      repoRoot: buildRepoRoot,
      workspaceNames,
      publishSourceDevReadinessFromRuntimeClosureImpl:
        options.publishSourceDevReadinessFromRuntimeClosureImpl,
    });
    // The completed runtime closure remains publishable when newer source has
    // already superseded it. The Stack freshness owner activates that coherent
    // build and schedules the trailing generation; source children separately
    // require a current readiness stamp through their spawn preflight.
  }, lockOptions);
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsMain) {
  const mode = process.argv.includes('--declarations')
    ? 'declarations'
    : process.argv.includes('--source-dev')
      ? 'source-dev'
      : 'runtime';
  const publicationMode = resolveWorkspaceBundlePublicationMode({
    argv: process.argv.slice(2),
    env: process.env,
  });
  main({ mode, publicationMode }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
