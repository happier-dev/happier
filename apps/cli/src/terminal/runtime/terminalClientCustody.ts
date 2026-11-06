import psList from 'ps-list';
import { basename } from 'node:path';
import { processInstanceFingerprintMatches, readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { readProcessRunState } from '@/daemon/processRunState';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { logger } from '@/ui/logger';
import type { HerdrProcessInfo } from '@/integrations/herdr/client';
import type { OwnedTerminalProcessIdentity } from './ownedTerminalProcess';

export function terminalClientArgvMatchesInvocation(
  argv: readonly string[],
  invocation: Readonly<{ command: string; args: readonly string[] }>,
): boolean {
  return argv[0] === invocation.command
    && argv.length === invocation.args.length + 1
    && invocation.args.every((arg, index) => argv[index + 1] === arg);
}

/** This is process custody, not the lifetime of its borrowed terminal shell. */
export async function readTerminalClientProcessState(identity: OwnedTerminalProcessIdentity): Promise<'alive' | 'dead' | 'unknown'> {
  const state = await readProcessRunState(identity.pid);
  if (state === 'dead' || state === 'zombie') return 'dead';
  const fingerprint = readProcessInstanceFingerprintSync(identity.pid);
  if (!fingerprint) return 'unknown';
  return processInstanceFingerprintMatches(identity.processInstanceFingerprint, fingerprint) ? 'alive' : 'dead';
}

export async function retireTerminalClientProcess(identity: OwnedTerminalProcessIdentity): Promise<void> {
  const state = await readTerminalClientProcessState(identity);
  if (state === 'dead') return;
  if (state !== 'alive') throw new Error('terminal_native_client_custody_unknown');
  await killProcessTree({ pid: identity.pid });
}

/** The API foreground snapshot and real OS ancestry must prove the exact native invocation. */
export async function proveTerminalClientCustody(input: Readonly<{
  launcher: OwnedTerminalProcessIdentity;
  processes: HerdrProcessInfo;
  invocation: Readonly<{ command: string; args: readonly string[] }>;
  env?: NodeJS.ProcessEnv;
}>): Promise<boolean> {
  let invocation = input.invocation;
  const reject = (reason: string): false => {
    // Report shape/custody only: native argv can contain credentials or user context.
    logger.infoFile('[terminal] Native client custody refused', { reason,
      launcherPid: input.launcher.pid, shellPid: input.processes.shellPid,
      expectedExecutable: basename(invocation.command.replaceAll('\\', '/')),
      expectedArgvLength: invocation.args.length + 1,
      foreground: input.processes.foregroundProcesses.map(process => ({ pid: process.pid,
        executable: basename((process.argv[0] ?? '').replaceAll('\\', '/')), argvLength: process.argv.length,
      })),
    });
    return false;
  };
  if (await readTerminalClientProcessState(input.launcher) !== 'alive') return reject('launcher_not_alive');
  if (!input.processes.shellPid) return reject('missing_shell');
  const processes = await psList();
  const parents = new Map(processes.map(process => [process.pid, process.ppid]));
  const descendsFrom = (pid: number, ancestor: number): boolean => {
    const seen = new Set<number>();
    while (pid > 1 && !seen.has(pid)) {
      if (pid === ancestor) return true;
      seen.add(pid);
      pid = parents.get(pid) ?? 0;
    }
    return false;
  };
  const launcher = input.processes.foregroundProcesses.find(process => process.pid === input.launcher.pid);
  if (!launcher) return reject('launcher_not_foreground');
  if (!launcher.argv.some(arg => basename(arg) === 'terminal_launch_spec_runner.cjs')) return reject('launcher_command_unrecognized');
  if (!descendsFrom(input.launcher.pid, input.processes.shellPid)) return reject('launcher_not_within_shell');
  // Match prepareOwnedTerminalSpawn's executable/argv, including per-target Windows shims.
  invocation = resolveWindowsCommandInvocation({ ...input.invocation, env: input.env ?? process.env,
    resolveCommandOnPath: false });
  const native = input.processes.foregroundProcesses.some(process => process.pid !== input.launcher.pid
    && descendsFrom(process.pid, input.launcher.pid)
    && terminalClientArgvMatchesInvocation(process.argv, invocation));
  if (input.processes.foregroundProcesses.some(process => !descendsFrom(process.pid, input.launcher.pid)
    && !descendsFrom(input.launcher.pid, process.pid))) return reject('unrelated_foreground_process');
  if (!native) return reject('native_invocation_not_observed');
  // Awaited OS discovery must not admit a recycled launcher instance.
  return await readTerminalClientProcessState(input.launcher) === 'alive' || reject('launcher_changed');
}
