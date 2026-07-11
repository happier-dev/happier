import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';

export async function withCliDistBuildLock<T>(
  fn: (params: { waited: boolean; heldLockValue: string; inherited: boolean }) => Promise<T>,
  options: {
    lockPath: string;
    heldLockValue?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleAfterMs?: number;
  },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  return await withWorkspaceBundleLock(fn, {
    ...options,
    timeoutMs,
    staleAfterMs: options.staleAfterMs ?? timeoutMs,
    errorLabel: 'CLI dist build lock',
  });
}
