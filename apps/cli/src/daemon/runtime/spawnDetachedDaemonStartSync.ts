import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import { configuration } from '@/configuration';
import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';
import {
  parsePowerShellStartProcessPid,
} from '@/daemon/platform/windows/visibleConsoleSpawn';
import { resolveDaemonLaunchSpec } from './resolveDaemonLaunchSpec';

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
    `$p = Start-Process -FilePath ${toPowerShellStringLiteral(params.filePath)} -ArgumentList ${argsArrayLiteral} -WorkingDirectory ${toPowerShellStringLiteral(params.cwd)} -WindowStyle Hidden -PassThru;`,
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
}>): Promise<ChildProcess> {
  const workingDirectory = typeof params.cwd === 'string' && params.cwd.trim().length > 0
    ? params.cwd
    : process.cwd();
  const invocation = buildWindowsDetachedDaemonCreateInvocation({
    filePath: params.filePath,
    args: params.args,
    env: params.env,
    cwd: workingDirectory,
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

    child.stdout?.on('data', (data) => {
      stdout += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });
    child.stderr?.on('data', (data) => {
      stderr += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });

    child.once('error', (error) => {
      reject(error instanceof Error ? error : new Error('Failed to spawn PowerShell launcher'));
    });

    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell launcher exited with code ${code}: ${(stderr || stdout).trim()}`.trim()));
        return;
      }

      const pid = parsePowerShellStartProcessPid(stdout);
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        resolve(child);
        return;
      }

      reject(new Error(`Failed to parse detached daemon pid from PowerShell output: ${stdout.trim()}`));
    });
  });
}

export async function spawnDetachedDaemonStartSync(
  options: Readonly<SpawnOptions & { startupSource?: DaemonStartupSource }> = {},
): Promise<ChildProcess> {
  const { startupSource, ...spawnOptions } = options;
  const launchSpec = await resolveDaemonLaunchSpec(['daemon', 'start-sync']);
  const env = {
    ...(spawnOptions.env ?? process.env),
    ...(launchSpec.env ?? {}),
  };

  // Detached daemon is typically spawned via `node <entry> daemon start-sync`, so argv no longer encodes
  // the shim name (`hprev`/`hdev`). Force the lane into the child environment so daemon state files are
  // scoped per public release channel.
  if (!String(env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? '').trim()) {
    env.HAPPIER_PUBLIC_RELEASE_CHANNEL = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;
  }
  if (!String(env.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim()) {
    env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSource ?? 'manual';
  }

  if (process.platform === 'win32') {
    return await spawnWindowsDetachedDaemonStartSync({
      filePath: launchSpec.filePath,
      args: launchSpec.args,
      env,
      cwd: typeof spawnOptions.cwd === 'string' ? spawnOptions.cwd : undefined,
    });
  }

  return spawn(launchSpec.filePath, launchSpec.args, {
    ...spawnOptions,
    env,
    detached: true,
    stdio: 'ignore',
  });
}
