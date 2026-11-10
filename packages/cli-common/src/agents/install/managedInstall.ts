import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import type { AgentCliInstallPlatform, AgentCliManagedInstallSpec } from '@happier-dev/agents';
import { fetchGitHubLatestRelease, fetchGitHubReleaseByTag } from '@happier-dev/release-runtime';
import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';

import { execFileWithDeadline, resolveWindowsCommandInvocation } from '../../process/index.js';

import { createManagedToolScratchDir } from '../createManagedToolScratchDir.js';
import { removeHappierTempDirAsync } from '../../tempDirs/createHappierTempDir.js';
import { AgentCliDownloadError, downloadGitHubReleaseAsset } from '../downloadGitHubReleaseAsset.js';
import { extractGitHubReleaseAsset } from '../extractGitHubReleaseAsset.js';
import {
  ensureManagedJavaScriptRuntimeCommand,
  readExplicitJavaScriptRuntimeCommand,
  resolveJavaScriptRuntimePathEntries,
} from '../managedJavaScriptRuntime.js';
import { buildManagedPnpmEnvironment, ensureManagedPnpmCommand, readRawPnpmOverride } from '../managedPnpm.js';
import { promoteManagedCurrentInstall } from '../promoteManagedCurrentInstall.js';
import { resolveManagedPackageBin } from '../managedPackageBin.js';
import { safeBashSingleQuote } from '../../ssh/shellQuote.js';
import type { AgentInstallProgressCallback } from '../installProgress.js';
import {
  resolveAgentCliManagedCommandRelativePathForRuntime,
  resolveAgentCliManagedInstallRootForRuntime,
  type AgentCliRuntimeDescriptor,
} from '../resolution.js';

export type ManagedInstallDeps = Readonly<{
  fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  fetchGitHubReleaseByTag?: typeof fetchGitHubReleaseByTag;
  downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset;
  extractGitHubReleaseAsset?: typeof extractGitHubReleaseAsset;
  ensureManagedPnpmCommand?: typeof ensureManagedPnpmCommand;
  ensureManagedJavaScriptRuntimeCommand?: typeof ensureManagedJavaScriptRuntimeCommand;
  execFileWithDeadline?: typeof execFileWithDeadline;
}>;

export type AppendCommandLogFn = (
  logPath: string,
  cmd: string,
  args: readonly string[],
  stdout: string,
  stderr: string,
  status: number | null,
  signal: NodeJS.Signals | null,
) => void;

export type AppendLogLineFn = (logPath: string, line: string) => void;

type GitHubReleaseAsset = Readonly<{
  name: string;
  browser_download_url: string;
  digest?: string | null;
}>;

type GitHubReleasePayload = Readonly<{
  assets?: unknown;
}>;

function resolveManagedAgentCommandPathInInstallDir(
  runtimeSpec: AgentCliRuntimeDescriptor,
  installDir: string,
  env: NodeJS.ProcessEnv,
): string {
  return join(installDir, resolveAgentCliManagedCommandRelativePathForRuntime(runtimeSpec));
}

async function prepareManagedAgentInstallRoot(runtimeSpec: AgentCliRuntimeDescriptor, env: NodeJS.ProcessEnv): Promise<string> {
  const installRoot = resolveAgentCliManagedInstallRootForRuntime(runtimeSpec, { processEnv: env });
  await mkdir(installRoot, { recursive: true });
  // Secure scratch creation makes recursive ancestors private. Only this
  // runtime-code namespace is public; .tmp and install logs remain private.
  if (process.platform !== 'win32') await chmod(dirname(installRoot), 0o755);
  return installRoot;
}

function buildManagedPackageInstallEnvironment(env: NodeJS.ProcessEnv, workspaceDir: string): NodeJS.ProcessEnv {
  const childEnv = buildManagedPnpmEnvironment(env);
  delete childEnv.INIT_CWD;
  delete childEnv.npm_command;
  delete childEnv.npm_config_global_prefix;
  delete childEnv.npm_config_local_prefix;
  delete childEnv.npm_config_prefix;
  delete childEnv.npm_config_user_agent;
  delete childEnv.npm_execpath;
  delete childEnv.npm_lifecycle_event;
  delete childEnv.npm_lifecycle_script;
  delete childEnv.npm_node_execpath;
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('npm_package_') || key.startsWith('YARN_')) {
      delete childEnv[key];
    }
  }
  childEnv.PWD = workspaceDir;
  return childEnv;
}

async function writeManagedPackageLauncher(params: Readonly<{
  outputPath: string;
  workspaceDir: string;
  binaryName: string;
  runtimePathEntries?: ReadonlyArray<string>;
}>): Promise<void> {
  await mkdir(dirname(params.outputPath), { recursive: true });
  const runtimePathEntries = (params.runtimePathEntries ?? []).map((value) => value.trim()).filter(Boolean);
  const pathPrefix =
    runtimePathEntries.length > 0
      ? `${runtimePathEntries.join(process.platform === 'win32' ? ';' : ':')}${process.platform === 'win32' ? ';' : ':'}`
      : '';
  if (process.platform === 'win32') {
    await writeFile(
      params.outputPath,
      `@echo off\r\nset "PATH=${pathPrefix}%PATH%"\r\n"${join(params.workspaceDir, 'node_modules', '.bin', `${params.binaryName}.cmd`)}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      'utf8',
    );
    return;
  }

  await writeFile(
    params.outputPath,
    `#!/bin/sh\nPATH=${safeBashSingleQuote(pathPrefix)}"$PATH"\nexport PATH\nexec ${safeBashSingleQuote(join(params.workspaceDir, 'node_modules', '.bin', params.binaryName))} "$@"\n`,
    'utf8',
  );
  await chmod(params.outputPath, 0o755);
}

export async function installManagedPackageAgentCli(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'managed_package' }>;
  platform: AgentCliInstallPlatform;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: ManagedInstallDeps;
  signal?: AbortSignal;
  appendCommandLog: AppendCommandLogFn;
  onProgress?: AgentInstallProgressCallback;
  appendLogLine: AppendLogLineFn;
}>): Promise<void> {
  params.signal?.throwIfAborted();
  const pnpmCommand = await (params.deps.ensureManagedPnpmCommand ?? ensureManagedPnpmCommand)(params.env, {}, { signal: params.signal, onProgress: params.onProgress });
  if (!pnpmCommand) {
    const rawPnpmOverride = readRawPnpmOverride(params.env);
    if (rawPnpmOverride) {
      throw new Error(
        `Managed pnpm is unavailable because HAPPIER_PNPM_BIN is set but does not point to a supported pnpm entrypoint. Fix HAPPIER_PNPM_BIN or unset it, then retry the install.`,
      );
    }
    throw new Error('Managed pnpm is unavailable');
  }
  const jsRuntimeCommand =
    await (params.deps.ensureManagedJavaScriptRuntimeCommand ?? ensureManagedJavaScriptRuntimeCommand)(params.env, {}, { signal: params.signal, onProgress: params.onProgress });
  if (!jsRuntimeCommand) {
    const rawRuntimeOverride = readExplicitJavaScriptRuntimeCommand(params.env);
    if (rawRuntimeOverride) {
      throw new Error(
        'Managed JavaScript runtime is unavailable because HAPPIER_JS_RUNTIME_PATH, HAPPIER_MANAGED_NODE_BIN, or HAPPIER_NODE_PATH is set but does not point to a supported JavaScript runtime entrypoint. Fix the override or unset it, then retry the install.',
      );
    }
    throw new Error('Managed JavaScript runtime is unavailable');
  }

  params.signal?.throwIfAborted();
  const installRoot = await prepareManagedAgentInstallRoot(params.runtimeSpec, params.env);
  const scratchDir = await createManagedToolScratchDir({
    installDir: installRoot,
    prefix: params.runtimeSpec.id,
  });
  try {
    const candidateDir = join(scratchDir, 'candidate');
    const workspaceDir = join(candidateDir, 'workspace');
    const launcherPath = resolveManagedAgentCommandPathInInstallDir(params.runtimeSpec, candidateDir, params.env);
    const launcherWorkspaceDir = join(installRoot, 'current', 'workspace');
    const runtimePathEntries = resolveJavaScriptRuntimePathEntries({
      processEnv: params.env,
      runtimeCommand: jsRuntimeCommand,
    });

    await mkdir(workspaceDir, { recursive: true });
    const packageSetup = params.managedInstall.packageBinarySetup;
    const definition = packageSetup?.kind === 'npm_package_bin' ? packageSetup.managedAcpDefinition : undefined;
    await writeFile(
      join(workspaceDir, 'package.json'),
      // happier-provider- is a persisted artifact name inside existing managed installs; kept in R.16.
      JSON.stringify({ name: `happier-provider-${params.runtimeSpec.id}`, private: true, version: '0.0.0',
        ...(definition && packageSetup?.kind === 'npm_package_bin' ? { happierManagedAcp: {
          definitionId: definition.definitionId, title: definition.title, kind: 'npm', version: packageSetup.version,
        } } : {}) }, null, 2),
      'utf8',
    );

    const childEnv = buildManagedPackageInstallEnvironment(params.env, workspaceDir);
    if (runtimePathEntries.length > 0) {
      childEnv.PATH = [...runtimePathEntries, String(childEnv.PATH ?? params.env.PATH ?? '')]
        .filter((value) => value.length > 0)
        .join(delimiter);
    }
    const addArgs = [
      '--dir', workspaceDir, 'add', params.managedInstall.packageName,
      ...(params.managedInstall.allowBuild === true
        ? [`--allow-build=${params.managedInstall.packageName}`, '--ignore-scripts=false']
        : ['--ignore-scripts']),
    ];
    params.onProgress?.({ t: 'log', line: `Installing ${params.managedInstall.packageName}` });
    params.signal?.throwIfAborted();
    const invocation = resolveWindowsCommandInvocation({ command: pnpmCommand, args: addArgs, env: childEnv });
    try {
      const result = await (params.deps.execFileWithDeadline ?? execFileWithDeadline)(invocation.command, invocation.args, {
        cwd: workspaceDir,
        encoding: 'utf8',
        env: childEnv,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        signal: params.signal,
      });
      params.appendCommandLog(params.logPath, pnpmCommand, addArgs, String(result.stdout), String(result.stderr), 0, null);
    } catch (error) {
      const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: NodeJS.Signals };
      params.appendCommandLog(params.logPath, pnpmCommand, addArgs,
        String(failure.stdout ?? ''), String(failure.stderr ?? ''),
        typeof failure.code === 'number' ? failure.code : null, failure.signal ?? null);
      throw error;
    }
    params.signal?.throwIfAborted();

    const packageBinarySetup = params.managedInstall.packageBinarySetup;
    const selectedPackageBin = packageBinarySetup?.kind === 'npm_package_bin'
      ? resolveManagedPackageBin({ workspaceDir, ...packageBinarySetup }) : params.managedInstall.binaryName;
    if (!selectedPackageBin) throw new Error('Installed npm package does not provide an unambiguous executable at the pinned version');
    await writeManagedPackageLauncher({
      outputPath: launcherPath,
      workspaceDir: launcherWorkspaceDir,
      binaryName: selectedPackageBin,
      runtimePathEntries,
    });

    params.signal?.throwIfAborted();
    await promoteManagedCurrentInstall({
      installRoot,
      signal: params.signal,
      candidatePath: candidateDir,
      preserveExistingCurrent: definition !== undefined,
      reportWarning: (message) => params.appendLogLine(params.logPath, `# ${message}`),
    });
  } finally {
    await removeHappierTempDirAsync(scratchDir);
  }
}

async function resolveManagedBinaryAsset(params: Readonly<{
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  platform: AgentCliInstallPlatform;
  deps: ManagedInstallDeps;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ name: string; url: string; digest: string | null }>> {
  let release: unknown;
  try {
    const releaseRequest = {
      githubRepo: params.managedInstall.githubRepo,
      userAgent: 'happier-cli',
      githubToken: params.env.GITHUB_TOKEN,
      signal: params.signal,
    };
    release = params.managedInstall.releaseTag === undefined
      ? await (params.deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)(releaseRequest)
      : await (params.deps.fetchGitHubReleaseByTag ?? fetchGitHubReleaseByTag)({
        ...releaseRequest,
        tag: params.managedInstall.releaseTag,
        assetsOnly: true,
      });
  } catch (error) {
    params.signal?.throwIfAborted();
    throw new AgentCliDownloadError(error instanceof GitHubReleaseRateLimitError ? 'rate-limited' : 'download-failed',
      error instanceof Error ? error.message : String(error), { cause: error });
  }

  const assets = normalizeGitHubReleaseAssets(release);
  const declaredAssetName = params.managedInstall.assetNameByPlatform
    ? params.managedInstall.assetNameByPlatform[params.platform][resolveManagedAssetArch(process.arch)]
    : null;
  const selected = (declaredAssetName
    ? [declaredAssetName]
    : preferredGitHubReleaseAssetNames(params.managedInstall.binaryName))
    .map((name) => assets.find((asset) => asset.name === name))
    .find(Boolean);
  if (!selected) {
    throw new Error(
      `No ${params.managedInstall.binaryName} release asset found for ${params.platform}/${process.arch}`,
    );
  }
  if (!selected.digest) {
    throw new Error(`${selected.name} release asset is missing a required digest`);
  }

  return { name: selected.name, url: selected.browser_download_url, digest: selected.digest };
}

function resolveManagedAssetArch(arch: string): 'arm64' | 'x64' {
  if (arch === 'arm64' || arch === 'x64') return arch;
  throw new Error(`Unsupported managed GitHub release architecture: ${arch}`);
}

function normalizeGitHubReleaseAssets(release: unknown): GitHubReleaseAsset[] {
  const parsed = (release && typeof release === 'object' ? release : {}) as GitHubReleasePayload;
  const rawAssets = parsed.assets;
  if (!Array.isArray(rawAssets)) return [];

  const assets: GitHubReleaseAsset[] = [];
  for (const entry of rawAssets) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name.trim()
      : '';
    const url = typeof (entry as { browser_download_url?: unknown }).browser_download_url === 'string'
      ? (entry as { browser_download_url: string }).browser_download_url.trim()
      : '';
    const digest = typeof (entry as { digest?: unknown }).digest === 'string'
      ? (entry as { digest: string }).digest.trim()
      : null;
    if (!name || !url) continue;
    assets.push({ name, browser_download_url: url, digest });
  }
  return assets;
}

function preferredGitHubReleaseAssetNames(binaryName: string): string[] {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return [
      `${binaryName}-darwin-arm64`,
      `${binaryName}-darwin-arm64.tar.gz`,
      `${binaryName}-darwin-arm64.tar.xz`,
      `${binaryName}-darwin-arm64.zip`,
      `${binaryName}-aarch64-apple-darwin.tar.gz`,
      `${binaryName}-aarch64-apple-darwin.tar.xz`,
      `${binaryName}-aarch64-apple-darwin.zip`,
    ];
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return [
      `${binaryName}-darwin-x64`,
      `${binaryName}-darwin-x64.tar.gz`,
      `${binaryName}-darwin-x64.tar.xz`,
      `${binaryName}-darwin-x64.zip`,
      `${binaryName}-x86_64-apple-darwin.tar.gz`,
      `${binaryName}-x86_64-apple-darwin.tar.xz`,
      `${binaryName}-x86_64-apple-darwin.zip`,
    ];
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return [
      `${binaryName}-linux-arm64`,
      `${binaryName}-linux-arm64.tar.gz`,
      `${binaryName}-linux-arm64.tar.xz`,
      `${binaryName}-linux-arm64.zip`,
      `${binaryName}-aarch64-unknown-linux-musl.tar.gz`,
      `${binaryName}-aarch64-unknown-linux-musl.tar.xz`,
      `${binaryName}-aarch64-unknown-linux-gnu.tar.gz`,
      `${binaryName}-aarch64-unknown-linux-gnu.tar.xz`,
    ];
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return [
      `${binaryName}-linux-x64`,
      `${binaryName}-linux-x64.tar.gz`,
      `${binaryName}-linux-x64.tar.xz`,
      `${binaryName}-linux-x64.zip`,
      `${binaryName}-x86_64-unknown-linux-musl.tar.gz`,
      `${binaryName}-x86_64-unknown-linux-musl.tar.xz`,
      `${binaryName}-x86_64-unknown-linux-gnu.tar.gz`,
      `${binaryName}-x86_64-unknown-linux-gnu.tar.xz`,
    ];
  }
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return [
      `${binaryName}-windows-arm64.exe`,
      `${binaryName}-windows-arm64.zip`,
      `${binaryName}-aarch64-pc-windows-msvc.exe.zip`,
    ];
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return [
      `${binaryName}-windows-x64.exe`,
      `${binaryName}-windows-x64.zip`,
      `${binaryName}-x86_64-pc-windows-msvc.exe.zip`,
    ];
  }
  throw new Error(`Unsupported managed GitHub release platform: ${process.platform}/${process.arch}`);
}

export async function installManagedBinaryAgentCli(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  platform: AgentCliInstallPlatform;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: ManagedInstallDeps;
  signal?: AbortSignal;
  appendLogLine: AppendLogLineFn;
  onProgress?: AgentInstallProgressCallback;
}>): Promise<void> {
  params.signal?.throwIfAborted();
  const installRoot = await prepareManagedAgentInstallRoot(params.runtimeSpec, params.env);
  const asset = await resolveManagedBinaryAsset({
    managedInstall: params.managedInstall,
    platform: params.platform,
    deps: params.deps,
    env: params.env,
    signal: params.signal,
  });
  const scratchDir = await createManagedToolScratchDir({
    installDir: installRoot,
    prefix: params.runtimeSpec.id,
  });
  try {
    const archivePath = join(scratchDir, asset.name);
    const extractDir = join(scratchDir, 'extract');
    const candidateDir = join(scratchDir, 'candidate');
    const candidateBinPath = resolveManagedAgentCommandPathInInstallDir(
      params.runtimeSpec,
      candidateDir,
      params.env,
    );
    const archiveEntries = params.managedInstall.archiveEntriesByPlatform?.[params.platform];

    await (params.deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset)({
      url: asset.url,
      destinationPath: archivePath,
      digest: asset.digest,
      userAgent: 'happier-cli',
      signal: params.signal,
      onProgress: params.onProgress,
    });

    await mkdir(dirname(candidateBinPath), { recursive: true });
    await (params.deps.extractGitHubReleaseAsset ?? extractGitHubReleaseAsset)({
      archivePath,
      signal: params.signal,
      archiveName: asset.name,
      extractDir,
      outputPath: candidateBinPath,
      outputDir: candidateDir,
      archiveEntries,
      archiveExtractionLimits: params.managedInstall.archiveExtractionLimits,
    });

    for (const entry of archiveEntries ?? []) {
      const installedPath = join(candidateDir, ...entry.destinationPath.split('/'));
      const installedStat = await stat(installedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!installedStat?.isFile()) {
        throw new Error(`[github-release] required archive member was not staged: ${entry.archivePath}`);
      }
    }

    params.appendLogLine(params.logPath, `# asset: ${asset.name}`);
    params.signal?.throwIfAborted();
    await promoteManagedCurrentInstall({
      installRoot,
      signal: params.signal,
      candidatePath: candidateDir,
      reportWarning: (message) => params.appendLogLine(params.logPath, `# ${message}`),
      activateVersionedRelease: params.platform !== 'win32',
    });
  } finally {
    await removeHappierTempDirAsync(scratchDir);
  }
}
