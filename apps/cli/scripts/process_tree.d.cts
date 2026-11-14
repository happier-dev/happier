export function isPidAliveBySignal(pid: number, onProbeFailure?: () => void): boolean;

export type ProcessTreeTerminationResult = Readonly<{ rootObservedAlive: boolean }>;

export function killProcessTree(
  proc: Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>,
  opts?: Readonly<{ graceMs?: number }>,
  enumerate?: () => Promise<ReadonlyArray<Readonly<{ pid: number; ppid: number }>>>,
): Promise<ProcessTreeTerminationResult>;
