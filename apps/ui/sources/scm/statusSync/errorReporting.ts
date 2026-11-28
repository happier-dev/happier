import { classifyScmOperationErrorCode, ScmOperationErrorCodeSchema, type ScmOperationErrorCode } from '@happier-dev/protocol';
import { getTrackingAnonymousUserId, tracking } from '@/track';
import {
    loadScmStatusSyncFailureReportedAt,
    saveScmStatusSyncFailureReportedAt,
} from '@/sync/domains/state/persistence';

// Status sync retries keep failing the same way for as long as a project is broken, so the event
// counts which failures a person hits, not how often: once per analytics user per error code per
// day, remembered on this device across launches (owner request: ~48 events per user before).
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readScmErrorCode(error: unknown): ScmOperationErrorCode | undefined {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    if (!('scmErrorCode' in error)) {
        return undefined;
    }
    const parsed = ScmOperationErrorCodeSchema.safeParse((error as { scmErrorCode?: unknown }).scmErrorCode);
    return parsed.success ? parsed.data : undefined;
}

export function reportScmStatusSyncError(input: { error: unknown }): void {
    const analyticsUserId = getTrackingAnonymousUserId();
    if (!tracking || !analyticsUserId) return;

    const errorCode = readScmErrorCode(input.error);
    const bucketKey = `${analyticsUserId}:${errorCode ?? 'none'}`;
    const now = Date.now();
    const reportedAt = loadScmStatusSyncFailureReportedAt();
    const lastReportedAt = reportedAt[bucketKey];
    if (lastReportedAt !== undefined && now - lastReportedAt < REPORT_INTERVAL_MS) {
        return;
    }
    const stillCurrent = Object.entries(reportedAt).filter(([, at]) => now - at < REPORT_INTERVAL_MS);
    saveScmStatusSyncFailureReportedAt({ ...Object.fromEntries(stillCurrent), [bucketKey]: now });

    // The error text is raw (paths, hosts): it is not sent. Only the fixed code and its category are.
    tracking.capture('scm_status_sync_failed', {
        ...(errorCode ? { errorCode } : {}),
        error_category: classifyScmOperationErrorCode(errorCode),
    });
}
