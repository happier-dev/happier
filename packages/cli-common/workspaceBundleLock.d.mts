export interface WorkspaceBundleLockContext {
  waited: boolean;
  lockPath: string;
  heldLockValue: string;
  inherited: boolean;
}

export const WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE: 'EWORKSPACEBUNDLELOCKTIMEOUT';
export const DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS: number;

export interface WorkspaceBundleLockOptions<T = unknown> {
  lockPath: string;
  heldLockValue?: string;
  heldLockPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  initializationGraceMs?: number;
  readProcessInstanceFingerprintSyncImpl?: (pid: number) => string | null;
  protectLockFileImpl?: (lockPath: string, fd: number) => void;
  platform?: string;
  env?: Record<string, string | undefined>;
  spawnSyncImpl?: (...args: unknown[]) => {
    error?: Error;
    signal?: string | null;
    status?: number | null;
    stdout?: unknown;
    stderr?: unknown;
  };
  errorLabel?: string;
  tryResolveWaiter?: () =>
    | Promise<{ resolved: true; value: T } | { resolved: false }>
    | { resolved: true; value: T }
    | { resolved: false };
  onWait?: (event: {
    lockPath: string;
    owner: Record<string, unknown> | null;
    staleAfterMs: number;
    timeoutMs: number;
    waitedMs: number;
  }) => void;
}

export function resolveWorkspaceBundleLockPath(repoRoot: string): string;
export function isWorkspaceBundleLockActive(
  lockPath: string,
  options?: { staleAfterMs?: number; nowMs?: number },
): boolean;
export function observeWorkspaceBundleLock(
  lockPath: string,
  options?: { staleAfterMs?: number; nowMs?: number },
): { active: boolean; ownerId: string | null };
export function withWorkspaceBundleLock<T>(
  fn: (context: WorkspaceBundleLockContext) => Promise<T> | T,
  options: WorkspaceBundleLockOptions<T>,
): Promise<T>;
export function withWorkspaceBundleLockSync<T>(
  fn: (context: WorkspaceBundleLockContext) => T,
  options: WorkspaceBundleLockOptions,
): T;
