import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_AFTER_MS = 30_000;

export async function withRuntimeAuthFailureReportOutboxFileLock<T>(
  itemFilePath: string,
  effect: () => Promise<T>,
): Promise<T> {
  return await withJsonOwnerFileLock({
    lockPath: `${itemFilePath}.lock`,
    timeoutMs: LOCK_TIMEOUT_MS,
    staleAfterMs: LOCK_STALE_AFTER_MS,
    errorCode: 'runtime_auth_failure_report_outbox_lock_timeout',
  }, effect);
}
