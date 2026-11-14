export function isPidAliveBySignal(pid: number, onProbeFailure?: () => void): boolean;

export type ProcessTreeTerminationResult = Readonly<{ rootObservedAlive: boolean }>;

export type ProcessListEntry = Readonly<{ pid: number; ppid: number; name?: string }>;

export function parseFastlistOutput(stdout: string): ProcessListEntry[];

export function resolveWindowsFastlistPath(options?: Readonly<{
  execPath?: string;
  arch?: string;
  existsSync?: (path: string) => boolean;
  resolvePsListEntry?: () => string;
}>): string | null;

export function withWindowsFastlistFallback<T extends ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>(
  enumerate: () => Promise<T>,
  options?: Readonly<{
    platform?: NodeJS.Platform;
    resolveFastlistPath?: () => string | null;
    listWithFastlist?: (binaryPath: string) => Promise<ProcessListEntry[]>;
  }>,
): () => Promise<T | ProcessListEntry[]>;

export function killProcessTree(
  proc: Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>,
  opts?: Readonly<{ graceMs?: number }>,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<ProcessTreeTerminationResult>;
