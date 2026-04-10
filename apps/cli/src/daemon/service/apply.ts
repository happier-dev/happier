import { statSync, utimesSync } from 'node:fs';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildServiceCommandEnv } from '@happier-dev/cli-common/service';

import type { DaemonServiceInstallPlan, DaemonServiceUninstallPlan, DaemonServicePlannedCommand } from './plan';
import { commandExistsInPath } from './commandExistsInPath';

export type DaemonServiceCommandFailureMode = 'best-effort' | 'strict';

function formatDaemonServiceCommand(command: DaemonServicePlannedCommand): string {
  return `${command.cmd} ${command.args.join(' ')}`.trim();
}

function runCommand(command: DaemonServicePlannedCommand): { ok: boolean; out: string | null } {
  try {
    const res = spawnSync(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildServiceCommandEnv({ cmd: command.cmd, args: command.args, env: process.env }),
    });
    const ok = (res.status ?? 1) === 0;
    const out = `${res.stdout ? String(res.stdout) : ''}${res.stderr ? String(res.stderr) : ''}`.trim();
    return { ok, out: out.length > 0 ? out : null };
  } catch {
    return { ok: false, out: null };
  }
}

function refreshLaunchctlBootstrapPath(command: DaemonServicePlannedCommand): void {
  if (command.cmd !== 'launchctl') {
    return;
  }

  const action = String(command.args[0] ?? '').trim().toLowerCase();
  if (action !== 'bootstrap') {
    return;
  }

  const plistPath = String(command.args.at(-1) ?? '').trim();
  if (!plistPath) {
    return;
  }

  try {
    const stats = statSync(plistPath);
    const now = new Date(Math.max(Date.now(), stats.mtimeMs + 1));
    utimesSync(plistPath, now, now);
  } catch {
    // best-effort
  }
}

function isBenignLaunchctlCleanupFailure(
  command: DaemonServicePlannedCommand,
  result: Readonly<{ ok: boolean; out: string | null }>,
): boolean {
  if (result.ok || command.cmd !== 'launchctl') {
    return false;
  }

  const action = String(command.args[0] ?? '').trim().toLowerCase();
  if (action !== 'bootout' && action !== 'disable' && action !== 'kickstart') {
    return false;
  }

  const output = String(result.out ?? '').trim().toLowerCase();
  return output.includes('no such process') || output.includes('could not find service');
}

function isBenignSystemctlFailure(
  command: DaemonServicePlannedCommand,
  result: Readonly<{ ok: boolean; out: string | null }>,
): boolean {
  if (result.ok || command.cmd !== 'systemctl') {
    return false;
  }

  const target = String(command.args.at(-1) ?? '').trim().toLowerCase();
  if (target !== 'happier-daemon.service') {
    return false;
  }

  const action = command.args
    .map((arg) => String(arg).trim().toLowerCase())
    .find((arg) => arg.length > 0 && !arg.startsWith('-'));
  if (action !== 'disable' && action !== 'stop') {
    return false;
  }

  const output = String(result.out ?? '').trim().toLowerCase();
  return output.includes('does not exist') || output.includes('not loaded') || output.includes('not found');
}

export function runDaemonServiceCommands(
  commands: readonly DaemonServicePlannedCommand[],
  options: Readonly<{ failureMode?: DaemonServiceCommandFailureMode }> = {},
): void {
  const failureMode = options.failureMode ?? 'best-effort';
  for (const command of commands) {
    const exists = commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT });
    if (!exists) {
      if (failureMode === 'strict') {
        throw new Error(`Background service command is not available: ${formatDaemonServiceCommand(command)}`);
      }
      continue;
    }

    refreshLaunchctlBootstrapPath(command);
    const result = runCommand(command);
    if (command.ignoreFailure || isBenignLaunchctlCleanupFailure(command, result) || isBenignSystemctlFailure(command, result)) {
      continue;
    }
    if (!result.ok && failureMode === 'strict') {
      const output = result.out ? `\n${result.out}` : '';
      throw new Error(`Background service command failed: ${formatDaemonServiceCommand(command)}${output}`);
    }
  }
}

export async function applyDaemonServiceInstallPlan(
  plan: DaemonServiceInstallPlan,
  options: Readonly<{ runCommands?: boolean; commandFailureMode?: DaemonServiceCommandFailureMode }> = {},
): Promise<void> {
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf-8');
    await chmod(file.path, file.mode);
  }

  if (options.runCommands === false) return;
  runDaemonServiceCommands(plan.commands, {
    failureMode: options.commandFailureMode,
  });
}

export async function applyDaemonServiceUninstallPlan(
  plan: DaemonServiceUninstallPlan,
  options: Readonly<{ runCommands?: boolean; commandFailureMode?: DaemonServiceCommandFailureMode }> = {},
): Promise<void> {
  if (options.runCommands !== false) {
    runDaemonServiceCommands(plan.commands, {
      failureMode: options.commandFailureMode,
    });
  }

  for (const path of plan.filesToRemove) {
    try {
      await unlink(path);
    } catch {
      // ignore
    }
  }
}
