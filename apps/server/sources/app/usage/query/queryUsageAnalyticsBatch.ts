import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryBatchRequest,
    type UsageAnalyticsQueryBatchResponse, type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { captureUsageAnalyticsBatch, projectUsageAnalyticsBatch } from './readUsageAnalyticsBatch';
import { assertUsageReaderOpen } from './projectUsageAnalyticsDemands';
import { UsageQueryTiming } from './usageQueryTiming';

interface RunningUsageBatch {
    readers: Set<() => boolean>;
    isReaderClosed: () => boolean;
    timing: UsageQueryTiming;
    result: Promise<UsageAnalyticsQueryBatchResponse>;
}

const runningBatches = new Map<string, RunningUsageBatch>();

/** Share only running computation, after each caller's own authentication and admission. */
export async function queryUsageAnalyticsBatch(accountId: string, body: UsageAnalyticsQueryBatchRequest,
    admittedQueries: readonly UsageAnalyticsQueryRequest[], isReaderClosed: () => boolean,
    timing?: UsageQueryTiming): Promise<UsageAnalyticsQueryBatchResponse> {
    assertUsageReaderOpen(isReaderClosed);
    const key = createCanonicalJsonSigningInput(projectNativeJsonValueForTransport({ accountId, body,
        admittedQueries: admittedQueries.map(getUsageAnalyticsQueryRequestKey) }));
    let running = runningBatches.get(key);
    // A new reader must not revive work whose last reader has already closed.
    if (running?.isReaderClosed()) running = undefined;
    if (running) running.readers.add(isReaderClosed);
    else {
        const readers = new Set([isReaderClosed]);
        const sharedTiming = new UsageQueryTiming();
        const remove = () => {
            if (runningBatches.get(key)?.readers === readers) runningBatches.delete(key);
        };
        const allReadersClosed = () => {
            for (const closed of readers) if (closed()) readers.delete(closed);
            if (readers.size) return false;
            remove();
            return true;
        };
        const result = (async () => {
            const readStarted = performance.now();
            let snapshot;
            try { snapshot = await captureUsageAnalyticsBatch(accountId, admittedQueries, allReadersClosed, body); }
            finally { sharedTiming.durations.read += performance.now() - readStarted; }
            return projectUsageAnalyticsBatch(snapshot, admittedQueries,
                body.includeContributions || body.contributionQueries !== undefined,
                body.contributionQueries !== undefined, sharedTiming, body, allReadersClosed);
        })().finally(() => {
            remove();
            readers.clear();
        });
        running = { readers, isReaderClosed: allReadersClosed, timing: sharedTiming, result };
        runningBatches.set(key, running);
    }
    try { return await running.result; }
    finally {
        if (timing) {
            // Shared compute phases are the same; admission and encoding belong to this reader.
            const { auth, serialize } = timing.durations;
            Object.assign(timing.durations, running.timing.durations, { auth, serialize });
        }
    }
}
