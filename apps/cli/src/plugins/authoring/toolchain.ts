import { spawn as spawnChild } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildManagedPnpmEnvironment,
  ensureManagedPnpmCommand,
  managedPnpmBinPath,
} from '@/packagedRuntime/managedTools/pnpm/managedPnpm';
import {
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeBinPath,
} from '@/packagedRuntime/js/managedJavaScriptRuntime';
import {
  resolveAuthoritativePackagedRuntimeProjectRoot,
  type AuthoritativePackagedRuntimeProjectRoot,
} from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import {
  findRepoRoot,
  materializePrepublicationWorkspacePackageRoots,
  readBundledWorkspacePackageNames,
  resolveWorkspaceBundlesFromPackageJson,
} from '@happier-dev/cli-common/workspaces';
import { BUILD_CONFIG_BASENAMES } from '@happier-dev/plugin-sdk/ui/build';

import { readPluginManifest } from '@/plugins/manifest/read';
import {
  findPluginDiagnosticSourceLocation,
  type PluginDiagnosticSourceLocation,
} from '@/plugins/validation/diagnostics/sourceLocation';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import {
  bundlePluginDaemonRuntime,
  PluginAuthorBundlerUnavailableError,
} from './bundleDaemonRuntime';
import {
  cleanupPluginAuthorActionContracts,
  generatePluginActionContracts,
} from './actionContracts';
import { cleanupPluginDaemonOutputManifest } from './daemonOutputManifest';
import { resolveSameInstallNodeModulesRoot } from './packageInstallationRoot';

export type PluginAuthorToolchainOperation = 'install' | 'typecheck' | 'build' | 'test';

export type PluginAuthorToolchainDiagnostic = Readonly<{
  code:
    | 'plugin_author_invalid_input'
    | 'plugin_author_managed_tool_unavailable'
    | 'plugin_author_tool_failed';
  message: string;
  /**
   * Where the author has to look, relative to their own project root. The
   * toolchain runs the compiler and the Plugin UI builder with the project
   * root as cwd, so their reported paths already belong to the author's
   * project — this only reads the first one back out of the tool output and
   * proves it is contained by that root.
   */
  source?: PluginDiagnosticSourceLocation;
}>;

export type PluginAuthorToolchainResult =
  | Readonly<{
      ok: true;
      operation: PluginAuthorToolchainOperation;
      projectRoot: string;
    }>
  | Readonly<{
      ok: false;
      operation: PluginAuthorToolchainOperation;
      projectRoot: string;
      diagnostics: readonly PluginAuthorToolchainDiagnostic[];
    }>;

export type PluginAuthorToolchainSpawnInput = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

export type PluginAuthorToolchainSpawnResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type PluginAuthorToolchainSpawnInvocation = PluginAuthorToolchainSpawnInput & Readonly<{
  windowsVerbatimArguments?: boolean;
}>;

export type PluginAuthorToolchainDeps = Readonly<{
  ensureManagedPnpmCommand: typeof ensureManagedPnpmCommand;
  managedPnpmBinPath: typeof managedPnpmBinPath;
  buildManagedPnpmEnvironment: typeof buildManagedPnpmEnvironment;
  ensureManagedJavaScriptRuntimeCommand: typeof ensureManagedJavaScriptRuntimeCommand;
  managedJavaScriptRuntimeBinPath: typeof managedJavaScriptRuntimeBinPath;
  resolveNativeTypeScriptBin: (projectRoot: string) => string;
  resolvePluginUiBuildBin?: (projectRoot: string) => string | null;
  materializeBundledPrepublicationPackages?: () => Promise<PluginAuthorBundledPrepublicationMaterialization>;
  generatePluginActionContracts?: (params: Readonly<{ projectRoot: string }>) => Promise<void>;
  bundlePluginDaemonRuntime?: (projectRoot: string) => Promise<void>;
  spawn: (input: PluginAuthorToolchainSpawnInput) => Promise<PluginAuthorToolchainSpawnResult>;
  processEnv: NodeJS.ProcessEnv;
}>;

function createDiagnostic(
  code: PluginAuthorToolchainDiagnostic['code'],
  message: string,
  source?: PluginDiagnosticSourceLocation,
): PluginAuthorToolchainDiagnostic {
  return { code, message, ...(source ? { source } : {}) };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizePluginSdkRegistryOrigin(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  const allowed = parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
  if (!allowed || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Plugin SDK registry must be a credential-free HTTPS origin or loopback HTTP origin');
  }
  return parsed.origin;
}

function resolveProjectRoot(pathLike: string): string {
  const trimmed = pathLike.trim();
  if (!trimmed) throw new Error('Plugin author project root is required');
  return resolve(trimmed);
}

const PLUGIN_SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const PLUGIN_UI_PACKAGE_NAME = '@happier-dev/plugin-ui';
/**
 * Every workspace package the public scaffold can declare at the prepublication
 * version. `plugins create --ui reactNative` emits the Plugin UI package next to
 * the SDK and neither is published to the public registry yet, so dependency
 * preparation recognizes those author declarations without a registry origin.
 */
const PREPUBLICATION_AUTHOR_PACKAGE_NAMES = [
  PLUGIN_SDK_PACKAGE_NAME,
  PLUGIN_UI_PACKAGE_NAME,
] as const;
const PREPUBLICATION_PLUGIN_SDK_VERSION = '0.0.0';
const TRANSIENT_PNPM_WORKSPACE_FILE_NAME = 'pnpm-workspace.yaml';

export type PluginAuthorBundledPrepublicationMaterialization = Readonly<{
  packageRootsByName: ReadonlyMap<string, string>;
  cleanup: () => Promise<void>;
}>;

type RuntimePackageJson = Readonly<{
  name?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPackageJsonRecord(packageJsonPath: string, description: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return parsed;
}

function isSourceRuntimeAuthority(authority: AuthoritativePackagedRuntimeProjectRoot): boolean {
  return authority.provenance === 'source-module' || authority.provenance === 'source-snapshot';
}

function readRuntimePackageJson(runtimeRoot: string): RuntimePackageJson {
  const packageJsonPath = realpathSync(join(runtimeRoot, 'package.json'));
  if (!isCanonicalAbsolutePathInsideRoot(runtimeRoot, packageJsonPath)) {
    throw new Error('The running Happier CLI package manifest escapes its runtime root');
  }
  return readPackageJsonRecord(packageJsonPath, 'The running Happier CLI package manifest');
}

export function assertPluginAuthorPrepublicationRuntimeDeclarations(runtimeRoot: string): void {
  const packageJson = readRuntimePackageJson(runtimeRoot);
  const dependencies = packageJson.dependencies;
  const declaredDependencies = dependencies
    && typeof dependencies === 'object'
    && !Array.isArray(dependencies)
    ? (dependencies as Record<string, unknown>)
    : {};
  const bundledDependencies = new Set(
    Array.isArray(packageJson.bundledDependencies)
      ? packageJson.bundledDependencies.filter((value): value is string => typeof value === 'string')
      : [],
  );
  if (packageJson.name !== '@happier-dev/cli') {
    throw new Error('The running Happier CLI does not declare its Plugin SDK runtime dependency');
  }
  for (const packageName of PREPUBLICATION_AUTHOR_PACKAGE_NAMES) {
    const declaredVersion = declaredDependencies[packageName];
    if (
      (typeof declaredVersion !== 'string' || declaredVersion.trim().length === 0)
      && !bundledDependencies.has(packageName)
    ) {
      throw new Error(`The running Happier CLI does not declare its '${packageName}' runtime dependency`);
    }
  }
}

function resolvePhysicalBundledWorkspacePackageRoot(params: Readonly<{
  candidatePath: string;
  allowedRootPath: string;
  packageName: string;
}>): string | null {
  try {
    const candidateStats = lstatSync(params.candidatePath);
    if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) return null;
    const physicalPackageRoot = realpathSync(params.candidatePath);
    const physicalAllowedRoot = realpathSync(params.allowedRootPath);
    if (!isCanonicalAbsolutePathInsideRoot(physicalAllowedRoot, physicalPackageRoot)) return null;
    const packageJsonPath = realpathSync(join(physicalPackageRoot, 'package.json'));
    if (!isCanonicalAbsolutePathInsideRoot(physicalPackageRoot, packageJsonPath) || !statSync(packageJsonPath).isFile()) {
      return null;
    }
    const packageJson = readPackageJsonRecord(
      packageJsonPath,
      `Bundled workspace package '${params.packageName}' manifest`,
    );
    return packageJson.name === params.packageName ? physicalPackageRoot : null;
  } catch {
    return null;
  }
}

function resolvePackagedCliBundledWorkspacePackageRoot(
  runtimeRoot: string,
  packageName: string,
): string {
  const candidateRoots: Array<Readonly<{ candidatePath: string; allowedRootPath: string }>> = [{
    candidatePath: join(runtimeRoot, 'node_modules', ...packageName.split('/')),
    allowedRootPath: runtimeRoot,
  }];
  const sameInstallNodeModulesRoot = resolveSameInstallNodeModulesRoot(runtimeRoot);
  if (sameInstallNodeModulesRoot) {
    candidateRoots.push({
      candidatePath: join(sameInstallNodeModulesRoot, ...packageName.split('/')),
      allowedRootPath: sameInstallNodeModulesRoot,
    });
  }
  for (const candidate of candidateRoots) {
    const packageRoot = resolvePhysicalBundledWorkspacePackageRoot({ ...candidate, packageName });
    if (packageRoot) return packageRoot;
  }
  throw new Error(`The running Happier CLI has no physical bundled '${packageName}' dependency`);
}

type PrepublicationWorkspaceBundle = Parameters<
  typeof materializePrepublicationWorkspacePackageRoots
>[0]['bundles'][number];

function remapWorkspaceBundleDestinations(params: Readonly<{
  materializationRoot: string;
  bundles: ReadonlyArray<PrepublicationWorkspaceBundle>;
}>): PrepublicationWorkspaceBundle[] {
  return params.bundles.map((bundle) => ({
    ...bundle,
    destDir: join(params.materializationRoot, 'node_modules', ...bundle.packageName.split('/')),
  }));
}

function resolveMaterializedPrepublicationAuthorPackageRoots(
  materializationRoot: string,
): ReadonlyMap<string, string> {
  return new Map(PREPUBLICATION_AUTHOR_PACKAGE_NAMES.map((packageName) => {
    const packageRoot = resolvePhysicalBundledWorkspacePackageRoot({
      candidatePath: join(materializationRoot, 'node_modules', ...packageName.split('/')),
      allowedRootPath: materializationRoot,
      packageName,
    });
    if (!packageRoot) {
      throw new Error(`The running Happier CLI could not materialize a complete '${packageName}' package`);
    }
    try {
      const runtimeEntrypoint = realpathSync(join(packageRoot, 'dist', 'index.js'));
      const declarationEntrypoint = realpathSync(join(packageRoot, 'dist', 'index.d.ts'));
      if (
        !isCanonicalAbsolutePathInsideRoot(packageRoot, runtimeEntrypoint)
        || !isCanonicalAbsolutePathInsideRoot(packageRoot, declarationEntrypoint)
        || !statSync(runtimeEntrypoint).isFile()
        || !statSync(declarationEntrypoint).isFile()
      ) {
        throw new Error('missing contained package entrypoints');
      }
    } catch {
      throw new Error(`The running Happier CLI could not materialize a complete '${packageName}' package`);
    }
    return [packageName, packageRoot] as const;
  }));
}

async function materializePrepublicationAuthorWorkspacePackages(params: Readonly<{
  bundles: ReadonlyArray<PrepublicationWorkspaceBundle>;
}>): Promise<PluginAuthorBundledPrepublicationMaterialization> {
  const materializationRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-prepublication-'));
  try {
    materializePrepublicationWorkspacePackageRoots({
      bundles: remapWorkspaceBundleDestinations({ materializationRoot, bundles: params.bundles }),
    });
    return Object.freeze({
      packageRootsByName: resolveMaterializedPrepublicationAuthorPackageRoots(materializationRoot),
      cleanup: async () => await rm(materializationRoot, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(materializationRoot, { recursive: true, force: true });
    throw error;
  }
}

async function materializeSourceCliBundledPrepublicationPackages(
  runtimeRoot: string,
): Promise<PluginAuthorBundledPrepublicationMaterialization> {
  return await materializePrepublicationAuthorWorkspacePackages({
    bundles: resolveWorkspaceBundlesFromPackageJson({
      repoRoot: findRepoRoot(runtimeRoot),
      hostPackageDir: runtimeRoot,
    }),
  });
}

function resolvePackagedCliBundledWorkspaceBundles(params: Readonly<{
  runtimeRoot: string;
  runtimePackageJson: RuntimePackageJson;
}>): PrepublicationWorkspaceBundle[] {
  const packageNames = readBundledWorkspacePackageNames(params.runtimePackageJson);
  if (packageNames.length === 0) {
    throw new Error('The running Happier CLI does not declare bundled internal workspace dependencies');
  }
  return packageNames.map((packageName) => ({
    packageName,
    srcDir: resolvePackagedCliBundledWorkspacePackageRoot(params.runtimeRoot, packageName),
    destDir: join(params.runtimeRoot, 'node_modules', ...packageName.split('/')),
  }));
}

async function materializePackagedCliBundledPrepublicationPackages(params: Readonly<{
  runtimeRoot: string;
  runtimePackageJson: RuntimePackageJson;
}>): Promise<PluginAuthorBundledPrepublicationMaterialization> {
  return await materializePrepublicationAuthorWorkspacePackages({
    bundles: resolvePackagedCliBundledWorkspaceBundles(params),
  });
}

async function materializeBundledPrepublicationPackages(): Promise<PluginAuthorBundledPrepublicationMaterialization> {
  const runtimeAuthority = resolveAuthoritativePackagedRuntimeProjectRoot();
  if (!runtimeAuthority) {
    throw new Error('The running Happier CLI runtime root is unavailable for Plugin SDK resolution');
  }
  const runtimeRoot = realpathSync(runtimeAuthority.root);
  assertPluginAuthorPrepublicationRuntimeDeclarations(runtimeRoot);
  const runtimePackageJson = readRuntimePackageJson(runtimeRoot);
  if (isSourceRuntimeAuthority(runtimeAuthority)) {
    return await materializeSourceCliBundledPrepublicationPackages(runtimeRoot);
  }
  return await materializePackagedCliBundledPrepublicationPackages({
    runtimeRoot,
    runtimePackageJson,
  });
}

function readDependencySpecifier(
  packageJson: unknown,
  dependencyName: string,
): string | null {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) return null;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const dependencies = (packageJson as Record<string, unknown>)[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    const specifier = (dependencies as Record<string, unknown>)[dependencyName];
    if (typeof specifier === 'string') return specifier.trim();
  }
  return null;
}

async function requiresBundledPrepublicationResolution(params: Readonly<{
  projectRoot: string;
  registryOrigin: string | null;
  args: readonly string[];
}>): Promise<boolean> {
  if (params.registryOrigin || params.args[0] !== 'install') return false;
  try {
    const packageJson = JSON.parse(await readFile(join(params.projectRoot, 'package.json'), 'utf8')) as unknown;
    return PREPUBLICATION_AUTHOR_PACKAGE_NAMES.some((packageName) => (
      readDependencySpecifier(packageJson, packageName) === PREPUBLICATION_PLUGIN_SDK_VERSION
    ));
  } catch {
    // Let the managed package materializer report malformed or missing author
    // package metadata through its normal diagnostic path.
    return false;
  }
}

function withTransientBundledPluginSdkInstallArgs(args: readonly string[]): readonly string[] {
  if (args[0] !== 'install') return args;
  const withoutLockfileConflicts = args.filter((arg) => (
    arg !== '--frozen-lockfile'
    && !arg.startsWith('--frozen-lockfile=')
    && !arg.startsWith('--lockfile=')
  ));
  return [...withoutLockfileConflicts, '--lockfile=false'];
}

async function writeTransientBundledPrepublicationWorkspaceConfig(params: Readonly<{
  projectRoot: string;
  packageRootsByName: ReadonlyMap<string, string>;
}>): Promise<() => Promise<void>> {
  const workspaceConfigPath = join(params.projectRoot, TRANSIENT_PNPM_WORKSPACE_FILE_NAME);
  const contents = [
    'overrides:',
    ...[...params.packageRootsByName]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([packageName, packageRoot]) => (
        `  ${JSON.stringify(packageName)}: ${JSON.stringify(pathToFileURL(packageRoot).href)}`
      )),
    '',
  ].join('\n');
  try {
    await lstat(workspaceConfigPath);
    throw new Error('Plugin SDK prepublication resolution refuses to replace an author-owned pnpm workspace configuration');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }

  try {
    await writeFile(workspaceConfigPath, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      throw new Error('Plugin SDK prepublication resolution refuses to replace an author-owned pnpm workspace configuration');
    }
    throw error;
  }

  return async () => {
    let currentContents: string;
    try {
      currentContents = await readFile(workspaceConfigPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
      throw error;
    }
    if (currentContents !== contents) {
      throw new Error('Plugin SDK prepublication workspace configuration changed during dependency preparation');
    }
    await rm(workspaceConfigPath);
  };
}

async function prepareBundledPrepublicationResolution(params: Readonly<{
  projectRoot: string;
  registryOrigin: string | null;
  args: readonly string[];
  signal?: AbortSignal;
  materialize: () => Promise<PluginAuthorBundledPrepublicationMaterialization>;
}>): Promise<Readonly<{
  args: readonly string[];
  cleanup: () => Promise<void>;
}> | null> {
  if (!await requiresBundledPrepublicationResolution(params)) return null;
  // Preserve managed-pnpm cancellation semantics: a command that has already
  // been cancelled must reach the managed process with its signal instead of
  // first paying for a transient physical SDK materialization.
  if (params.signal?.aborted) return null;
  const materialization = await params.materialize();
  if (params.signal?.aborted) {
    await materialization.cleanup();
    return null;
  }
  try {
    const cleanupWorkspaceConfig = await writeTransientBundledPrepublicationWorkspaceConfig({
      projectRoot: params.projectRoot,
      packageRootsByName: materialization.packageRootsByName,
    });
    return Object.freeze({
      args: withTransientBundledPluginSdkInstallArgs(params.args),
      cleanup: async () => {
        try {
          await cleanupWorkspaceConfig();
        } finally {
          await materialization.cleanup();
        }
      },
    });
  } catch (error) {
    await materialization.cleanup();
    throw error;
  }
}

export function resolveNativeTypeScriptBin(projectRoot: string): string {
  const require = createRequire(join(projectRoot, 'package.json'));
  const packageJsonPath = require.resolve('@typescript/native/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: { tsc?: unknown };
    version?: unknown;
  };
  const projectNodeModulesRoot = join(realpathSync(projectRoot), 'node_modules');
  if (!isCanonicalAbsolutePathInsideRoot(projectNodeModulesRoot, packageJsonPath)) {
    throw new Error('Resolved @typescript/native package must be project-local');
  }
  if (typeof packageJson.version !== 'string' || !/^7\./u.test(packageJson.version)) {
    throw new Error('Resolved @typescript/native package must provide TypeScript 7');
  }
  const relativeBin = packageJson.bin?.tsc;
  if (typeof relativeBin !== 'string' || !relativeBin.trim()) {
    throw new Error('@typescript/native does not declare the TypeScript compiler entrypoint');
  }
  const packageRoot = realpathSync(dirname(packageJsonPath));
  if (!isCanonicalAbsolutePathInsideRoot(projectNodeModulesRoot, packageRoot)) {
    throw new Error('Resolved @typescript/native package root must remain inside project-local node_modules');
  }
  const compilerPath = resolve(packageRoot, relativeBin);
  if (!isCanonicalAbsolutePathInsideRoot(packageRoot, compilerPath)) {
    throw new Error('Resolved TypeScript compiler entrypoint must remain inside the installed @typescript/native package');
  }
  const resolvedCompilerPath = realpathSync(compilerPath);
  if (!statSync(resolvedCompilerPath).isFile() || !isCanonicalAbsolutePathInsideRoot(packageRoot, resolvedCompilerPath)) {
    throw new Error('Resolved TypeScript compiler entrypoint must be a contained regular file inside @typescript/native');
  }
  return resolvedCompilerPath;
}

export function resolvePluginUiBuildBin(projectRoot: string): string | null {
  const resolvedProjectRoot = realpathSync(projectRoot);
  const hasUiBuildConfig = BUILD_CONFIG_BASENAMES.some((basename) => {
    try {
      statSync(join(resolvedProjectRoot, basename));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
      throw error;
    }
  });
  if (!hasUiBuildConfig) {
    return null;
  }

  const projectNodeModulesRoot = realpathSync(join(resolvedProjectRoot, 'node_modules'));
  const packageJsonPath = realpathSync(join(
    resolvedProjectRoot,
    'node_modules',
    '@happier-dev',
    'plugin-sdk',
    'package.json',
  ));
  if (!isCanonicalAbsolutePathInsideRoot(projectNodeModulesRoot, packageJsonPath)) {
    throw new Error('Resolved Plugin SDK package must be project-local');
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    bin?: Record<string, unknown>;
  };
  if (packageJson.name !== '@happier-dev/plugin-sdk') {
    throw new Error('Resolved Plugin UI builder must come from @happier-dev/plugin-sdk');
  }
  const relativeBin = packageJson.bin?.['happier-plugin-build-ui'];
  if (typeof relativeBin !== 'string' || !relativeBin.trim()) {
    throw new Error('@happier-dev/plugin-sdk does not declare the Plugin UI builder entrypoint');
  }
  const packageRoot = dirname(packageJsonPath);
  const builderPath = resolve(packageRoot, relativeBin);
  if (!isCanonicalAbsolutePathInsideRoot(packageRoot, builderPath)) {
    throw new Error('Resolved Plugin UI builder entrypoint must remain inside @happier-dev/plugin-sdk');
  }
  const resolvedBuilderPath = realpathSync(builderPath);
  if (!statSync(resolvedBuilderPath).isFile() || !isCanonicalAbsolutePathInsideRoot(packageRoot, resolvedBuilderPath)) {
    throw new Error('Resolved Plugin UI builder entrypoint must be a contained regular file');
  }
  return resolvedBuilderPath;
}

export function resolvePluginAuthorToolchainSpawnInvocation(
  input: PluginAuthorToolchainSpawnInput,
): PluginAuthorToolchainSpawnInvocation {
  const invocation = resolveWindowsCommandInvocation({
    command: input.command,
    args: input.args,
    env: input.env,
  });
  return {
    ...input,
    command: invocation.command,
    args: invocation.args,
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  };
}

async function spawn(input: PluginAuthorToolchainSpawnInput): Promise<PluginAuthorToolchainSpawnResult> {
  const invocation = resolvePluginAuthorToolchainSpawnInvocation(input);
  return await new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawnChild(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', rejectSpawn);
    child.once('close', (exitCode, signal) => resolveSpawn({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const defaultDeps: PluginAuthorToolchainDeps = {
  ensureManagedPnpmCommand,
  managedPnpmBinPath,
  buildManagedPnpmEnvironment,
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeBinPath,
  resolveNativeTypeScriptBin,
  resolvePluginUiBuildBin,
  materializeBundledPrepublicationPackages,
  generatePluginActionContracts,
  bundlePluginDaemonRuntime,
  spawn,
  processEnv: process.env,
};

export type ManagedPluginPnpmRunResult =
  | Readonly<{ ok: true; result: PluginAuthorToolchainSpawnResult }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The sole author-root dependency preparation owner. Every author command
 * that resolves project-local tooling reaches this function before evaluation,
 * compilation, testing, or packing begins. Daemon development materialization
 * intentionally owns a separate preparation of its isolated candidate copy.
 */
export type PluginAuthorDependencyPreparationResult =
  | Readonly<{
      ok: true;
      projectRoot: string;
    }>
  | Readonly<{
      ok: false;
      projectRoot: string;
      diagnostic: PluginAuthorToolchainDiagnostic;
    }>;

export async function runManagedPluginPnpm(
  params: Readonly<{
    projectRoot: string;
    args: readonly string[];
    sdkRegistryOrigin?: string | null;
    signal?: AbortSignal;
  }>,
  deps: Pick<
    PluginAuthorToolchainDeps,
    | 'ensureManagedPnpmCommand'
    | 'managedPnpmBinPath'
    | 'buildManagedPnpmEnvironment'
    | 'materializeBundledPrepublicationPackages'
    | 'spawn'
    | 'processEnv'
  > = defaultDeps,
): Promise<ManagedPluginPnpmRunResult> {
  const projectRoot = resolveProjectRoot(params.projectRoot);
  const registryOrigin = normalizePluginSdkRegistryOrigin(params.sdkRegistryOrigin);
  const pnpmCommand = await deps.ensureManagedPnpmCommand(deps.processEnv);
  if (!pnpmCommand) {
    return { ok: false, message: 'The Happier-managed package materializer is unavailable' };
  }
  if (!isApprovedManagedPnpmCommand(pnpmCommand, deps.managedPnpmBinPath(deps.processEnv))) {
    return {
      ok: false,
      message: 'Plugin dependency installation refuses a PATH package-manager fallback; the Happier-managed package materializer is required',
    };
  }
  const prepublicationResolution = await prepareBundledPrepublicationResolution({
    projectRoot,
    registryOrigin,
    args: params.args,
    ...(params.signal ? { signal: params.signal } : {}),
    materialize: deps.materializeBundledPrepublicationPackages ?? materializeBundledPrepublicationPackages,
  });
  try {
    return {
      ok: true,
      result: await deps.spawn({
        command: pnpmCommand,
        args: [
          ...(prepublicationResolution?.args ?? params.args),
          ...(registryOrigin ? [`--config.@happier-dev:registry=${registryOrigin}`] : []),
        ],
        cwd: projectRoot,
        env: deps.buildManagedPnpmEnvironment(deps.processEnv),
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    };
  } finally {
    await prepublicationResolution?.cleanup();
  }
}

/**
 * Cheap idempotent probe for a materialized author root. It answers only
 * whether the package materializer has already produced a resolvable package
 * tree in the directory the author edits, so the dev loop can prepare an author
 * root exactly once instead of reinstalling on every watch start. Refreshing a
 * stale tree stays the explicit job of `happier plugins author install`.
 *
 * A bare `node_modules` is not that evidence: the managed package materializer
 * creates its store directory before any package lands, so an interrupted first
 * `plugins dev` leaves a directory that looks materialized and resolves nothing
 * the author declared. The probe therefore stats the one dependency every
 * scaffold declares, which exists only once its bytes are really in place.
 */
export async function isPluginAuthorRootMaterialized(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(join(
      resolveProjectRoot(projectRoot),
      'node_modules',
      PLUGIN_SDK_PACKAGE_NAME,
      'package.json',
    ))).isFile();
  } catch {
    return false;
  }
}

export async function preparePluginAuthorDependencies(
  params: Readonly<{
    projectRoot: string;
    sdkRegistryOrigin?: string | null;
    signal?: AbortSignal;
  }>,
  deps: Pick<
    PluginAuthorToolchainDeps,
    | 'ensureManagedPnpmCommand'
    | 'managedPnpmBinPath'
    | 'buildManagedPnpmEnvironment'
    | 'spawn'
    | 'processEnv'
  > = defaultDeps,
): Promise<PluginAuthorDependencyPreparationResult> {
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(params.projectRoot);
  } catch (error) {
    return {
      ok: false,
      projectRoot: params.projectRoot,
      diagnostic: createDiagnostic(
        'plugin_author_invalid_input',
        error instanceof Error ? error.message : 'Plugin author project root is invalid',
      ),
    };
  }

  try {
    const managedPnpm = await runManagedPluginPnpm({
      projectRoot,
      args: ['install', '--ignore-scripts'],
      sdkRegistryOrigin: params.sdkRegistryOrigin,
      ...(params.signal ? { signal: params.signal } : {}),
    }, deps);
    if (!managedPnpm.ok) {
      return {
        ok: false,
        projectRoot,
        diagnostic: createDiagnostic('plugin_author_managed_tool_unavailable', managedPnpm.message),
      };
    }
    if (managedPnpm.result.exitCode !== 0 || managedPnpm.result.signal !== null) {
      return {
        ok: false,
        projectRoot,
        diagnostic: processFailureDiagnostic({
          operation: 'install',
          projectRoot,
          code: 'plugin_author_tool_failed',
          result: managedPnpm.result,
        }),
      };
    }
    return { ok: true, projectRoot };
  } catch (error) {
    return {
      ok: false,
      projectRoot,
      diagnostic: createDiagnostic(
        'plugin_author_tool_failed',
        error instanceof Error ? error.message : 'Plugin author dependency preparation failed',
      ),
    };
  }
}

/**
 * The one failed-toolchain result builder. It takes a finished diagnostic so a
 * source location resolved upstream — by `processFailureDiagnostic` or by
 * dependency preparation — reaches the author instead of being flattened back
 * into a code and a message here.
 */
function failedResult(params: Readonly<{
  operation: PluginAuthorToolchainOperation;
  projectRoot: string;
  diagnostic: PluginAuthorToolchainDiagnostic;
}>): PluginAuthorToolchainResult {
  return {
    ok: false,
    operation: params.operation,
    projectRoot: params.projectRoot,
    diagnostics: [params.diagnostic],
  };
}

function processFailureMessage(operation: PluginAuthorToolchainOperation, result: PluginAuthorToolchainSpawnResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const suffix = detail ? `: ${detail}` : '';
  return `Plugin author ${operation} failed with ${result.signal ?? result.exitCode ?? 'unknown status'}${suffix}`;
}

/**
 * The one author-facing projection of a failed toolchain process. The compiler,
 * the test runner, and the Plugin UI builder all report `file(line,column)` or
 * `file:line:column` relative to the project root they were spawned in, so the
 * first contained location in their output is the line the author must fix.
 * `stderr` is read before `stdout` because a tool that separates them puts the
 * failure there.
 */
function processFailureDiagnostic(params: Readonly<{
  operation: PluginAuthorToolchainOperation;
  projectRoot: string;
  code: PluginAuthorToolchainDiagnostic['code'];
  result: PluginAuthorToolchainSpawnResult;
}>): PluginAuthorToolchainDiagnostic {
  const source = findPluginDiagnosticSourceLocation({
    texts: [params.result.stderr, params.result.stdout],
    sourceRoot: params.projectRoot,
  });
  return createDiagnostic(
    params.code,
    processFailureMessage(params.operation, params.result),
    source ?? undefined,
  );
}

function isApprovedManagedPnpmCommand(
  command: string,
  expectedManagedPath: string,
): boolean {
  const normalizePath = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return expectedManagedPath.trim().length > 0
    && normalizePath(command) === normalizePath(expectedManagedPath.trim());
}

function isApprovedManagedJavaScriptRuntimeCommand(
  command: string,
  expectedManagedPath: string,
): boolean {
  const normalizePath = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return expectedManagedPath.trim().length > 0
    && normalizePath(command) === normalizePath(expectedManagedPath.trim());
}

export type PluginAuthorDaemonBuildClassification = 'required' | 'not-required';

/**
 * Removes outputs owned by the executable authoring pipeline when a manifest
 * transitions to a descriptor/UI-only shape. Ownership comes from the exact
 * prior-bundle manifest and marker-owned Action contracts, never from a
 * source-owned pathname convention.
 */
export async function cleanupPluginAuthorGeneratedArtifacts(projectRoot: string): Promise<void> {
  const resolvedProjectRoot = resolveProjectRoot(projectRoot);
  await cleanupPluginDaemonOutputManifest(resolvedProjectRoot);
  await cleanupPluginAuthorActionContracts(resolvedProjectRoot);
}

/**
 * Classifies daemon staging from the canonical cold manifest when one exists.
 *
 * A directory with no cold manifest is the code-defined author shape, so its
 * executable module remains authoritative and the daemon bundler must run. A
 * valid cold manifest without an executable entrypoint is descriptor/UI-only;
 * compiling its source and building its declared UI surface must not require a
 * named `manifest`/`activate` module. A development entrypoint is valid for
 * local source execution, but cannot produce a publishable author artifact;
 * reject that shape here before compiler, Action, UI, or daemon publication.
 */
export async function classifyPluginAuthorDaemonBuild(
  projectRoot: string,
): Promise<PluginAuthorDaemonBuildClassification> {
  const manifestPath = join(projectRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
  const manifestRead = await readPluginManifest({ manifestPath });
  if (!manifestRead.ok) {
    if (manifestRead.diagnostics.every((diagnostic) => diagnostic.code === 'plugin_manifest_missing')) {
      return 'required';
    }
    throw new Error(manifestRead.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  if (manifestRead.manifest.entrypoints?.daemon) return 'required';
  if (manifestRead.manifest.entrypoints?.development) {
    throw new Error(
      'Plugin production build requires entrypoints.daemon; entrypoints.development is source-runtime only',
    );
  }
  return 'not-required';
}

async function bundlePluginDaemonRuntimeIfRequired(
  projectRoot: string,
  deps: PluginAuthorToolchainDeps,
  classification?: PluginAuthorDaemonBuildClassification,
): Promise<void> {
  if ((classification ?? await classifyPluginAuthorDaemonBuild(projectRoot)) !== 'required') return;
  await (deps.bundlePluginDaemonRuntime ?? bundlePluginDaemonRuntime)(projectRoot);
}

export type PluginUiArtifactBuildResult =
  | Readonly<{
      ok: true;
      projectRoot: string;
      /** False when the project declares no plugin UI build config: nothing to build. */
      built: boolean;
    }>
  | Readonly<{
      ok: false;
      projectRoot: string;
      diagnostics: readonly PluginAuthorToolchainDiagnostic[];
    }>;

/**
 * Run the canonical plugin UI artifact build (`happier-plugin-build-ui`) for one
 * author project.
 *
 * This is the single owner of "produce the plugin's UI artifact tree". Both
 * `happier plugins author build` and the `happier plugins dev` watch loop call
 * it; daemon-owned development materialization needs it WITHOUT the TypeScript
 * emit and daemon bundling steps, because a development plugin's daemon half
 * runs from source. The CLI development loop only observes and submits edits.
 */
export async function runPluginUiArtifactBuild(
  params: Readonly<{ projectRoot: string; signal?: AbortSignal }>,
  deps: PluginAuthorToolchainDeps = defaultDeps,
): Promise<PluginUiArtifactBuildResult> {
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(params.projectRoot);
  } catch (error) {
    return {
      ok: false,
      projectRoot: params.projectRoot,
      diagnostics: [createDiagnostic(
        'plugin_author_invalid_input',
        error instanceof Error ? error.message : 'Plugin author project root is invalid',
      )],
    };
  }

  let uiBuildBin: string | null;
  try {
    uiBuildBin = (deps.resolvePluginUiBuildBin ?? resolvePluginUiBuildBin)(projectRoot);
  } catch (error) {
    return {
      ok: false,
      projectRoot,
      diagnostics: [createDiagnostic(
        'plugin_author_tool_failed',
        error instanceof Error ? error.message : 'Plugin UI build tooling is unavailable',
      )],
    };
  }
  if (!uiBuildBin) {
    return { ok: true, projectRoot, built: false };
  }

  const runtimeCommand = await deps.ensureManagedJavaScriptRuntimeCommand(deps.processEnv);
  if (
    !runtimeCommand
    || !isApprovedManagedJavaScriptRuntimeCommand(
      runtimeCommand,
      deps.managedJavaScriptRuntimeBinPath(deps.processEnv),
    )
  ) {
    return {
      ok: false,
      projectRoot,
      diagnostics: [createDiagnostic(
        'plugin_author_managed_tool_unavailable',
        'The Happier-managed JavaScript runtime is unavailable',
      )],
    };
  }

  const result = await deps.spawn({
    command: runtimeCommand,
    args: [uiBuildBin, '--project-root', projectRoot],
    cwd: projectRoot,
    env: deps.processEnv,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    return {
      ok: false,
      projectRoot,
      diagnostics: [processFailureDiagnostic({
        operation: 'build',
        projectRoot,
        code: 'plugin_author_tool_failed',
        result,
      })],
    };
  }
  return { ok: true, projectRoot, built: true };
}

export async function runPluginAuthorToolchain(
  params: Readonly<{
    operation: PluginAuthorToolchainOperation;
    projectRoot: string;
    sdkRegistryOrigin?: string | null;
    signal?: AbortSignal;
  }>,
  deps: PluginAuthorToolchainDeps = defaultDeps,
): Promise<PluginAuthorToolchainResult> {
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(params.projectRoot);
  } catch (error) {
    return failedResult({
      operation: params.operation,
      projectRoot: params.projectRoot,
      diagnostic: createDiagnostic(
        'plugin_author_invalid_input',
        error instanceof Error ? error.message : 'Plugin author project root is invalid',
      ),
    });
  }

  try {
    let invocation: PluginAuthorToolchainSpawnInput;
    let daemonBuildClassification: PluginAuthorDaemonBuildClassification | undefined;
    let runtimeCommand: string | undefined;
    if (params.operation !== 'install') {
      if (params.operation === 'build' || params.operation === 'test') {
        // Reject an author shape that cannot be built before mutating its
        // dependency tree. This validates the command boundary; it is not a
        // compiler or candidate-materialization step.
        daemonBuildClassification = await classifyPluginAuthorDaemonBuild(projectRoot);
      }
      const resolvedRuntimeCommand = await deps.ensureManagedJavaScriptRuntimeCommand(deps.processEnv);
      if (!resolvedRuntimeCommand) {
        return failedResult({
          operation: params.operation,
          projectRoot,
          diagnostic: createDiagnostic(
            'plugin_author_managed_tool_unavailable',
            'The Happier-managed JavaScript runtime is unavailable',
          ),
        });
      }
      if (!isApprovedManagedJavaScriptRuntimeCommand(
        resolvedRuntimeCommand,
        deps.managedJavaScriptRuntimeBinPath(deps.processEnv),
      )) {
        return failedResult({
          operation: params.operation,
          projectRoot,
          diagnostic: createDiagnostic(
            'plugin_author_managed_tool_unavailable',
            'Plugin author checks refuse the host process runtime; the Happier-managed JavaScript runtime is required',
          ),
        });
      }
      runtimeCommand = resolvedRuntimeCommand;
    }

    const dependencyPreparation = await preparePluginAuthorDependencies({
      projectRoot,
      sdkRegistryOrigin: params.sdkRegistryOrigin,
      ...(params.signal ? { signal: params.signal } : {}),
    }, deps);
    if (!dependencyPreparation.ok) {
      return failedResult({
        operation: params.operation,
        projectRoot: dependencyPreparation.projectRoot,
        diagnostic: dependencyPreparation.diagnostic,
      });
    }
    if (params.operation === 'install') {
      return { ok: true, operation: params.operation, projectRoot: dependencyPreparation.projectRoot };
    }
    projectRoot = dependencyPreparation.projectRoot;
    if (!runtimeCommand) {
      return failedResult({
        operation: params.operation,
        projectRoot,
        diagnostic: createDiagnostic(
          'plugin_author_managed_tool_unavailable',
          'The Happier-managed JavaScript runtime is unavailable',
        ),
      });
    }

    // A successful preparation is the boundary after which every project-local
    // compiler, test, UI builder, or bundle resolution may begin.
    if (daemonBuildClassification === 'not-required') {
      // Remove only prior executable outputs before TypeScript emits the
      // current descriptor/UI build. Fresh compiler output is not stale.
      await cleanupPluginAuthorGeneratedArtifacts(projectRoot);
    } else if (daemonBuildClassification === 'required') {
      // Retire the preceding daemon bundle before TypeScript can reuse one of
      // its former paths as current author output. The subsequent bundle
      // writes one fresh exact-output claim; retaining a cumulative claim
      // would later delete that compiler-owned path on a descriptor transition.
      await cleanupPluginDaemonOutputManifest(projectRoot);
    }

    {
      if (params.operation === 'test') {
        const compilerPath = deps.resolveNativeTypeScriptBin(projectRoot);
        const compileResult = await deps.spawn({
          command: runtimeCommand,
          args: [compilerPath, '-p', 'tsconfig.json'],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (compileResult.exitCode !== 0 || compileResult.signal !== null) {
          return failedResult({
            operation: params.operation,
            projectRoot,
            diagnostic: processFailureDiagnostic({
              operation: params.operation,
              projectRoot,
              code: 'plugin_author_tool_failed',
              result: compileResult,
            }),
          });
        }
        await bundlePluginDaemonRuntimeIfRequired(projectRoot, deps, daemonBuildClassification);
        invocation = {
          command: runtimeCommand,
          args: ['--test', 'test/index.test.mjs'],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        };
      } else {
        const compilerPath = deps.resolveNativeTypeScriptBin(projectRoot);
        invocation = {
          command: runtimeCommand,
          args: [
            compilerPath,
            ...(params.operation === 'typecheck' ? ['--noEmit'] : []),
            '-p',
            'tsconfig.json',
          ],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        };
      }
    }

    const result = await deps.spawn(invocation);
    if (result.exitCode !== 0 || result.signal !== null) {
      return failedResult({
        operation: params.operation,
        projectRoot,
        diagnostic: processFailureDiagnostic({
          operation: params.operation,
          projectRoot,
          code: 'plugin_author_tool_failed',
          result,
        }),
      });
    }
    if (params.operation === 'build') {
      const buildClassification = daemonBuildClassification ?? 'required';
      if (buildClassification === 'required' && deps.generatePluginActionContracts) {
        // The author build owns the one generated Action-contract projection;
        // pack may rerun this same owner against its evaluated value.
        await deps.generatePluginActionContracts({ projectRoot });
      }
      const uiBuildResult = await runPluginUiArtifactBuild({
        projectRoot,
        ...(params.signal ? { signal: params.signal } : {}),
      }, deps);
      if (!uiBuildResult.ok) {
        return {
          ok: false,
          operation: params.operation,
          projectRoot,
          diagnostics: uiBuildResult.diagnostics,
        };
      }
      await bundlePluginDaemonRuntimeIfRequired(projectRoot, deps, buildClassification);
    }
    return { ok: true, operation: params.operation, projectRoot };
  } catch (error) {
    return failedResult({
      operation: params.operation,
      projectRoot,
      diagnostic: createDiagnostic(
        error instanceof PluginAuthorBundlerUnavailableError
          ? 'plugin_author_managed_tool_unavailable'
          : 'plugin_author_tool_failed',
        error instanceof Error ? error.message : `Plugin author ${params.operation} failed`,
      ),
    });
  }
}
