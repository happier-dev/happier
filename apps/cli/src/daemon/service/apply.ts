import { statSync, utimesSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnBackgroundSync } from '@happier-dev/cli-common/process';

import { applyServicePlan, buildServiceCommandEnv, isBenignServiceAbsenceFailure } from '@happier-dev/cli-common/service';

import type { DaemonServiceInstallPlan, DaemonServiceUninstallPlan, DaemonServicePlannedCommand } from './plan';
import { commandExistsInPath } from './commandExistsInPath';
import { readLaunchctlFailureReason } from './launchctlFailure';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { DaemonServiceError, type DaemonServiceFailureFacts } from './failure';

export type DaemonServiceCommandFailureMode = 'best-effort' | 'strict';

function formatDaemonServiceCommand(command: DaemonServicePlannedCommand): string {
  return `${command.cmd} ${command.args.join(' ')}`.trim();
}

function commandServiceStep(command: DaemonServicePlannedCommand): DaemonServiceFailureFacts['serviceStep'] {
  if (command.cmd !== 'launchctl') return 'command';
  const action = command.args[0];
  if (action === 'bootout') return 'cleanup_bootout';
  return action === 'bootstrap' || action === 'kickstart' ? action : 'command';
}

function unavailableServiceCommand(command: DaemonServicePlannedCommand, preflight = false): DaemonServiceError {
  return new DaemonServiceError(`Background service command is not available: ${formatDaemonServiceCommand(command)}`, {
    error: 'service_manager_unavailable',
    serviceStep: preflight ? 'preflight' : commandServiceStep(command),
    serviceStepStatus: 'unavailable',
  });
}

export function assertDaemonServiceCommandsAvailable(commands: readonly DaemonServicePlannedCommand[]): void {
  for (const command of commands) {
    if (command.ignoreFailure) continue;
    if (!commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) {
      throw unavailableServiceCommand(command, true);
    }
  }
}

/** Prove Linux's selected systemd manager is reachable before writing its unit. */
export function assertDaemonServiceManagerAvailable(commands: readonly DaemonServicePlannedCommand[], deadlineMs?: number): void {
  const reload = commands.find((command) => command.cmd === 'systemctl' && command.args.includes('daemon-reload'));
  if (!reload) return;
  const reloadIndex = reload.args.indexOf('daemon-reload');
  const probe = { cmd: reload.cmd, args: [...reload.args.slice(0, reloadIndex), 'show-environment'] };
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw serviceStartupTimeout(probe);
  const result = runCommand(probe, deadlineMs);
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw serviceStartupTimeout(probe, result);
  if (!result.ok) throw unavailableServiceCommand(probe, true);
}

type CommandResult = Readonly<{ ok: boolean; out: string | null; status: number | null }>;

function runCommand(command: DaemonServicePlannedCommand, deadlineMs?: number): CommandResult {
  try {
    const timeoutMs = deadlineMs === undefined
      ? readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS', 30_000)
      : deadlineMs - Date.now();
    if (timeoutMs <= 0) return { ok: false, out: null, status: null };
    const res = spawnBackgroundSync(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildServiceCommandEnv({ cmd: command.cmd, args: command.args, env: process.env }),
      timeout: timeoutMs,
    });
    const ok = (res.status ?? 1) === 0;
    const out = `${res.stdout ? String(res.stdout) : ''}${res.stderr ? String(res.stderr) : ''}`.trim();
    return { ok, out: out.length > 0 ? out : null, status: typeof res.status === 'number' ? res.status : null };
  } catch {
    return { ok: false, out: null, status: null };
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

function isBenignLaunchctlFailure(
  command: DaemonServicePlannedCommand,
  result: CommandResult,
): boolean {
  if (result.ok || command.cmd !== 'launchctl') {
    return false;
  }

  if (isBenignServiceAbsenceFailure({
    cmd: command.cmd,
    args: command.args,
    status: result.status,
    stdout: result.out,
    stderr: '',
  })) {
    return true;
  }

  return false;
}

function isBenignSystemctlFailure(
  command: DaemonServicePlannedCommand,
  result: CommandResult,
): boolean {
  if (result.ok || command.cmd !== 'systemctl') {
    return false;
  }

  const target = String(command.args.at(-1) ?? '').trim().toLowerCase();
  if (!target.startsWith('happier-daemon') || !target.endsWith('.service')) {
    return false;
  }

  const action = command.args
    .map((arg) => String(arg).trim().toLowerCase())
    .find((arg) => arg.length > 0 && !arg.startsWith('-'));
  if (action !== 'disable' && action !== 'stop') {
    return false;
  }

  return isBenignServiceAbsenceFailure({
    cmd: command.cmd,
    args: command.args,
    status: result.status,
    stdout: result.out,
    stderr: '',
  });
}

function serviceStartupTimeout(command: DaemonServicePlannedCommand, result?: CommandResult) {
  const reason = readLaunchctlFailureReason(result?.out ?? '');
  return new DaemonServiceError(`Background service startup deadline elapsed${reason ? ` (reason: ${reason})` : ''}${result?.out ? `\n${result.out}` : ''}`, {
    error: 'service_start_timeout',
    serviceStep: commandServiceStep(command),
    serviceStepStatus: 'deadline_elapsed',
    reason,
  });
}

/** launchctl has no readiness push API; reuse the existing retry cadence and
 * the caller's remaining startup budget without repeating destructive bootout. */
function runLaunchctlWithRetry(command: DaemonServicePlannedCommand, deadlineMs?: number): CommandResult {
  const delaysMs = [150, 300, 600];
  let retry = 0;
  while (true) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw serviceStartupTimeout(command);
    const result = runCommand(command, deadlineMs);
    if (result.ok || isBenignLaunchctlFailure(command, result)) return { ...result, ok: true };
    if (!readLaunchctlFailureReason(result.out ?? '')) return result;
    if (deadlineMs === undefined && retry >= delaysMs.length) return result;
    const remainingMs = deadlineMs === undefined ? Infinity : deadlineMs - Date.now();
    if (remainingMs <= 0) throw serviceStartupTimeout(command, result);
    const ms = Math.min(delaysMs[Math.min(retry++, delaysMs.length - 1)]!, remainingMs);
    const { status } = spawnBackgroundSync('sleep', [(ms / 1000).toFixed(3)]);
    if (status !== 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw serviceStartupTimeout(command, result);
  }
}

function shouldRetryLaunchctlCommand(command: DaemonServicePlannedCommand): boolean {
  if (command.cmd !== 'launchctl') return false;
  const action = String(command.args[0] ?? '').trim().toLowerCase();
  return action === 'kickstart' || action === 'bootstrap';
}

export function runDaemonServiceCommands(
  commands: readonly DaemonServicePlannedCommand[],
  options: Readonly<{ failureMode?: DaemonServiceCommandFailureMode; deadlineMs?: number }> = {},
): void {
  const failureMode = options.failureMode ?? 'best-effort';
  const failures: Error[] = [];
  for (const command of commands) {
    if (failures.length > 0 && !command.runOnFailure) continue;
    const exists = commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT });
    if (!exists) {
      if (failureMode === 'strict' && !command.ignoreFailure) {
        failures.push(unavailableServiceCommand(command));
      }
      continue;
    }

    refreshLaunchctlBootstrapPath(command);
    let result: CommandResult;
    try {
      if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) throw serviceStartupTimeout(command);
      result = shouldRetryLaunchctlCommand(command) ? runLaunchctlWithRetry(command, options.deadlineMs) : runCommand(command, options.deadlineMs);
    } catch (error) {
      if (failureMode === 'strict' && !command.ignoreFailure) failures.push(error instanceof Error ? error : new Error(String(error)));
      continue;
    }
    if (command.ignoreFailure || isBenignSystemctlFailure(command, result)
      || !shouldRetryLaunchctlCommand(command) && isBenignLaunchctlFailure(command, result)) {
      continue;
    }
    if (!result.ok && failureMode === 'strict') {
      const output = result.out ? `\n${result.out}` : '';
      failures.push(new DaemonServiceError(`Background service command failed: ${formatDaemonServiceCommand(command)}${output}`, {
        error: 'service_command_failed', serviceStep: commandServiceStep(command), serviceStepStatus: 'failed',
        reason: command.cmd === 'launchctl' ? readLaunchctlFailureReason(result.out ?? '') : undefined,
      }));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n'));
  }
}

export async function applyDaemonServiceInstallPlan(
  plan: DaemonServiceInstallPlan,
  options: Readonly<{ runCommands?: boolean; commandFailureMode?: DaemonServiceCommandFailureMode; deadlineMs?: number }> = {},
): Promise<void> {
  if (options.runCommands !== false) {
    assertDaemonServiceCommandsAvailable(plan.commands);
    assertDaemonServiceManagerAvailable(plan.commands, options.deadlineMs);
  }
  await applyServicePlan({ writes: [], copies: plan.copies, commands: [] }, { runCommands: false });
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf-8');
    await chmod(file.path, file.mode);
  }

  if (options.runCommands === false) return;
  runDaemonServiceCommands(plan.commands, {
    failureMode: options.commandFailureMode,
    deadlineMs: options.deadlineMs,
  });
}

export async function applyDaemonServiceUninstallPlan(
  plan: DaemonServiceUninstallPlan,
  options: Readonly<{ runCommands?: boolean; commandFailureMode?: DaemonServiceCommandFailureMode; deadlineMs?: number }> = {},
): Promise<void> {
  const commands = options.runCommands === false ? [] : plan.commands;
  const removals = plan.removals ?? plan.filesToRemove.map((path) => ({ path, beforeCommandIndex: commands.length }));
  await applyServicePlan({
    writes: [], commands,
    removals: options.runCommands === false
      ? removals.map((removal) => ({ ...removal, beforeCommandIndex: 0 }))
      : removals,
  }, {
    commandTimeoutMs: options.deadlineMs === undefined
      ? readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS', 30_000)
      : undefined,
    deadlineMs: options.deadlineMs,
    deadlineError: (command) => serviceStartupTimeout(command),
  });
}
