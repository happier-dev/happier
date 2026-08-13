import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

import type {
  AgentId,
  ProviderCliManagedInstallSpec,
  ProviderCliRuntimeInstallPlatform as ProviderCliInstallPlatform,
  ProviderCliRuntimeSpec,
} from '@happier-dev/agents';
import { getProviderCliRuntimeSpec } from '@happier-dev/agents';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

import { commandExistsOnPath, resolveWindowsCommandInvocation } from '../process/index.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';
import {
  ensureManagedJavaScriptRuntimeCommand,
  readExplicitJavaScriptRuntimeCommand,
  resolveJavaScriptRuntimePathEntries,
} from './managedJavaScriptRuntime.js';
import { buildManagedPnpmEnvironment, ensureManagedPnpmCommand, readRawPnpmOverride } from './managedPnpm.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';
import { resolveProviderCliCommand, resolveProviderCliManagedCommandPath } from './resolution.js';

export type ProviderCliInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  requiresAdmin: boolean;
  note: string | null;
}>;

export type ProviderCliInstallMode = 'vendor_recipe' | 'managed_package' | 'github_release_binary';

export type ProviderCliInstallPlan = Readonly<{
  providerId: AgentId;
  title: string;
  binaries: ReadonlyArray<string>;
  platform: ProviderCliInstallPlatform;
  docsUrl: string | null;
  commands: ReadonlyArray<ProviderCliInstallCommand>;
  requiresAdmin: boolean;
  installMode: ProviderCliInstallMode;
  managedInstall: ProviderCliManagedInstallSpec | null;
}>;

export type ProviderCliInstallPlanResult =
  | Readonly<{ ok: true; plan: ProviderCliInstallPlan }>
  | Readonly<{ ok: false; errorCode: 'no-recipe'; errorMessage: string }>;

export type InstallProviderCliResult =
  | Readonly<{ ok: true; plan: ProviderCliInstallPlan; alreadyInstalled: boolean; logPath: string | null }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'no-recipe'
        | 'vendor-recipe-disallowed'
        | 'command-not-found'
        | 'command-exec-failed'
        | 'command-timed-out'
        | 'command-failed'
        | 'managed-runtime-unavailable';
      errorMessage: string;
      plan: ProviderCliInstallPlan | null;
      logPath: string | null;
    }>;

type InstallProviderCliDeps = Readonly<{
  fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset;
  extractGitHubReleaseAsset?: typeof extractGitHubReleaseAsset;
  ensureManagedPnpmCommand?: typeof ensureManagedPnpmCommand;
  ensureManagedJavaScriptRuntimeCommand?: typeof ensureManagedJavaScriptRuntimeCommand;
  spawnSync?: typeof spawnSync;
}>;

export function resolvePlatformFromNodePlatform(nodePlatform: string): ProviderCliInstallPlatform | null {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'win32') return 'win32';
  return null;
}

function resolveProviderInstallCommands(
  runtimeSpec: ProviderCliRuntimeSpec,
  platform: ProviderCliInstallPlatform,
): ReadonlyArray<ProviderCliInstallCommand> | null {
  const commandsRaw = runtimeSpec.manualInstallRecipes?.[platform] ?? null;
  if (!commandsRaw || commandsRaw.length === 0) return null;
  return commandsRaw.map((c) => ({
    cmd: c.cmd,
    args: [...c.args],
    requiresAdmin: Boolean(c.requiresAdmin),
    note: typeof c.note === 'string' ? c.note : null,
  }));
}

export function planProviderCliInstall(params: Readonly<{ providerId: AgentId; platform: ProviderCliInstallPlatform }>): ProviderCliInstallPlanResult {
  const runtimeSpec = getProviderCliRuntimeSpec(params.providerId);
  const commands = resolveProviderInstallCommands(runtimeSpec, params.platform);

  if (runtimeSpec.managedInstall) {
    return {
      ok: true,
      plan: {
        providerId: runtimeSpec.id,
        title: runtimeSpec.title,
        binaries: [runtimeSpec.binaryName],
        platform: params.platform,
        docsUrl: typeof runtimeSpec.docsUrl === 'string' ? runtimeSpec.docsUrl : null,
        commands: [],
        requiresAdmin: false,
        installMode: runtimeSpec.managedInstall.kind,
        managedInstall: runtimeSpec.managedInstall,
      },
    };
  }

  if (!commands) {
    return {
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: `No auto-install recipe available for ${runtimeSpec.id} on ${params.platform}.`,
    };
  }

  const requiresAdmin = commands.some((c) => c.requiresAdmin);
  return {
    ok: true,
    plan: {
      providerId: runtimeSpec.id,
      title: runtimeSpec.title,
      binaries: [runtimeSpec.binaryName],
      platform: params.platform,
      docsUrl: typeof runtimeSpec.docsUrl === 'string' ? runtimeSpec.docsUrl : null,
      commands,
      requiresAdmin,
      installMode: 'vendor_recipe',
      managedInstall: null,
    },
  };
}

function resolveLogPath(params: Readonly<{ providerId: AgentId; logDir?: string | null; env: NodeJS.ProcessEnv }>): string {
  const base =
    typeof params.logDir === 'string' && params.logDir.trim()
      ? params.logDir.trim()
      : join(resolveHappyHomeDirFromEnvironment(params.env), 'logs', 'provider-installs');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    chmodSync(base, 0o700);
  } catch {
    // best-effort
  }
  return join(base, `install-provider-${params.providerId}-${Date.now()}.log`);
}

function writeLogHeader(logPath: string, plan: ProviderCliInstallPlan): void {
  writeFileSync(
    logPath,
    [
      `# providerId: ${plan.providerId}`,
      `# platform: ${plan.platform}`,
      `# installMode: ${plan.installMode}`,
      `# requiresAdmin: ${plan.requiresAdmin ? '1' : '0'}`,
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    chmodSync(logPath, 0o600);
  } catch {
    // best-effort
  }
}

function appendCommandLog(
  logPath: string,
  cmd: string,
  args: readonly string[],
  stdout: string,
  stderr: string,
  status: number | null,
  signal: NodeJS.Signals | null,
): void {
  appendFileSync(
    logPath,
    [
      '',
      `## ${cmd} ${args.join(' ')}`.trim(),
      `# exit: ${status ?? 'null'}`,
      `# signal: ${signal ?? 'null'}`,
      '',
      '### stdout',
      stdout || '',
      '',
      '### stderr',
      stderr || '',
      '',
    ].join('\n'),
    'utf8',
  );
}

function resolveVendorRecipeFailureMessage(params: Readonly<{
  cmd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}>): string {
  const stderr = params.stderr.trim();
  if (params.status === 137 || params.signal === 'SIGKILL') {
    return [
      `Vendor install was killed while running ${params.cmd}; this often means the machine ran out of memory.`,
      'Please increase available memory or swap and retry.',
      stderr ? `Installer output: ${stderr}` : null,
    ].filter(Boolean).join(' ');
  }
  return stderr || `Command failed (${params.status ?? 'unknown'}): ${params.cmd}`;
}

function appendLogLine(logPath: string, line: string): void {
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

function resolveProviderToolInstallDir(providerId: AgentId, env: NodeJS.ProcessEnv): string {
  return join(resolveHappyHomeDirFromEnvironment(env), 'tools', 'providers', providerId);
}

function resolveManagedProviderInstallDir(providerId: AgentId, env: NodeJS.ProcessEnv): string {
  return resolveProviderToolInstallDir(providerId, env);
}

function buildVendorRecipePath(providerId: AgentId, env: NodeJS.ProcessEnv): string {
  const currentEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    return currentEntries.join(delimiter);
  }

  const homeDir = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!homeDir) {
    return currentEntries.join(delimiter);
  }

  const preferredEntries = [
    join(homeDir, '.local', 'bin'),
    ...((getProviderCliRuntimeSpec(providerId).knownCommandCandidates ?? [])
      .filter((candidate) => candidate.kind === 'homeBinDir')
      .map((candidate) => join(homeDir, candidate.relativeDir))),
  ];

  const uniqueEntries = new Set<string>();
  for (const entry of [...preferredEntries, ...currentEntries]) {
    if (!entry) continue;
    uniqueEntries.add(entry);
  }
  return [...uniqueEntries].join(delimiter);
}

function resolveVendorInstallTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS === 'string'
    ? env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS.trim()
    : '';
  if (raw === '0') return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 250) return 180_000;
  return Math.min(parsed, 900_000);
}

function resolveStagedManagedProviderCommandPath(
  providerId: AgentId,
  stage: 'current' | 'next',
  env: NodeJS.ProcessEnv,
): string {
  const currentPath = resolveProviderCliManagedCommandPath(providerId, {
    happyHomeDir: resolveHappyHomeDirFromEnvironment(env),
    processEnv: env,
  });
  const currentSegment = join('current', 'bin');
  const targetSegment = join(stage, 'bin');
  if (!currentPath.includes(currentSegment)) {
    throw new Error(`Managed provider path missing ${currentSegment}: ${currentPath}`);
  }
  return currentPath.replace(currentSegment, targetSegment);
}

function resolveStagedManagedProviderWorkspaceDir(
  providerId: AgentId,
  stage: 'current' | 'next',
  env: NodeJS.ProcessEnv,
): string {
  return join(dirname(resolveStagedManagedProviderCommandPath(providerId, stage, env)), '..', 'workspace');
}

function buildManagedPackageInstallEnvironment(
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): NodeJS.ProcessEnv {
  const childEnv = buildManagedPnpmEnvironment(env);
  delete childEnv.INIT_CWD;
  delete childEnv.npm_command;
  delete childEnv.npm_config_user_agent;
  delete childEnv.npm_execpath;
  delete childEnv.npm_lifecycle_event;
  delete childEnv.npm_lifecycle_script;
  delete childEnv.npm_node_execpath;
  delete childEnv.npm_package_json;
  delete childEnv.npm_package_manager;
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
    const binaryPath = join(params.workspaceDir, 'node_modules', '.bin', `${params.binaryName}.cmd`);
    await writeFile(
      params.outputPath,
      `@echo off\r\nset "PATH=${pathPrefix}%PATH%"\r\n"${binaryPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      'utf8',
    );
    return;
  }

  const binaryPath = join(params.workspaceDir, 'node_modules', '.bin', params.binaryName);
  await writeFile(
    params.outputPath,
    `#!/bin/sh\nPATH="${pathPrefix}$PATH"\nexport PATH\nexec "${binaryPath}" "$@"\n`,
    'utf8',
  );
  await chmod(params.outputPath, 0o755);
}

function resolveOpenCodePlatformName(platform: ProviderCliInstallPlatform): 'darwin' | 'linux' | 'windows' {
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
  platform: ProviderCliInstallPlatform;
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
  platform: ProviderCliInstallPlatform;
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
  platform: ProviderCliInstallPlatform;
  env: NodeJS.ProcessEnv;
  spawnSync: typeof spawnSync;
}>): Promise<Readonly<{ packageName: string }>> {
  const packageDir = join(params.workspaceDir, 'node_modules', 'opencode-ai');
  const packageJsonPath = join(packageDir, 'package.json');
  const rawPackageJson = await readFile(packageJsonPath, 'utf8');
  const optionalDependencyNames = readOptionalDependencyNames(JSON.parse(rawPackageJson));
  const sourceBinary = params.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const targetBinary = join(packageDir, 'bin', 'opencode.exe');
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

async function installManagedPackageProviderCli(params: Readonly<{
  providerId: AgentId;
  managedInstall: Extract<ProviderCliManagedInstallSpec, { kind: 'managed_package' }>;
  platform: ProviderCliInstallPlatform;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: InstallProviderCliDeps;
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

  const installRoot = resolveManagedProviderInstallDir(params.providerId, params.env);
  const nextDir = join(installRoot, 'next');
  const workspaceDir = join(nextDir, 'workspace');
  const launcherPath = resolveStagedManagedProviderCommandPath(params.providerId, 'next', params.env);
  const launcherWorkspaceDir = resolveStagedManagedProviderWorkspaceDir(params.providerId, 'current', params.env);
  const runtimePathEntries = resolveJavaScriptRuntimePathEntries({
    processEnv: params.env,
    runtimeCommand: jsRuntimeCommand,
  });

  await rm(nextDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(workspaceDir, 'package.json'),
    JSON.stringify({ name: `happier-provider-${params.providerId}`, private: true, version: '0.0.0' }, null, 2),
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
  appendCommandLog(
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
    appendLogLine(params.logPath, `# opencode platform package: ${materialized.packageName}`);
  }

  await writeManagedPackageLauncher({
    outputPath: launcherPath,
    workspaceDir: launcherWorkspaceDir,
    binaryName: params.managedInstall.binaryName,
    runtimePathEntries,
  });

  await rm(join(installRoot, 'current'), { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true });
  await rename(nextDir, join(installRoot, 'current'));
}

async function resolveManagedBinaryAsset(params: Readonly<{
  providerId: AgentId;
  managedInstall: Extract<ProviderCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  deps: InstallProviderCliDeps;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ name: string; url: string; digest: string | null }>> {
  const release = await (params.deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)({
    githubRepo: params.managedInstall.githubRepo,
    userAgent: 'happier-cli',
    githubToken: params.env.GITHUB_TOKEN,
  });

  if (params.providerId === 'codex') {
    const { resolveCodexReleaseAsset } = await import('./codexRelease.js');
    const asset = resolveCodexReleaseAsset(release);
    return { name: asset.name, url: asset.url, digest: asset.digest };
  }

  throw new Error(`Unsupported managed github release provider: ${params.providerId}`);
}

async function installManagedBinaryProviderCli(params: Readonly<{
  providerId: AgentId;
  managedInstall: Extract<ProviderCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: InstallProviderCliDeps;
}>): Promise<void> {
  const installRoot = resolveManagedProviderInstallDir(params.providerId, params.env);
  const asset = await resolveManagedBinaryAsset(params);
  const scratchDir = await createManagedToolScratchDir({
    installDir: installRoot,
    prefix: params.providerId,
  });
  try {
    const archivePath = join(scratchDir, asset.name);
    const extractDir = join(scratchDir, 'extract');
    const nextDir = join(installRoot, 'next');
    const nextBinPath = resolveStagedManagedProviderCommandPath(params.providerId, 'next', params.env);

    await (params.deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset)({
      url: asset.url,
      destinationPath: archivePath,
      digest: asset.digest,
      userAgent: 'happier-cli',
    });

    await rm(nextDir, { recursive: true, force: true });
    await mkdir(dirname(nextBinPath), { recursive: true });
    await (params.deps.extractGitHubReleaseAsset ?? extractGitHubReleaseAsset)({
      archivePath,
      archiveName: asset.name,
      extractDir,
      outputPath: nextBinPath,
      archiveExtractionLimits: params.managedInstall.archiveExtractionLimits,
    });

    appendLogLine(params.logPath, `# asset: ${asset.name}`);
    await rm(join(installRoot, 'current'), { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });
    await rename(nextDir, join(installRoot, 'current'));
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function installProviderCli(params: Readonly<{
  providerId: AgentId;
  platform: ProviderCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
  logDir?: string | null;
  dryRun?: boolean;
  skipIfInstalled?: boolean;
  allowVendorRecipeExecution?: boolean;
  deps?: InstallProviderCliDeps;
}>): Promise<InstallProviderCliResult> {
  const env = params.env ?? process.env;
  const skipIfInstalled = params.skipIfInstalled !== false;
  const deps = params.deps ?? {};
  const allowVendorRecipeExecution = params.allowVendorRecipeExecution === true;
  const spawn = deps.spawnSync ?? spawnSync;

  const planned = planProviderCliInstall({ providerId: params.providerId, platform: params.platform });
  if (!planned.ok) {
    return { ok: false, errorCode: planned.errorCode, errorMessage: planned.errorMessage, plan: null, logPath: null };
  }

  const plan = planned.plan;

  if (skipIfInstalled) {
    const existingResolution = resolveProviderCliCommand(params.providerId, { processEnv: env });
    const alreadyInstalled =
      plan.installMode === 'vendor_recipe'
        ? Boolean(existingResolution)
        : existingResolution?.source === 'managed';
    if (alreadyInstalled) {
      return { ok: true, plan, alreadyInstalled: true, logPath: null };
    }
  }

  if (params.dryRun) {
    return { ok: true, plan, alreadyInstalled: false, logPath: null };
  }

  if (plan.installMode === 'vendor_recipe' && !allowVendorRecipeExecution) {
    return {
      ok: false,
      errorCode: 'vendor-recipe-disallowed',
      errorMessage:
        'Vendor install recipes are disabled by default. Re-run with allowVendorRecipeExecution=true to execute the vendor-provided installer commands.',
      plan,
      logPath: null,
    };
  }

  const logPath = resolveLogPath({ providerId: params.providerId, logDir: params.logDir, env });
  writeLogHeader(logPath, plan);
  const vendorScratchDir =
    plan.installMode === 'vendor_recipe'
      ? await createManagedToolScratchDir({
          installDir: resolveProviderToolInstallDir(params.providerId, env),
          prefix: 'vendor-install',
        })
      : null;

  try {
    if (plan.installMode === 'vendor_recipe') {
      for (const c of plan.commands) {
        if (!commandExistsOnPath(c.cmd, { env })) {
          return { ok: false, errorCode: 'command-not-found', errorMessage: `Command not found: ${c.cmd}`, plan, logPath };
        }
        const timeoutMs = resolveVendorInstallTimeoutMs(env);
        const childEnv = {
          ...process.env,
          ...env,
          PATH: buildVendorRecipePath(params.providerId, {
            ...process.env,
            ...env,
          }),
          ...(vendorScratchDir ? { TMPDIR: vendorScratchDir, TMP: vendorScratchDir, TEMP: vendorScratchDir } : {}),
        };
        const invocation = resolveWindowsCommandInvocation({
          command: c.cmd,
          args: c.args,
          env: childEnv,
          resolveCommandOnPath: true,
        });
        const res = spawn(invocation.command, invocation.args, {
          encoding: 'utf8',
          env: childEnv,
          ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
        if (res.error) {
          appendCommandLog(logPath, c.cmd, c.args, '', res.error.message, res.status ?? null, res.signal ?? null);
          if ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            appendLogLine(logPath, `# vendor recipe timed out after ${timeoutMs}ms`);
            return {
              ok: false,
              errorCode: 'command-timed-out',
              errorMessage: `Vendor install timed out after ${timeoutMs}ms: ${c.cmd}`,
              plan,
              logPath,
            };
          }
          return { ok: false, errorCode: 'command-exec-failed', errorMessage: res.error.message, plan, logPath };
        }
        const status = typeof res.status === 'number' ? res.status : null;
        const signal = res.signal ?? null;
        appendCommandLog(logPath, c.cmd, c.args, String(res.stdout ?? ''), String(res.stderr ?? ''), status, signal);
        if (status !== 0) {
          const resolvedAfterFailure = resolveProviderCliCommand(params.providerId, { processEnv: childEnv });
          if (resolvedAfterFailure) {
            appendLogLine(
              logPath,
              `# vendor recipe exited ${status ?? 'unknown'} but ${params.providerId} became available at ${resolvedAfterFailure.command}`,
            );
            return { ok: true, plan, alreadyInstalled: false, logPath };
          }
          return {
            ok: false,
            errorCode: 'command-failed',
            errorMessage: resolveVendorRecipeFailureMessage({
              cmd: c.cmd,
              status,
              signal,
              stderr: String(res.stderr ?? ''),
            }),
            plan,
            logPath,
          };
        }
      }
      return { ok: true, plan, alreadyInstalled: false, logPath };
    }

    if (plan.installMode === 'managed_package' && plan.managedInstall?.kind === 'managed_package') {
      await installManagedPackageProviderCli({
        providerId: params.providerId,
        managedInstall: plan.managedInstall,
        platform: params.platform,
        env,
        logPath,
        deps,
      });
      return { ok: true, plan, alreadyInstalled: false, logPath };
    }

    if (plan.installMode === 'github_release_binary' && plan.managedInstall?.kind === 'github_release_binary') {
      await installManagedBinaryProviderCli({
        providerId: params.providerId,
        managedInstall: plan.managedInstall,
        env,
        logPath,
        deps,
      });
      return { ok: true, plan, alreadyInstalled: false, logPath };
    }

    return {
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: `Unsupported install mode for ${params.providerId}`,
      plan,
      logPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      message.startsWith('Managed pnpm is unavailable') || message.startsWith('Managed JavaScript runtime is unavailable')
        ? 'managed-runtime-unavailable'
        : 'command-failed';
    appendLogLine(logPath, message);
    return { ok: false, errorCode: code, errorMessage: message, plan, logPath };
  } finally {
    if (vendorScratchDir) {
      await rm(vendorScratchDir, { recursive: true, force: true });
    }
  }
}
