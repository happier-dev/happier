export function readProcessInstanceFingerprintSync(
  pid: number,
  options?: Readonly<{
    platform?: NodeJS.Platform;
    spawnSyncImpl?: typeof import('node:child_process').spawnSync;
    readFileSyncImpl?: typeof import('node:fs').readFileSync;
  }>,
): string | null;

export function processInstanceFingerprintMatches(expected: unknown, observed: unknown): boolean;

export type ProcessProbeBudget = Readonly<{
  /** Remaining caller budget. Non-positive values are rejected before any subprocess starts. */
  timeoutMs: number;
  signal?: AbortSignal;
  runCaptureImpl: (
    command: string,
    args: string[],
    options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
  ) => Promise<string>;
}>;

export type ProcessIdentityInconclusiveReason =
  | 'process-identity-timeout'
  | 'process-identity-cancelled'
  | 'process-identity-unavailable';

export type ProcessInstanceObservation =
  | Readonly<{ status: 'ok'; fingerprint: string }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'inconclusive'; reason: ProcessIdentityInconclusiveReason }>;

export function observeProcessInstanceFingerprint(
  pid: number,
  options: ProcessProbeBudget & Readonly<{
    platform?: NodeJS.Platform;
    readFileSyncImpl?: typeof import('node:fs').readFileSync;
  }>,
): Promise<ProcessInstanceObservation>;

export type ProcessAncestryRow = Readonly<{ pid: number; parentPid: number; fingerprint: string }>;

export function observeWindowsProcessAncestry(
  pid: number,
  options: ProcessProbeBudget & Readonly<{ stopAtPid: number }>,
): Promise<
  | Readonly<{ status: 'ok'; rows: readonly ProcessAncestryRow[] }>
  | Readonly<{ status: 'inconclusive'; reason: ProcessIdentityInconclusiveReason }>
>;

export function isVerifiedProcessAncestry(
  rows: readonly ProcessAncestryRow[],
  expected: Readonly<{ leafPid: number; ancestorPid: number; ancestorFingerprint: string }>,
): boolean;
