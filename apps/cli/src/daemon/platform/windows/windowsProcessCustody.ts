import { win32 as windowsPath } from 'node:path';

import { execFileWithDeadline, isPidPresent } from '@happier-dev/cli-common/process';
import {
  taskkillWindowsProcessTree,
  type TaskkillWindowsProcessTreeDisposition,
} from '@/subprocess/supervision/taskkillWindowsProcessTree';

import { readProcessIdentityByPid } from '../../processIdentity';
import { hashProcessCommand } from '../../sessionRegistry';
import type {
  CancelStartupLaunch,
  StartupLaunchCancellationResult,
} from '../../spawn/startupLaunchCancellation';
import { parseWindowsCommandLine } from './windowsCommandLine';
import {
  readWindowsProcessInventory,
  type WindowsProcessInventoryFact,
} from './windowsProcessInventory';

export type WindowsTerminalLaunchCustody = Readonly<{
  executablePath: string;
  argv: readonly string[];
  correlation: string;
}>;

export type ExactWindowsProcessCancellationIdentity = Readonly<{
  pid: number;
  processStartTimeMs: number;
  processCommandHash: string;
}>;

type ReadExactWindowsProcessIdentity = (
  pid: number,
) => Promise<Readonly<{
  pid?: number;
  processStartTimeMs: number;
  command?: string;
  executablePath?: string;
}> | null>;

export type WindowsProcessCustodyDependencies = Readonly<{
  readAllWindowsProcessFactsFn?: () => Promise<
    ReadonlyMap<number, WindowsProcessInventoryFact>
  >;
  readProcessIdentityByPidFn?: ReadExactWindowsProcessIdentity;
  terminateProcessTreeFn?: (input: Readonly<{
    pid: number;
    force: boolean;
  }>) => Promise<TaskkillWindowsProcessTreeDisposition | void>;
  isPidAliveFn?: (pid: number) => boolean;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  quiescenceMs?: number;
}>;

function normalizeWindowsExecutablePath(value: string): string {
  const trimmed = value.trim().replace(/^\\\\\?\\/u, '');
  return windowsPath.normalize(trimmed).toLowerCase();
}

function matchesExactWindowsTerminalLaunch(
  process: WindowsProcessInventoryFact,
  launch: WindowsTerminalLaunchCustody,
): boolean {
  if (
    !process.executablePath
    || !process.command
    || normalizeWindowsExecutablePath(process.executablePath)
      !== normalizeWindowsExecutablePath(launch.executablePath)
  ) {
    return false;
  }
  const actualArgv = parseWindowsCommandLine(process.command);
  if (
    actualArgv.length !== launch.argv.length + 1
    || normalizeWindowsExecutablePath(actualArgv[0] ?? '')
      !== normalizeWindowsExecutablePath(launch.executablePath)
  ) {
    return false;
  }
  for (let index = 0; index < launch.argv.length; index += 1) {
    if (actualArgv[index + 1] !== launch.argv[index]) return false;
  }
  const correlationIndexes = actualArgv.flatMap(
    (arg, index) =>
      arg === '--happy-terminal-launch-correlation'
        ? [index]
        : [],
  );
  return correlationIndexes.length === 1
    && actualArgv[correlationIndexes[0]! + 1]
      === launch.correlation;
}

export function captureExactWindowsTerminalLaunchProcess(
  input: Readonly<{
    process: WindowsProcessInventoryFact;
    launch: WindowsTerminalLaunchCustody;
  }>,
): ExactWindowsProcessCancellationIdentity | null {
  if (
    !Number.isInteger(input.process.processStartTimeMs)
    || (input.process.processStartTimeMs ?? -1) < 0
    || !matchesExactWindowsTerminalLaunch(
      input.process,
      input.launch,
    )
    || !input.process.command
  ) {
    return null;
  }
  return {
    pid: input.process.pid,
    processStartTimeMs: input.process.processStartTimeMs!,
    processCommandHash: hashProcessCommand(
      input.process.command,
    ),
  };
}

export function createExactWindowsProcessCancellation(
  params: Readonly<{
    pid: number;
    processStartTimeMs: number | null;
    processCommandHash?: string;
    readProcessIdentityByPidFn?: ReadExactWindowsProcessIdentity;
    terminateProcessTreeFn?: (input: Readonly<{
      pid: number;
      force: boolean;
    }>) => Promise<TaskkillWindowsProcessTreeDisposition | void>;
    isPidAliveFn?: (pid: number) => boolean;
  }>,
): CancelStartupLaunch {
  const readIdentity =
    params.readProcessIdentityByPidFn ?? readProcessIdentityByPid;
  const terminateProcessTree =
    params.terminateProcessTreeFn ?? taskkillWindowsProcessTree;
  // Shared canonical probe, not a local copy: custody's own version used a bare `catch`, so an
  // access-denied process read as dead and this function reported `{ status: 'stopped' }` for a
  // process that was still running.
  const checkPidAlive = params.isPidAliveFn ?? isPidPresent;
  let cancellation: ReturnType<CancelStartupLaunch> | null = null;

  return () => {
    cancellation ??= (async () => {
      if (params.processStartTimeMs === null) {
        return {
          status: 'incomplete' as const,
          reason: 'terminal_host_custody_unproven' as const,
        };
      }
      const before = await readIdentity(params.pid);
      if (!before) {
        return checkPidAlive(params.pid)
          ? {
              status: 'incomplete' as const,
              reason: 'terminal_host_custody_unproven' as const,
            }
          : { status: 'stopped' as const };
      }
      if (
        before.processStartTimeMs !== params.processStartTimeMs
        || (
          params.processCommandHash
          && (
            !before.command?.trim()
            || hashProcessCommand(before.command)
              !== params.processCommandHash
          )
        )
      ) {
        return {
          status: 'incomplete' as const,
          reason: 'terminal_host_custody_unproven' as const,
        };
      }
      try {
        const disposition = await terminateProcessTree({
          pid: params.pid,
          force: true,
        });
        if (disposition === 'root_not_found') {
          return {
            status: 'incomplete' as const,
            reason: 'terminal_host_disposition_failed' as const,
          };
        }
      } catch {
        return {
          status: 'incomplete' as const,
          reason: 'terminal_host_disposition_failed' as const,
        };
      }
      const after = await readIdentity(params.pid);
      const pidAliveAfterDisposition = checkPidAlive(params.pid);
      if (!after) {
        return pidAliveAfterDisposition
          ? {
              status: 'incomplete' as const,
              reason: 'terminal_host_custody_unproven' as const,
            }
          : { status: 'stopped' as const };
      }
      if (
        after.processStartTimeMs !== params.processStartTimeMs
        || (
          params.processCommandHash
          && (
            !after.command?.trim()
            || hashProcessCommand(after.command)
              !== params.processCommandHash
          )
        )
      ) {
        return pidAliveAfterDisposition
          ? {
              status: 'incomplete' as const,
              reason: 'terminal_host_custody_unproven' as const,
            }
          : { status: 'stopped' as const };
      }
      return pidAliveAfterDisposition
        ? {
            status: 'incomplete' as const,
            reason: 'process_still_running' as const,
          }
        : { status: 'stopped' as const };
    })();
    return cancellation;
  };
}

export async function readAllWindowsProcessFacts(): Promise<
  ReadonlyMap<number, WindowsProcessInventoryFact>
> {
  return await readWindowsProcessInventory({
    // Deadline-owning boundary: a `child_process` `timeout` turns a completed inventory into an
    // empty one that still reports success, i.e. "no such process" for every live pid.
    execFile: execFileWithDeadline,
  });
}

export async function cancelWindowsTerminalLaunch(
  params: Readonly<{
    launch: WindowsTerminalLaunchCustody;
    capturedIdentity?: ExactWindowsProcessCancellationIdentity;
    retirementNotBeforeMs?: number;
  }> & WindowsProcessCustodyDependencies,
): Promise<StartupLaunchCancellationResult> {
  let identity = params.capturedIdentity ?? null;
  if (!identity) {
    const now = params.nowFn ?? Date.now;
    const sleep =
      params.sleepFn
      ?? (async (ms: number) =>
        await new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const retirementNotBeforeMs =
      params.retirementNotBeforeMs ?? now();
    const horizonWaitMs = Math.max(
      0,
      retirementNotBeforeMs - now(),
    );
    if (horizonWaitMs > 0) await sleep(horizonWaitMs);

    let inventory: ReadonlyMap<number, WindowsProcessInventoryFact>;
    for (let scan = 0; scan < 2; scan += 1) {
      try {
        inventory = await (
          params.readAllWindowsProcessFactsFn
          ?? readAllWindowsProcessFacts
        )();
      } catch {
        return {
          status: 'incomplete',
          reason: 'terminal_host_custody_unproven',
        };
      }
      const hasUnreadableSameExecutableCandidate =
        [...inventory.values()].some(
          (process) =>
            typeof process.executablePath === 'string'
            && normalizeWindowsExecutablePath(
              process.executablePath,
            ) === normalizeWindowsExecutablePath(
              params.launch.executablePath,
            )
            && !process.command?.trim(),
        );
      if (hasUnreadableSameExecutableCandidate) {
        return {
          status: 'incomplete',
          reason: 'terminal_host_custody_unproven',
        };
      }
      const correlated = [...inventory.values()].filter(
        (process) =>
          process.command?.includes(params.launch.correlation)
          === true,
      );
      if (correlated.length > 1) {
        return {
          status: 'incomplete',
          reason: 'terminal_host_custody_unproven',
        };
      }
      if (correlated.length === 1) {
        identity = captureExactWindowsTerminalLaunchProcess({
          process: correlated[0]!,
          launch: params.launch,
        });
        if (!identity) {
          return {
            status: 'incomplete',
            reason: 'terminal_host_custody_unproven',
          };
        }
        break;
      }
      if (scan === 0) {
        await sleep(Math.max(50, params.quiescenceMs ?? 250));
      }
    }
    if (!identity) return { status: 'stopped' };
  }

  return await createExactWindowsProcessCancellation({
    ...identity,
    readProcessIdentityByPidFn:
      params.readProcessIdentityByPidFn,
    terminateProcessTreeFn: params.terminateProcessTreeFn,
    isPidAliveFn: params.isPidAliveFn,
  })();
}
