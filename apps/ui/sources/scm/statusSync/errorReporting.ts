import { classifyScmOperationErrorCode, ScmOperationErrorCodeSchema, type ScmOperationErrorCode } from '@happier-dev/protocol/scm';

import { getTrackingAnonymousUserId, tracking } from '@/track';
import {
    loadScmStatusSyncFailureReportedAt,
    saveScmStatusSyncFailureReportedAt,
} from '@/sync/domains/state/analyticsSendState';

// Status sync retries keep failing the same way for as long as a project is broken, so the event
// counts which failures a person hits, not how often: once per analytics user per error code per
// day, remembered on this device across launches (owner request: ~48 events per user before).
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Only the canonical code leaves the device; free text, paths and remotes never do. */
function readScmErrorCode(error: unknown): ScmOperationErrorCode | undefined {
    if (!error || typeof error !== 'object' || !('scmErrorCode' in error)) {
        return undefined;
    }
    const parsed = ScmOperationErrorCodeSchema.safeParse((error as { scmErrorCode?: unknown }).scmErrorCode);
    return parsed.success ? parsed.data : undefined;
}

export function reportScmStatusSyncError(input: {
    /** The server the project belongs to, when the caller knows it. */
    serverId?: string;
    error: unknown;
}): void {
    const analyticsUserId = getTrackingAnonymousUserId();
    if (!tracking || !analyticsUserId) return;

    const errorCode = readScmErrorCode(input.error);
    const bucketKey = `${analyticsUserId}:${errorCode ?? 'unknown'}`;
    const now = Date.now();
    const reportedAt = loadScmStatusSyncFailureReportedAt();
    const lastReportedAt = reportedAt[bucketKey];
    if (lastReportedAt !== undefined && now - lastReportedAt < REPORT_INTERVAL_MS) {
        return;
    }
    const stillCurrent = Object.entries(reportedAt).filter(([, at]) => now - at < REPORT_INTERVAL_MS);
    saveScmStatusSyncFailureReportedAt({ ...Object.fromEntries(stillCurrent), [bucketKey]: now });

    tracking.capture('scm_status_sync_failed', {
        errorCode: errorCode ?? 'unknown',
        errorCategory: classifyScmOperationErrorCode(errorCode),
    }, { serverId: input.serverId ?? null });
}
