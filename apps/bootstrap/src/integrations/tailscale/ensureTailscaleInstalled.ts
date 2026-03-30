import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { constants } from 'node:fs';

import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';
import {
  extractTailscaleInstallerDownloadUrl,
  resolveTailscaleBin,
  resolveTailscaleInstallStrategy,
} from '@happier-dev/cli-common/tailscale';

import { runCommandCapture, type CommandExecutionResult } from '../../systemTasks/taskRuntime.js';

type ResponseLike = Readonly<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>;

type EnsureTailscaleInstalledDeps = Readonly<{
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  runCommand?: (params: Readonly<{
    command: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }>) => Promise<CommandExecutionResult>;
  resolveTailscaleBin?: typeof resolveTailscaleBin;
  resolveInstallStrategy?: typeof resolveTailscaleInstallStrategy;
  extractInstallerDownloadUrl?: typeof extractTailscaleInstallerDownloadUrl;
  resolveCacheDir?: (env: NodeJS.ProcessEnv) => string;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}>;

export type EnsureTailscaleInstalledResult =
  | Readonly<{
      outcome: 'ready';
      installedNow: boolean;
      installerLaunched: boolean;
      tailscaleBin: string;
    }>
  | Readonly<{
      outcome: 'prompt';
      installerLaunched: boolean;
      prompt: Readonly<{
        platform: NodeJS.Platform;
        url: string;
        reason: 'manual_install_required' | 'installer_unavailable' | 'install_incomplete';
      }>;
    }>;

export async function ensureTailscaleInstalled(
  params: Readonly<{
    signal?: AbortSignal;
  }> = {},
  deps: EnsureTailscaleInstalledDeps = {},
): Promise<EnsureTailscaleInstalledResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const resolveBin = deps.resolveTailscaleBin ?? resolveTailscaleBin;
  const existingBin = await tryResolveTailscaleBin({ env, resolveBin });
  if (existingBin) {
    return {
      outcome: 'ready',
      installedNow: false,
      installerLaunched: false,
      tailscaleBin: existingBin,
    };
  }

  const strategy = (deps.resolveInstallStrategy ?? resolveTailscaleInstallStrategy)(platform, env);
  if (strategy.kind === 'manual') {
    return {
      outcome: 'prompt',
      installerLaunched: false,
      prompt: {
        platform,
        url: strategy.docsUrl,
        reason: 'manual_install_required',
      },
    };
  }

  try {
    const fetcher = deps.fetch ?? defaultFetch;
    const manifestResponse = await fetcher(strategy.manifestUrl, { redirect: 'follow' });
    if (!manifestResponse.ok) {
      throw new Error(`Failed to fetch Tailscale installer manifest (${manifestResponse.status} ${manifestResponse.statusText})`);
    }

    const manifestText = await manifestResponse.text();
    const downloadUrl = (deps.extractInstallerDownloadUrl ?? extractTailscaleInstallerDownloadUrl)({
      platform,
      manifestText,
      manifestUrl: strategy.manifestUrl,
    });
    if (!downloadUrl) {
      throw new Error(`No Tailscale installer URL found for ${platform}`);
    }

    const installerResponse = await fetcher(downloadUrl, { redirect: 'follow' });
    if (!installerResponse.ok) {
      throw new Error(`Failed to download Tailscale installer (${installerResponse.status} ${installerResponse.statusText})`);
    }

    const installerBytes = Buffer.from(await installerResponse.arrayBuffer());
    const cacheDir = (deps.resolveCacheDir ?? resolveTailscaleInstallerCacheDir)(env);
    await (deps.mkdir ?? mkdir)(cacheDir, { recursive: true });
    const installerPath = join(cacheDir, resolveInstallerFilename(downloadUrl, platform));
    await (deps.writeFile ?? writeFile)(installerPath, installerBytes);

    await launchInstaller({
      installerPath,
      platform,
      env,
      runCommand: deps.runCommand ?? runCommandCapture,
    });

    const installedBin = await waitForTailscaleBin({
      env,
      resolveTailscaleBin: resolveBin,
      timeoutMs: strategy.waitForCliTimeoutMs,
      pollIntervalMs: strategy.pollIntervalMs,
      signal: params.signal,
      sleep: deps.sleep ?? defaultSleep,
      now: deps.now ?? Date.now,
    });
    if (!installedBin) {
      return {
        outcome: 'prompt',
        installerLaunched: true,
        prompt: {
          platform,
          url: strategy.docsUrl,
          reason: 'install_incomplete',
        },
      };
    }

    if (platform === 'darwin' && strategy.postInstallAppLaunch) {
      await launchMacApp({
        appName: strategy.postInstallAppLaunch,
        env,
        runCommand: deps.runCommand ?? runCommandCapture,
      });
    }

    return {
      outcome: 'ready',
      installedNow: true,
      installerLaunched: true,
      tailscaleBin: installedBin,
    };
  } catch {
    return {
      outcome: 'prompt',
      installerLaunched: false,
      prompt: {
        platform,
        url: strategy.docsUrl,
        reason: 'installer_unavailable',
      },
    };
  }
}

async function tryResolveTailscaleBin(params: Readonly<{
  env: NodeJS.ProcessEnv;
  resolveBin: typeof resolveTailscaleBin;
}>): Promise<string | null> {
  try {
    const resolved = await params.resolveBin({ env: params.env });
    if (looksLikeFilesystemPath(resolved)) {
      try {
        await access(resolved, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch {
        return null;
      }
    }
    return resolved;
  } catch {
    return null;
  }
}

async function launchInstaller(params: Readonly<{
  installerPath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  runCommand: (params: Readonly<{
    command: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }>) => Promise<CommandExecutionResult>;
}>): Promise<void> {
  const invocation = params.platform === 'darwin'
    ? { command: 'open', args: [params.installerPath] as readonly string[], timeoutMs: 30_000 }
    : { command: params.installerPath, args: [] as readonly string[], timeoutMs: 180_000 };
  const result = await params.runCommand({
    command: invocation.command,
    args: invocation.args,
    env: params.env,
    timeoutMs: invocation.timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Failed to launch Tailscale installer for ${params.platform}`);
  }
}

async function launchMacApp(params: Readonly<{
  appName: string;
  env: NodeJS.ProcessEnv;
  runCommand: (params: Readonly<{
    command: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }>) => Promise<CommandExecutionResult>;
}>): Promise<void> {
  await params.runCommand({
    command: 'open',
    args: ['-a', params.appName],
    env: params.env,
    timeoutMs: 15_000,
  }).catch(() => undefined);
}

async function waitForTailscaleBin(params: Readonly<{
  env: NodeJS.ProcessEnv;
  resolveTailscaleBin: typeof resolveTailscaleBin;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}>): Promise<string | null> {
  const deadline = params.now() + params.timeoutMs;
  while (params.now() <= deadline) {
    if (params.signal?.aborted) {
      throw createAbortError();
    }
    const resolved = await tryResolveTailscaleBin({
      env: params.env,
      resolveBin: params.resolveTailscaleBin,
    });
    if (resolved) {
      return resolved;
    }
    if (params.now() >= deadline) {
      break;
    }
    await params.sleep(params.pollIntervalMs, params.signal);
  }
  return null;
}

function resolveTailscaleInstallerCacheDir(env: NodeJS.ProcessEnv): string {
  return join(resolveHappyHomeDirFromEnvironment(env), 'cache', 'tailscale', 'installers');
}

function resolveInstallerFilename(downloadUrl: string, platform: NodeJS.Platform): string {
  try {
    const parsed = new URL(downloadUrl);
    const candidate = basename(parsed.pathname).trim();
    if (candidate) {
      return candidate;
    }
  } catch {
    // ignore
  }
  return platform === 'darwin' ? 'tailscale.pkg' : 'tailscale-setup.exe';
}

function looksLikeFilesystemPath(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\');
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

async function defaultFetch(input: string, init?: RequestInit): Promise<ResponseLike> {
  return await fetch(input, init);
}
