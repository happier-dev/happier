import { classifyScmOperationErrorCode, ScmOperationErrorCodeSchema, type ScmOperationErrorCode } from '@happier-dev/protocol/scm';

import { tracking } from '@/track';

const STATUS_SYNC_ERROR_DEDUPE_WINDOW_MS = 60_000;
const STATUS_SYNC_ERROR_DEDUPE_MAX_BUCKETS = 512;
const recentStatusSyncErrorBuckets = new Map<string, number>();

function normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'Unknown source-control status sync error';
}

/** Only the canonical code leaves the device; free text, paths and remotes never do. */
function readScmErrorCode(error: unknown): ScmOperationErrorCode | undefined {
    if (!error || typeof error !== 'object' || !('scmErrorCode' in error)) {
        return undefined;
    }
    const parsed = ScmOperationErrorCodeSchema.safeParse((error as { scmErrorCode?: unknown }).scmErrorCode);
    return parsed.success ? parsed.data : undefined;
}

function shouldEmitError(bucketKey: string, now: number): boolean {
    const lastSeen = recentStatusSyncErrorBuckets.get(bucketKey) ?? 0;
    if (lastSeen !== 0 && now - lastSeen < STATUS_SYNC_ERROR_DEDUPE_WINDOW_MS) {
        return false;
    }
    if (recentStatusSyncErrorBuckets.has(bucketKey)) {
        recentStatusSyncErrorBuckets.delete(bucketKey);
    } else if (recentStatusSyncErrorBuckets.size >= STATUS_SYNC_ERROR_DEDUPE_MAX_BUCKETS) {
        const oldestKey = recentStatusSyncErrorBuckets.keys().next().value;
        if (typeof oldestKey === 'string') {
            recentStatusSyncErrorBuckets.delete(oldestKey);
        }
    }
    recentStatusSyncErrorBuckets.set(bucketKey, now);
    return true;
}

export function reportScmStatusSyncError(input: {
    projectKey: string;
    /** The server the project belongs to, when the caller knows it. */
    serverId?: string;
    error: unknown;
}): void {
    // Dedupe stays local: the project key and message only shape the bucket.
    const bucketKey = `${input.projectKey}:${normalizeErrorMessage(input.error)}`;
    const now = Date.now();
    if (!shouldEmitError(bucketKey, now)) {
        return;
    }
    const errorCode = readScmErrorCode(input.error);
    tracking?.capture('scm_status_sync_failed', {
        errorCode: errorCode ?? 'unknown',
        errorCategory: classifyScmOperationErrorCode(errorCode),
    }, { serverId: input.serverId ?? null });
}

export function resetScmStatusSyncErrorReportingForTests(): void {
    recentStatusSyncErrorBuckets.clear();
}
