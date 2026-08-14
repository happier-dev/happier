import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  withWorkspaceBundleLock,
} from '../../workspaceBundleLock.mjs';

export async function withCliDistBuildLock<T>(
  fn: (params: { waited: boolean; heldLockValue: string; inherited: boolean }) => Promise<T>,
  options: {
    lockPath: string;
    heldLockValue?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleAfterMs?: number;
  },
): Promise<T> {
  const { env = process.env, ...lockOptions } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS;
  return await withWorkspaceBundleLock(fn, {
    ...lockOptions,
    heldLockValue:
      lockOptions.heldLockValue
      ?? env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    timeoutMs,
    staleAfterMs: options.staleAfterMs ?? timeoutMs,
    errorLabel: 'CLI dist build lock',
  });
}
