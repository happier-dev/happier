import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function resolveSignalExitCode(signal: string | null): number;

export function installParentDeathCleanupWatchdog(params: {
  pollMs?: number;
  onParentDeath: (currentParentPid: number, initialParentPid: number) => Promise<void> | void;
}): () => void;

export function createManagedChildLifecycle(
  child: ChildProcess,
  options?: {
    cleanupPollMs?: number;
    signalCleanupGraceMs?: number;
    processSignals?: string[];
    parentWatchdogPollMs?: number;
    onProcessSignal?: (signal: string) => Promise<void> | void;
    onParentDeath?: (currentParentPid: number, initialParentPid: number) => Promise<void> | void;
  },
): Readonly<{
  cleanupChild: (signal?: string, overrideOptions?: { graceMs?: number; pollMs?: number; skipAliveCheck?: boolean }) => Promise<void>;
  dispose: () => void;
  finalizeChildExit: (overrideOptions?: { graceMs?: number; pollMs?: number; skipAliveCheck?: boolean }) => Promise<void>;
}>;

export function runManagedChildCommand(params: {
  command: string;
  args: string[];
  spawnOptions?: SpawnOptions;
  cleanupPollMs?: number;
  signalCleanupGraceMs?: number;
  exitCleanupGraceMs?: number;
  parentWatchdogPollMs?: number;
  onProcessSignal?: (signal: string) => Promise<void> | void;
  onParentDeath?: (currentParentPid: number, initialParentPid: number) => Promise<void> | void;
}): Promise<
  | { child: ChildProcess; ok: false; error: Error }
  | { child: ChildProcess; ok: true; code: number | null; signal: string | null }
>;
