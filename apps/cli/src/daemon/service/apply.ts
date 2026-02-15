import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { DaemonServiceInstallPlan, DaemonServiceUninstallPlan, DaemonServicePlannedCommand } from './plan';
import { commandExistsInPath } from './commandExistsInPath';

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
    if (!commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) continue;
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
