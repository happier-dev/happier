export interface WorkspaceBundleLockContext {
  waited: boolean;
  lockPath: string;
  heldLockValue: string;
  inherited: boolean;
  assertOwned: () => void;
}

export const WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE: 'EWORKSPACEBUNDLELOCKTIMEOUT';
export const WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE: 'EWORKSPACEBUNDLELOCKBUSY';
export const WORKSPACE_BUNDLE_LOCK_OWNERSHIP_LOST_ERROR_CODE: 'EWORKSPACEBUNDLELOCKOWNERSHIPLOST';
export const DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS: number;

export type WorkspaceBundleLockPriorityResource =
  | { kind?: 'workspace'; path: string }
  | { kind: 'dependency' | 'dependency-input-writer'; path: string; installDir: string };

/** Soft publication preference, never an actual lease or capacity reservation. */
export interface WorkspaceBundleLockPriorityScope {
  activate(): void;
  suspend(): void;
  dispose(): void;
}

export function createWorkspaceBundleLockPriorityScope(options: {
  resources: readonly WorkspaceBundleLockPriorityResource[];
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Stack's dependency owner authenticates conflicts with its own resources. */
  isHeldResourceContinuation?: (
    resource: Extract<WorkspaceBundleLockPriorityResource, { installDir: string }>,
    env: Record<string, string | undefined>,
  ) => boolean;
}): WorkspaceBundleLockPriorityScope;
export function observeWorkspaceBundleLockPriority(lockPath: string, options?: {
  /** Exclude the observer's own lifecycle changes, never another participant. */
  priorityScope?: WorkspaceBundleLockPriorityScope;
}): string;
export function isWorkspaceBundleLockPriorityChange(
  lockPath: string, filename: string, priorityScope?: WorkspaceBundleLockPriorityScope,
): boolean;

export interface WorkspaceBundleLockOptions<T = unknown> {
  lockPath: string;
  heldLockValue?: string;
  heldLockPath?: string;
  /** Refuse contention without watching or sleeping; an explicit priorityScope retains only soft preference. */
  wait?: boolean;
  priorityScope?: WorkspaceBundleLockPriorityScope;
  /** Bounds waits without a fresh authenticated owner heartbeat; healthy owners use staleAfterMs. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  initializationGraceMs?: number;
  readProcessInstanceFingerprintSyncImpl?: (pid: number) => string | null;
  readProcessHostIdentityImpl?: () => import('./processInstance.mjs').ProcessHostIdentity | null;
  startWorkspaceLockHeartbeatImpl?: (options: {
    lockPath: string;
    ownerToken: string;
    processInstanceFingerprint: string | null;
    staleAfterMs: number;
  }) => { terminate: () => Promise<unknown> } | null;
  beforeWorkspaceLockHeartbeatWriteImpl?: (options: { lockPath: string }) => void;
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
  /** After contention, validates reusable outputs under the admitted lock before invoking the publisher. */
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
export function resolveCliSharedDepsBuildLockPath(repoRoot: string): string;
export function callerHoldsWorkspaceBundleLock(lockPath: string, heldLockValue?: string): boolean;
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
  options: WorkspaceBundleLockOptions<T> & { signal?: AbortSignal },
): Promise<T>;
export function withWorkspaceBundleLockSync<T>(
  fn: (context: WorkspaceBundleLockContext) => T,
  options: WorkspaceBundleLockOptions,
): T;
