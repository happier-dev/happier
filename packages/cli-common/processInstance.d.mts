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

export function parseLinuxProcStartTime(statText: unknown): string | null;
export function readProcessInstanceFingerprintSync(
  pid: unknown,
  boundary?: ProcessInstanceBoundary,
): string | null;
export function processInstanceFingerprintMatches(
  expectedFingerprint: unknown,
  observedFingerprint: unknown,
): boolean;
export function processInstanceFingerprintMatchesSync(
  pid: unknown,
  expectedFingerprint: unknown,
  boundary?: ProcessInstanceBoundary,
): boolean;
