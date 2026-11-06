import { UsageAnalyticsQueryBatchResponseSchema, projectUsageQueryResultIssues, type UsageAnalyticsQueryBatchRequest,
    type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { HappyError } from '@/utils/errors/errors';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { UsageContributionProjection } from '@happier-dev/protocol/usage/usageCost';

/** Accounting batches use the same captured Home transport and finite read lifetime. */
export async function queryUsageAnalyticsBatch(credentials: AuthCredentials,
    input: UsageAnalyticsQueryBatchRequest & Readonly<{ contributionProjection?: UsageContributionProjection }>,
    options: Readonly<{ readTransport: CapturedServerReadTransport; signal: AbortSignal;
        onChunk: (value: UsageAnalyticsQueryBatchResponse) => void }>): Promise<void> {
    const features = options.readTransport.serverId
        ? await getServerFeaturesSnapshot({ serverId: options.readTransport.serverId, signal: options.signal })
        : null;
    throwIfAborted(options.signal);
    const compact = features?.status === 'ready'
        && readServerEnabledBit(features.features, 'usage.compactBatch') === true;
    const path = '/v2/usage/query-batch';
    const { contributionProjection, ...wireInput } = input;
    const init = { method: 'POST', signal: options.signal, headers: {
        Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json',
        Accept: `application/x-ndjson; contribution-encoding=dictionary${contributionProjection ? `; contribution-projection=${contributionProjection}` : ''}`,
    // Strict older Homes cannot parse per-query delivery selectors. Retain this
    // wire translation until every supported/development Home advertises compactBatch.
    }, body: JSON.stringify(compact || input.contributionQueries === undefined ? wireInput
        : { queries: input.queries, includeContributions: true }) };
    return options.readTransport.read(path, init, { includeAuth: false }, async response => {
        throwIfAborted(options.signal);
        if (!response.ok) {
            const code = response.status === 401 || response.status === 403 ? 'denied'
                : [404, 405, 501].includes(response.status) ? 'unsupported' : 'usage_query_failed';
            throw new HappyError('Usage accounting batch unavailable', false, { status: response.status, code });
        }
        const admit = (value: unknown) => {
            throwIfAborted(options.signal);
            const admitted = UsageAnalyticsQueryBatchResponseSchema.safeParse(value);
            if (!admitted.success) throw new PluginError({ code: 'usage_query_result_invalid',
                message: 'Invalid Usage accounting response', details: { issues: projectUsageQueryResultIssues(admitted.error.issues, UsageAnalyticsQueryBatchResponseSchema) } });
            options.onChunk(admitted.data);
        };
        if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
            admit(await response.json());
            return;
        }
        const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : undefined;
        // Native fetch implementations without a stream still read this one
        // response; they never fan it back out into scalar requests.
        if (!reader) {
            for (const line of (await response.text()).split('\n')) if (line.trim()) admit(JSON.parse(line));
            return;
        }
        const decoder = new TextDecoder();
        let pending = '';
        try {
            while (true) {
                const chunk = await reader.read();
                throwIfAborted(options.signal);
                pending += decoder.decode(chunk.value, { stream: !chunk.done });
                let newline: number;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    if (line.trim()) admit(JSON.parse(line));
                }
                if (chunk.done) break;
            }
            if (pending.trim()) admit(JSON.parse(pending));
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    });
}
