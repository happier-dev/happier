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

function hashProjectKey(projectKey: string): string {
    // FNV-1a 32-bit hash is sufficient for local telemetry bucketing.
    let hash = 0x811c9dc5;
    for (let index = 0; index < projectKey.length; index += 1) {
        hash ^= projectKey.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function getProjectScope(projectKey: string): string {
    const separatorIndex = projectKey.indexOf(':');
    if (separatorIndex <= 0) return 'unknown';
    return projectKey.slice(0, separatorIndex);
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
    error: unknown;
}): void {
    const message = normalizeErrorMessage(input.error);
    const projectFingerprint = hashProjectKey(input.projectKey);
    const bucketKey = `${projectFingerprint}:${message}`;
    const now = Date.now();
    if (!shouldEmitError(bucketKey, now)) {
        return;
    }
    tracking?.capture('scm_status_sync_failed', {
        projectScope: getProjectScope(input.projectKey),
        projectFingerprint,
        message,
    });
}

export function resetScmStatusSyncErrorReportingForTests(): void {
    recentStatusSyncErrorBuckets.clear();
}
