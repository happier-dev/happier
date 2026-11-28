export interface ProcessInstanceBoundary {
  platform?: string;
  windowsCreationDateFormat?: 'iso' | 'legacy' | 'dmtf';
  expectedFingerprint?: unknown;
  readFileSyncImpl?: (path: string, encoding: 'utf8') => string;
  spawnSyncImpl?: (...args: unknown[]) => {
    error?: Error;
    signal?: string | null;
    status?: number | null;
    stdout?: unknown;
  };
}

export interface ProcessLivenessBoundary {
  platform?: string;
  killImpl?: (pid: number, signal: 0) => void;
  readFileSyncImpl?: ProcessInstanceBoundary['readFileSyncImpl'];
}

export type ProcessLivenessObservation =
  | { status: 'alive'; reason: 'signal_probe' | 'permission_denied_but_present' }
  | { status: 'dead'; reason: 'invalid_pid' | 'not_found' | 'zombie' }
  | { status: 'inconclusive'; reason: string; error: unknown };

export function observeProcessLivenessSync(
  pid: unknown,
  boundary?: ProcessLivenessBoundary,
): ProcessLivenessObservation;

export function parseLinuxProcStartTime(statText: unknown): string | null;
export function parseLinuxProcStartTimeMs(statText: unknown): number | null;
export function parseLinuxProcStat(statText: unknown): Readonly<{
  fields: readonly string[];
  startTicks: string;
  startTimeMs: number;
}> | null;
export function hashProcessCommand(command: string): string;
export function processGenerationMatches(expected: number | undefined, observed: number | undefined): boolean;
export function processGenerationProvesReuse(expected: number | undefined, observed: number | undefined): boolean;
export function compareNumericProcessGenerationIdentities(expectedIdentity: string, observedIdentity: string, platform?: string): 'same' | 'reused' | 'ambiguous';
export interface ProcessIdentityWitness {
  pid: number;
  processStartTimeMs?: number;
  processCommandHash?: string;
}
export function processIdentityMatches(expected: ProcessIdentityWitness, observed: ProcessIdentityWitness): boolean;
export function readProcessInstanceFingerprintSync(
  pid: unknown,
  boundary?: ProcessInstanceBoundary,
): string | null;
export function readProcessStartTimeMsSync(
  pid: unknown,
  boundary?: ProcessInstanceBoundary,
): number | null;
export function processInstanceFingerprintMatches(
  expectedFingerprint: unknown,
  observedFingerprint: unknown,
): boolean;
export function processInstanceFingerprintMatchesSync(
  pid: unknown,
  expectedFingerprint: unknown,
  boundary?: ProcessInstanceBoundary,
): boolean;

export interface ProcessHostIdentity {
  machineId: string;
  bootId: string | null;
  pidNamespace: string | null;
  pidNamespaced: boolean;
}

export interface ProcessHostIdentityBoundary {
  platform?: string;
  readFileSyncImpl?: (path: string, encoding: 'utf8') => string;
  readlinkSyncImpl?: (path: string) => string;
  spawnSyncImpl?: ProcessInstanceBoundary['spawnSyncImpl'];
  hostnameImpl?: () => string;
}

export function readProcessHostIdentitySync(
  boundary?: ProcessHostIdentityBoundary,
): ProcessHostIdentity | null;
