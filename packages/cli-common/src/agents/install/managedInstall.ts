import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { AgentCliInstallPlatform, AgentCliManagedInstallSpec } from '@happier-dev/agents';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

import { createManagedToolScratchDir } from '../createManagedToolScratchDir.js';
import { downloadGitHubReleaseAsset } from '../downloadGitHubReleaseAsset.js';
import { extractGitHubReleaseAsset } from '../extractGitHubReleaseAsset.js';
import {
  ensureManagedJavaScriptRuntimeCommand,
  readExplicitJavaScriptRuntimeCommand,
  resolveJavaScriptRuntimePathEntries,
} from '../managedJavaScriptRuntime.js';
import { buildManagedPnpmEnvironment, ensureManagedPnpmCommand, readRawPnpmOverride } from '../managedPnpm.js';
import { promoteManagedCurrentInstall } from '../promoteManagedCurrentInstall.js';
import { resolveHappyHomeDirFromEnvironment } from '../resolveHappyHomeDir.js';
import {
  resolveAgentCliManagedCommandRelativePathForRuntime,
  type AgentCliRuntimeDescriptor,
} from '../resolution.js';

export type ManagedInstallDeps = Readonly<{
  fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset;
  extractGitHubReleaseAsset?: typeof extractGitHubReleaseAsset;
  ensureManagedPnpmCommand?: typeof ensureManagedPnpmCommand;
  ensureManagedJavaScriptRuntimeCommand?: typeof ensureManagedJavaScriptRuntimeCommand;
  spawnSync?: typeof spawnSync;
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

function resolveManagedAgentInstallDir(agentId: string, env: NodeJS.ProcessEnv): string {
  // On-disk layout contract: existing installs live under tools/providers/<agentId>. Kept during the agent-vocabulary rename (R.16) to avoid a data migration.
  return join(resolveHappyHomeDirFromEnvironment(env), 'tools', 'providers', agentId);
}

function resolveManagedAgentCommandPathInInstallDir(
  runtimeSpec: AgentCliRuntimeDescriptor,
  installDir: string,
  env: NodeJS.ProcessEnv,
): string {
  return join(installDir, resolveAgentCliManagedCommandRelativePathForRuntime(runtimeSpec));
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
    `#!/bin/sh\nPATH="${pathPrefix}$PATH"\nexport PATH\nexec "${join(params.workspaceDir, 'node_modules', '.bin', params.binaryName)}" "$@"\n`,
    'utf8',
  );
  await chmod(params.outputPath, 0o755);
}

function resolveOpenCodePlatformName(platform: AgentCliInstallPlatform): 'darwin' | 'linux' | 'windows' {
  return platform === 'win32' ? 'windows' : platform;
}

function resolveOpenCodeArchName(arch: string): 'x64' | 'arm64' | 'arm' | string {
  if (arch === 'x64' || arch === 'arm64' || arch === 'arm') return arch;
  return arch;
}

function hasOpenCodeLinuxMuslRuntime(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return existsSync('/etc/alpine-release');
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }
  try {
    const result = spawnSync('ldd', ['--version'], { encoding: 'utf8' });
    return `${result.stdout || ''}${result.stderr || ''}`.toLowerCase().includes('musl');
  } catch {
    return false;
  }
}

function supportsOpenCodeAvx2(params: Readonly<{
  platform: AgentCliInstallPlatform;
  arch: string;
  env: NodeJS.ProcessEnv;
  spawn: typeof spawnSync;
}>): boolean {
  if (params.arch !== 'x64') return false;

  if (params.platform === 'linux') {
    try {
      const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
      return /(^|\s)avx2(\s|$)/i.test(cpuinfo);
    } catch {
      return false;
    }
  }

  if (params.platform === 'darwin') {
    try {
      const result = params.spawn('sysctl', ['-n', 'hw.optional.avx2_0'], {
        encoding: 'utf8',
        env: params.env,
        timeout: 1500,
      });
      if (result.status !== 0) return false;
      return String(result.stdout ?? '').trim() === '1';
    } catch {
      return false;
    }
  }

  if (params.platform === 'win32') {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';
    for (const executable of ['powershell.exe', 'pwsh.exe', 'pwsh', 'powershell']) {
      try {
        const result = params.spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', command], {
          encoding: 'utf8',
          env: params.env,
          timeout: 3000,
          windowsHide: true,
        });
        if (result.status !== 0) continue;
        const output = String(result.stdout ?? '').trim().toLowerCase();
        if (output === 'true' || output === '1') return true;
        if (output === 'false' || output === '0') return false;
      } catch {
        continue;
      }
    }
  }

  return false;
}

function resolveOpenCodePlatformPackageCandidates(params: Readonly<{
  platform: AgentCliInstallPlatform;
  arch: string;
  env: NodeJS.ProcessEnv;
  spawn: typeof spawnSync;
}>): ReadonlyArray<string> {
  const platform = resolveOpenCodePlatformName(params.platform);
  const arch = resolveOpenCodeArchName(params.arch);
  const base = `opencode-${platform}-${arch}`;
  const baseline = arch === 'x64' && !supportsOpenCodeAvx2(params);

  if (platform === 'linux') {
    if (hasOpenCodeLinuxMuslRuntime()) {
      if (arch === 'x64') {
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`];
      }
      return [`${base}-musl`, base];
    }

    if (arch === 'x64') {
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    }
    return [base, `${base}-musl`];
  }

  if (arch === 'x64') return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
  return [base];
}

function readOptionalDependencyNames(packageJson: unknown): ReadonlySet<string> {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) return new Set();
  const optionalDependencies = (packageJson as { optionalDependencies?: unknown }).optionalDependencies;
  if (!optionalDependencies || typeof optionalDependencies !== 'object' || Array.isArray(optionalDependencies)) {
    return new Set();
  }
  return new Set(Object.keys(optionalDependencies));
}

async function resolvePnpmPackageJsonPaths(params: Readonly<{
  workspaceDir: string;
  packageName: string;
}>): Promise<ReadonlyArray<string>> {
  const pnpmDir = join(params.workspaceDir, 'node_modules', '.pnpm');
  const encodedName = params.packageName.replace('/', '+');
  const prefix = `${encodedName}@`;
  try {
    const entries = await readdir(pnpmDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(pnpmDir, entry.name, 'node_modules', params.packageName, 'package.json'));
  } catch {
    return [];
  }
}

async function resolvePackageJsonPaths(params: Readonly<{
  workspaceDir: string;
  packageName: string;
  packageJsonPath: string;
}>): Promise<ReadonlyArray<string>> {
  const paths: string[] = [];
  const requireFromOpenCode = createRequire(params.packageJsonPath);
  const requireFromWorkspace = createRequire(join(params.workspaceDir, 'package.json'));
  for (const requireFrom of [requireFromOpenCode, requireFromWorkspace]) {
    try {
      paths.push(requireFrom.resolve(`${params.packageName}/package.json`));
    } catch {
      // Fall back to package-manager-specific layouts below.
    }
  }
  paths.push(...await resolvePnpmPackageJsonPaths({
    workspaceDir: params.workspaceDir,
    packageName: params.packageName,
  }));
  return [...new Set(paths)];
}

async function materializeOpenCodeManagedPackageBinary(params: Readonly<{
  workspaceDir: string;
  platform: AgentCliInstallPlatform;
  env: NodeJS.ProcessEnv;
  spawnSync: typeof spawnSync;
}>): Promise<Readonly<{ packageName: string }>> {
  const packageDir = join(params.workspaceDir, 'node_modules', 'opencode-ai');
  const packageJsonPath = join(packageDir, 'package.json');
  const rawPackageJson = await readFile(packageJsonPath, 'utf8');
  const optionalDependencyNames = readOptionalDependencyNames(JSON.parse(rawPackageJson));
  const sourceBinary = params.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const targetBinary = join(packageDir, 'bin', sourceBinary);
  const candidates = resolveOpenCodePlatformPackageCandidates({
    platform: params.platform,
    arch: process.arch,
    env: params.env,
    spawn: params.spawnSync,
  }).filter((packageName) => optionalDependencyNames.has(packageName));

  for (const packageName of candidates) {
    for (const platformPackageJsonPath of await resolvePackageJsonPaths({
      workspaceDir: params.workspaceDir,
      packageName,
      packageJsonPath,
    })) {
      try {
        const sourceBinaryPath = join(dirname(platformPackageJsonPath), 'bin', sourceBinary);
        await copyFile(sourceBinaryPath, targetBinary);
        await chmod(targetBinary, 0o755);
        return { packageName };
      } catch {
        // Try the next installed location for this platform package.
      }
    }
  }

  throw new Error(
    `OpenCode managed install did not include a usable platform binary package for ${params.platform}/${process.arch}.`,
  );
}

export async function installManagedPackageAgentCli(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'managed_package' }>;
  platform: AgentCliInstallPlatform;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: ManagedInstallDeps;
  appendCommandLog: AppendCommandLogFn;
  appendLogLine: AppendLogLineFn;
}>): Promise<void> {
  const pnpmCommand = await (params.deps.ensureManagedPnpmCommand ?? ensureManagedPnpmCommand)(params.env);
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
    await (params.deps.ensureManagedJavaScriptRuntimeCommand ?? ensureManagedJavaScriptRuntimeCommand)(params.env);
  if (!jsRuntimeCommand) {
    const rawRuntimeOverride = readExplicitJavaScriptRuntimeCommand(params.env);
    if (rawRuntimeOverride) {
      throw new Error(
        'Managed JavaScript runtime is unavailable because HAPPIER_JS_RUNTIME_PATH, HAPPIER_MANAGED_NODE_BIN, or HAPPIER_NODE_PATH is set but does not point to a supported JavaScript runtime entrypoint. Fix the override or unset it, then retry the install.',
      );
    }
    throw new Error('Managed JavaScript runtime is unavailable');
  }

  const installRoot = resolveManagedAgentInstallDir(params.runtimeSpec.id, params.env);
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
    await writeFile(
      join(workspaceDir, 'package.json'),
      // happier-provider- is a persisted artifact name inside existing managed installs; kept in R.16.
      JSON.stringify({ name: `happier-provider-${params.runtimeSpec.id}`, private: true, version: '0.0.0' }, null, 2),
      'utf8',
    );

    const childEnv = buildManagedPackageInstallEnvironment(params.env, workspaceDir);
    if (runtimePathEntries.length > 0) {
      childEnv.PATH = [...runtimePathEntries, String(childEnv.PATH ?? params.env.PATH ?? '')]
        .filter((value) => value.length > 0)
        .join(delimiter);
    }
    const addArgs = ['--dir', workspaceDir, 'add', params.managedInstall.packageName, '--ignore-scripts'];
    const spawn = params.deps.spawnSync ?? spawnSync;
    const result = spawn(pnpmCommand, addArgs, {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: childEnv,
      windowsHide: true,
    });
    params.appendCommandLog(
      params.logPath,
      pnpmCommand,
      addArgs,
      String(result.stdout ?? ''),
      String(result.stderr ?? ''),
      result.status ?? null,
      result.signal ?? null,
    );
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(String(result.stderr ?? '').trim() || `pnpm add failed (${result.status ?? 'unknown'})`);
    }

    if (params.managedInstall.packageBinarySetup?.kind === 'opencode_platform_binary') {
      const materialized = await materializeOpenCodeManagedPackageBinary({
        workspaceDir,
        platform: params.platform,
        env: childEnv,
        spawnSync: spawn,
      });
      params.appendLogLine(params.logPath, `# opencode platform package: ${materialized.packageName}`);
    }

    await writeManagedPackageLauncher({
      outputPath: launcherPath,
      workspaceDir: launcherWorkspaceDir,
      binaryName: params.managedInstall.binaryName,
      runtimePathEntries,
    });

    await promoteManagedCurrentInstall({
      installRoot,
      candidatePath: candidateDir,
      reportWarning: (message) => params.appendLogLine(params.logPath, `# ${message}`),
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function resolveManagedBinaryAsset(params: Readonly<{
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  platform: AgentCliInstallPlatform;
  deps: ManagedInstallDeps;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ name: string; url: string; digest: string | null }>> {
  const release = await (params.deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)({
    githubRepo: params.managedInstall.githubRepo,
    userAgent: 'happier-cli',
    githubToken: params.env.GITHUB_TOKEN,
  });

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
  appendLogLine: AppendLogLineFn;
}>): Promise<void> {
  const installRoot = resolveManagedAgentInstallDir(params.runtimeSpec.id, params.env);
  const asset = await resolveManagedBinaryAsset({
    managedInstall: params.managedInstall,
    platform: params.platform,
    deps: params.deps,
    env: params.env,
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
    });

    await mkdir(dirname(candidateBinPath), { recursive: true });
    await (params.deps.extractGitHubReleaseAsset ?? extractGitHubReleaseAsset)({
      archivePath,
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
    await promoteManagedCurrentInstall({
      installRoot,
      candidatePath: candidateDir,
      reportWarning: (message) => params.appendLogLine(params.logPath, `# ${message}`),
      activateVersionedRelease: params.platform !== 'win32',
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
