export interface WorkspaceBundleLockContext {
  waited: boolean;
  lockPath: string;
  heldLockValue: string;
  inherited: boolean;
}

export const WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE: 'EWORKSPACEBUNDLELOCKTIMEOUT';

export interface WorkspaceBundleLockOptions {
  lockPath: string;
  heldLockValue?: string;
  heldLockPath?: string;
  /** null waits until the caller cancels; omitted retains the build-lock deadline. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  errorLabel?: string;
  onWait?: (event: {
    lockPath: string;
    owner: Record<string, unknown> | null;
    staleAfterMs: number;
    timeoutMs: number | null;
    waitedMs: number;
  }) => void;
}

export function resolveWorkspaceBundleLockPath(repoRoot: string): string;
export function isWorkspaceBundleLockActive(
  lockPath: string,
  options?: { staleAfterMs?: number; nowMs?: number },
): boolean;
export function withWorkspaceBundleLock<T>(
  fn: (context: WorkspaceBundleLockContext) => Promise<T> | T,
  options: WorkspaceBundleLockOptions,
): Promise<T>;
export function withWorkspaceBundleLockSync<T>(
  fn: (context: WorkspaceBundleLockContext) => T,
  options: Omit<WorkspaceBundleLockOptions, 'timeoutMs' | 'signal'> & { timeoutMs?: number },
): T;
