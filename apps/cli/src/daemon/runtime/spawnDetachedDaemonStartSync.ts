import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { withDaemonAllocatorEnvironment } from './daemonAllocatorEnvironment';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import { configuration } from '@/configuration';
import { resolveCliHappyHomeDir } from '@/configuration/resolveCliHappyHomeDir';
import { resolveCliHomeStoragePaths } from '@/configuration/homeStoragePaths';
import { DAEMON_STDERR_LOG_PATH_ENV } from '@/utils/logs/logRetention';
import { createTimestampForFilename } from '@/utils/logs/logFileName';
import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';
import {
  buildSystemdUserCriticalScopedLaunchSpec,
  isSystemdUserCriticalResourceGovernorReady,
} from '@/daemon/platform/linux/systemdUserResourceGovernor';
import {
  parsePowerShellStartProcessPid,
} from '@/daemon/platform/windows/visibleConsoleSpawn';
import { resolveDaemonLaunchSpec } from './resolveDaemonLaunchSpec';
import { withProcessOwnerEnvironment } from '@/processes/ownerTag';
import { stripDaemonServiceInstallRequestEnv } from '@/utils/processEnv/stripDaemonServiceInstallRequestEnv';

export type DetachedDaemonStartProcess = ChildProcess & { detachedDaemonPid?: number };

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function toPowerShellStringLiteral(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

function shouldForwardDetachedDaemonEnvKey(key: string): boolean {
  const normalized = String(key ?? '').trim();
  return normalized.startsWith('HAPPIER_');
}

function buildWindowsDetachedDaemonCreateInvocation(params: Readonly<{
  filePath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stderrPath: string;
}>): Readonly<{ command: string; args: string[] }> {
  const forwardedEnvAssignments = Object.entries(params.env)
    .flatMap(([key, value]) => (
      shouldForwardDetachedDaemonEnvKey(key) && typeof value === 'string' && value.length > 0
        ? [`$env:${key} = ${toPowerShellStringLiteral(value)};`]
        : []
    ));

  const argsArrayLiteral = `@(${params.args.map((arg) => toPowerShellStringLiteral(arg)).join(', ')})`;
  const script = [
    '$ErrorActionPreference = "Stop";',
    ...forwardedEnvAssignments,
    `$p = Start-Process -FilePath ${toPowerShellStringLiteral(params.filePath)} -ArgumentList ${argsArrayLiteral} -WorkingDirectory ${toPowerShellStringLiteral(params.cwd)} -WindowStyle Hidden -RedirectStandardOutput 'NUL' -RedirectStandardError ${toPowerShellStringLiteral(params.stderrPath)} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}

async function spawnWindowsDetachedDaemonStartSync(params: Readonly<{
  filePath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stderrPath: string;
}>): Promise<DetachedDaemonStartProcess> {
  const workingDirectory = typeof params.cwd === 'string' && params.cwd.trim().length > 0
    ? params.cwd
    : process.cwd();
  const invocation = buildWindowsDetachedDaemonCreateInvocation({
    filePath: params.filePath,
    args: params.args,
    env: params.env,
    cwd: workingDirectory,
    stderrPath: params.stderrPath,
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workingDirectory,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let launcherExitCode: number | null | undefined;

    const completeLaunch = (outputClosed = false): boolean => {
      if (launcherExitCode === undefined) return false;
      if (launcherExitCode !== 0) {
        if (!outputClosed) return false;
        reject(new Error(`PowerShell launcher exited with code ${launcherExitCode}: ${(stderr || stdout).trim()}`.trim()));
        return true;
      }
      // Write-Output terminates the PID line. A data event can carry only a
      // prefix, especially when output arrives after the launcher's exit.
      if (!outputClosed && !stdout.replaceAll('\u0000', '').includes('\n')) return false;
      const pid = parsePowerShellStartProcessPid(stdout);
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
      // Start-Process descendants can retain PowerShell's pipe handles after
      // PowerShell exits. Waiting for `close` waits for the daemon's lifetime,
      // so settle on launcher exit + its PID and release these unused pipes.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(Object.assign(child, { detachedDaemonPid: pid }));
      return true;
    };

    child.stdout?.on('data', (data) => {
      stdout += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      completeLaunch();
    });
    child.stderr?.on('data', (data) => {
      stderr += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });

    child.once('error', (error) => {
      reject(error instanceof Error ? error : new Error('Failed to spawn PowerShell launcher'));
    });

    child.once('exit', (code) => {
      launcherExitCode = code;
      completeLaunch();
    });

    child.once('close', (code) => {
      launcherExitCode = code;
      if (!completeLaunch(true)) {
        reject(new Error(`Failed to parse detached daemon pid from PowerShell output: ${stdout.trim()}`));
      }
    });
  });
}

export async function spawnDetachedDaemonStartSync(
  options: Readonly<SpawnOptions & { startupSource?: DaemonStartupSource }> = {},
): Promise<DetachedDaemonStartProcess> {
  const { startupSource, ...spawnOptions } = options;
  const requestedEnv = spawnOptions.env ?? process.env;
  const launchSpec = await resolveDaemonLaunchSpec(['daemon', 'start-sync'], requestedEnv);
  const env = withProcessOwnerEnvironment(stripDaemonServiceInstallRequestEnv(withDaemonAllocatorEnvironment({
    ...requestedEnv,
    ...(launchSpec.env ?? {}),
  }, process.platform)), { kind: 'happier' }, requestedEnv.HAPPIER_HOME_DIR);

  // Detached daemon is typically spawned via `node <entry> daemon start-sync`, so argv no longer encodes
  // the shim name (`hprev`/`hdev`). Force the lane into the child environment so daemon state files are
  // scoped per public release channel.
  if (!String(env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? '').trim()) {
    env.HAPPIER_PUBLIC_RELEASE_CHANNEL = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;
  }
  if (!String(env.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim()) {
    env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSource ?? 'manual';
  }

  const scopedLaunchSpec = process.platform !== 'win32'
    && await isSystemdUserCriticalResourceGovernorReady({ environment: env })
    ? buildSystemdUserCriticalScopedLaunchSpec({
      launchSpec: {
        filePath: launchSpec.filePath,
        args: launchSpec.args,
      },
    })
    : launchSpec;

  const { logsDir } = resolveCliHomeStoragePaths(resolveCliHappyHomeDir(env));
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  // A launcher PID identifies this attempt even when systemd-run or PowerShell
  // owns the first child. The daemon writes its own PID when startup begins.
  // Keep the daemon suffix so the existing log-retention owner includes it.
  const stderrPath = join(logsDir, `${createTimestampForFilename()}-${randomUUID()}-stderr-daemon.log`);
  env[DAEMON_STDERR_LOG_PATH_ENV] = stderrPath;
  const stderrFd = openSync(stderrPath, 'ax', 0o600);
  try {
    if (process.platform === 'win32') {
      // Windows Start-Process owns the child's inherited file handle. It stays
      // writable after PowerShell exits and needs no pipe-forwarding process.
      closeSync(stderrFd);
      return await spawnWindowsDetachedDaemonStartSync({
        filePath: launchSpec.filePath,
        args: launchSpec.args,
        env,
        cwd: typeof spawnOptions.cwd === 'string' ? spawnOptions.cwd : undefined,
        stderrPath,
      });
    }
    return spawn(scopedLaunchSpec.filePath, scopedLaunchSpec.args, {
      ...spawnOptions,
      env,
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
    });
  } finally {
    if (process.platform !== 'win32') closeSync(stderrFd);
  }
}
