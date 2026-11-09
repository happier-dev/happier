import { join } from 'node:path';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

export function resolvePrepareTargetJobPath(activeServerDir: string, jobId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(jobId)) throw new Error(`Invalid session handoff prepare-target job id: ${jobId}`);
  return join(activeServerDir, 'session-handoff', 'prepare-target-jobs', `${jobId}.json`);
}

/** The job and its physical writer claim share one cross-process mutation owner. */
export async function withPrepareTargetJobMutationLock<T>(jobPath: string, mutation: () => Promise<T>): Promise<T> {
  return await withJsonOwnerFileLock({
    lockPath: `${jobPath}.lock`,
    timeoutMs: Infinity,
    errorCode: 'session_handoff_prepare_target_job_lock_timeout',
  }, mutation);
}
