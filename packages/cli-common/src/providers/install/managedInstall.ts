import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';

import type { AgentCliManagedInstallSpec } from '@happier-dev/agents';
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
import { resolveHappyHomeDirFromEnvironment } from '../resolveHappyHomeDir.js';
import {
  resolveProviderCliManagedCommandPathForRuntime,
  type ProviderCliRuntimeDescriptor,
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

function resolveManagedProviderInstallDir(providerId: string, env: NodeJS.ProcessEnv): string {
  return join(resolveHappyHomeDirFromEnvironment(env), 'tools', 'providers', providerId);
}

function resolveStagedManagedProviderCommandPath(
  runtimeSpec: ProviderCliRuntimeDescriptor,
  stage: 'current' | 'next',
  env: NodeJS.ProcessEnv,
): string {
  const currentPath = resolveProviderCliManagedCommandPathForRuntime(runtimeSpec, {
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
  runtimeSpec: ProviderCliRuntimeDescriptor,
  stage: 'current' | 'next',
  env: NodeJS.ProcessEnv,
): string {
  return join(dirname(resolveStagedManagedProviderCommandPath(runtimeSpec, stage, env)), '..', 'workspace');
}

async function writeManagedPackageLauncher(params: Readonly<{
  outputPath: string;
  pnpmCommand: string;
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
      `@echo off\r\nset "PATH=${pathPrefix}%PATH%"\r\n"${params.pnpmCommand}" --dir "${params.workspaceDir}" exec "${params.binaryName}" %*\r\n`,
      'utf8',
    );
    return;
  }

  await writeFile(
    params.outputPath,
    `#!/bin/sh\nPATH="${pathPrefix}$PATH"\nexport PATH\nexec "${params.pnpmCommand}" --dir "${params.workspaceDir}" exec "${params.binaryName}" "$@"\n`,
    'utf8',
  );
  await chmod(params.outputPath, 0o755);
}

export async function installManagedPackageProviderCli(params: Readonly<{
  runtimeSpec: ProviderCliRuntimeDescriptor;
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'managed_package' }>;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: ManagedInstallDeps;
  appendCommandLog: AppendCommandLogFn;
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

  const installRoot = resolveManagedProviderInstallDir(params.runtimeSpec.id, params.env);
  const nextDir = join(installRoot, 'next');
  const workspaceDir = join(nextDir, 'workspace');
  const launcherPath = resolveStagedManagedProviderCommandPath(params.runtimeSpec, 'next', params.env);
  const launcherWorkspaceDir = resolveStagedManagedProviderWorkspaceDir(params.runtimeSpec, 'current', params.env);
  const runtimePathEntries = resolveJavaScriptRuntimePathEntries({
    processEnv: params.env,
    runtimeCommand: jsRuntimeCommand,
  });

  await rm(nextDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(workspaceDir, 'package.json'),
    JSON.stringify({ name: `happier-provider-${params.runtimeSpec.id}`, private: true, version: '0.0.0' }, null, 2),
    'utf8',
  );

  const childEnv = buildManagedPnpmEnvironment(params.env);
  if (runtimePathEntries.length > 0) {
    childEnv.PATH = [...runtimePathEntries, String(childEnv.PATH ?? params.env.PATH ?? '')]
      .filter((value) => value.length > 0)
      .join(delimiter);
  }
  const addArgs = ['--dir', workspaceDir, 'add', params.managedInstall.packageName];
  const spawn = params.deps.spawnSync ?? spawnSync;
  const result = spawn(pnpmCommand, addArgs, {
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

  await writeManagedPackageLauncher({
    outputPath: launcherPath,
    pnpmCommand,
    workspaceDir: launcherWorkspaceDir,
    binaryName: params.managedInstall.binaryName,
    runtimePathEntries,
  });

  await rm(join(installRoot, 'current'), { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true });
  await rename(nextDir, join(installRoot, 'current'));
}

async function resolveManagedBinaryAsset(params: Readonly<{
  providerId: string;
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  deps: ManagedInstallDeps;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ name: string; url: string; digest: string | null }>> {
  const release = await (params.deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)({
    githubRepo: params.managedInstall.githubRepo,
    userAgent: 'happier-cli',
    githubToken: params.env.GITHUB_TOKEN,
  });

  if (params.providerId === 'codex') {
    const { resolveCodexReleaseAsset } = await import('../codexRelease.js');
    const asset = resolveCodexReleaseAsset(release);
    return { name: asset.name, url: asset.url, digest: asset.digest };
  }

  throw new Error(`Unsupported managed github release provider: ${params.providerId}`);
}

export async function installManagedBinaryProviderCli(params: Readonly<{
  runtimeSpec: ProviderCliRuntimeDescriptor;
  managedInstall: Extract<AgentCliManagedInstallSpec, { kind: 'github_release_binary' }>;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deps: ManagedInstallDeps;
  appendLogLine: AppendLogLineFn;
}>): Promise<void> {
  const installRoot = resolveManagedProviderInstallDir(params.runtimeSpec.id, params.env);
  const asset = await resolveManagedBinaryAsset({
    providerId: params.runtimeSpec.id,
    managedInstall: params.managedInstall,
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
    const nextDir = join(installRoot, 'next');
    const nextBinPath = resolveStagedManagedProviderCommandPath(params.runtimeSpec, 'next', params.env);

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
    });

    params.appendLogLine(params.logPath, `# asset: ${asset.name}`);
    await rm(join(installRoot, 'current'), { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });
    await rename(nextDir, join(installRoot, 'current'));
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
