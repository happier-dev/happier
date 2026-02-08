import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { DaemonServiceInstallPlan, DaemonServiceUninstallPlan, DaemonServicePlannedCommand } from './plan';

function commandExistsInPath(cmd: string, envPath: string | undefined): boolean {
  const pathDirs = (envPath ?? '').split(delimiter).map((p) => p.trim()).filter(Boolean);
  for (const dir of pathDirs) {
    const full = join(dir, cmd);
    if (!existsSync(full)) continue;
    return true;
  }
  return false;
}

function runCommandBestEffort(command: DaemonServicePlannedCommand): boolean {
  try {
    const res = spawnSync(command.cmd, [...command.args], {
      stdio: 'ignore',
      env: process.env,
    });
    return (res.status ?? 1) === 0;
  } catch {
    return false;
  }
}

async function runCommandsBestEffort(commands: readonly DaemonServicePlannedCommand[]): Promise<void> {
  for (const command of commands) {
    if (!commandExistsInPath(command.cmd, process.env.PATH)) continue;
    runCommandBestEffort(command);
  }
}

export async function applyDaemonServiceInstallPlan(
  plan: DaemonServiceInstallPlan,
  options: Readonly<{ runCommands?: boolean }> = {},
): Promise<void> {
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf-8');
    await chmod(file.path, file.mode);
  }

  if (options.runCommands === false) return;
  await runCommandsBestEffort(plan.commands);
}

export async function applyDaemonServiceUninstallPlan(
  plan: DaemonServiceUninstallPlan,
  options: Readonly<{ runCommands?: boolean }> = {},
): Promise<void> {
  if (options.runCommands !== false) {
    await runCommandsBestEffort(plan.commands);
  }

  for (const path of plan.filesToRemove) {
    try {
      await unlink(path);
    } catch {
      // ignore
    }
  }
}
