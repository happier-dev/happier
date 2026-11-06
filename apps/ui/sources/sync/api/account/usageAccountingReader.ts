import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createScopedBatchResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { HappyError } from '@/utils/errors/errors';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { queryUsageAnalytics } from './apiUsage';
import { queryUsageAnalyticsBatch } from './apiUsageBatch';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { admitUsageAnalyticsServerPrices } from '@happier-dev/protocol/usage/usageCostFacts';

type AccountingRead = UsageAnalyticsQueryResponse | { error: 'not_found' | 'usage_query_failed' };

/** Raw-detail admission is part of the existing accounting answer's identity. */
export function getUsageAccountingReadKey(request: UsageAnalyticsQueryRequest, includeContributions: boolean, includeSessionIds = false, workOnly = false): string {
    return JSON.stringify([getUsageAnalyticsQueryRequestKey(request), includeContributions, includeSessionIds, ...(workOnly ? [true] : [])]);
}

/** The existing Account-owned pending reader batches transport; it retains no settled responses. */
export function createUsageAccountingReader(context: Readonly<{
    credentials: AuthCredentials; request: ServerFetch; readTransport?: CapturedServerReadTransport;
}>, ownerSignal: AbortSignal) {
    // Share only while a borrower needs the read. Keeping physical work alive
    // for the entire Account made Retry leave its superseded body downloading.
    const pending = createScopedBatchResolutionSingleFlight<AccountingRead>();
    // This typed Account owner invalidates accounting explicitly. Unrelated
    // Home traffic must not split an admitted read when viewport demand changes.
    const captured = context.readTransport ? { transport: context.readTransport, binding: context.readTransport.key } : null;
    return {
        invalidate(affected?: (request: UsageAnalyticsQueryRequest) => boolean) {
            if (!affected || !captured) pending.reset();
            else pending.invalidate(captured.transport.scope ?? captured.binding, key => {
                const [queryKey] = JSON.parse(key) as [string];
                return affected(JSON.parse(queryKey) as UsageAnalyticsQueryRequest);
            });
        },
        async read(request: UsageAnalyticsQueryRequest, signal?: AbortSignal, includeContributions = true, includeSessionIds = false, workOnly = false): Promise<UsageAnalyticsQueryResponse> {
            const cancellation = mergeAbortSignals([signal, ownerSignal]);
            // An opaque invocation closure cannot prove neutral cancellation or
            // cross-invocation borrowing. Signed/legacy callers keep their exact transport.
            if (!captured) return queryUsageAnalytics(context.credentials, request, { request: context.request, signal: cancellation.signal })
                .finally(cancellation.dispose);
            const { transport, binding } = captured;
            const key = getUsageAccountingReadKey(request, includeContributions, includeSessionIds, workOnly);
            const values = await pending.run(binding, [key], async (keys, physicalSignal, publish) => {
                // Keys are this reader's own canonical serialization of admitted
                // requests, not external strings or another input grammar.
                const selected = new Map<string, { query: UsageAnalyticsQueryRequest; detail: boolean; sessions: boolean; fullDetail: boolean; keys: string[] }>();
                for (const key of keys) {
                    const [queryKey, detail, sessions, workOnly] = JSON.parse(key) as [string, boolean, boolean, boolean?];
                    const entry = selected.get(queryKey);
                    if (entry) { entry.detail ||= detail; entry.sessions ||= sessions; entry.fullDetail ||= detail && !workOnly; entry.keys.push(key); }
                    else selected.set(queryKey, { query: JSON.parse(queryKey) as UsageAnalyticsQueryRequest, detail, sessions,
                        fullDetail: detail && !workOnly, keys: [key] });
                }
                const queries = [...selected.values()].map(entry => entry.query);
                const contributionQueries = [...selected.values()].filter(entry => entry.detail).map(entry => entry.query);
                const sessionQueries = [...selected.values()].filter(entry => entry.sessions).map(entry => entry.query);
                const contributionProjection = contributionQueries.length > 0 && ![...selected.values()].some(entry => entry.fullDetail)
                    ? 'work' as const : undefined;
                const wanted = new Set(selected.keys());
                const seen = new Set<string>();
                const resolved = new Map<string, AccountingRead>();
                const pages = new Map<string, { value: UsageAnalyticsQueryResponse;
                    rows: NonNullable<UsageAnalyticsQueryResponse['contributions']>; totalCount?: number }>();
                let priceCatalog: UsageAnalyticsQueryResponse['priceCatalog'];
                const invalid = (code: string, path: string[]) => new PluginError({
                    code: 'usage_query_result_invalid', message: 'Invalid accounting batch membership or page',
                    details: { issues: [{ code, path }] } });
                await queryUsageAnalyticsBatch(context.credentials, { queries, includeContributions: false, contributionQueries, sessionQueries,
                    ...(contributionProjection ? { contributionProjection } : {}) },
                    { readTransport: transport, signal: physicalSignal, onChunk(batch) {
                        priceCatalog ??= batch.priceCatalog;
                        const chunk = new Map<string, AccountingRead>();
                        const complete = (id: string, value: AccountingRead) => {
                            if (!wanted.delete(id)) throw invalid('duplicate_result', ['results']);
                            for (const key of selected.get(id)!.keys) {
                                const [, detail, sessions] = JSON.parse(key) as [string, boolean, boolean];
                                let delivered = value;
                                // Keep older rich answers intact until they carry
                                // the compact producer's grouped facts.
                                if (!detail && !('error' in value) && value.summary) {
                                    const { contributions: _rows, ...summary } = value;
                                    if (sessions) delivered = summary;
                                    else { const { sessionIds: _members, sessionMembership: _turns, ...facts } = summary; delivered = facts; }
                                }
                                chunk.set(key, 'error' in delivered ? delivered
                                    : admitUsageAnalyticsServerPrices(delivered, selected.get(id)!.query));
                            }
                        };
                        for (const row of batch.results) {
                            const id = getUsageAnalyticsQueryRequestKey(row.query);
                            if (!selected.has(id) || seen.has(id)) throw invalid('result_membership', ['results']);
                            seen.add(id);
                            if ('error' in row) { complete(id, { error: row.error }); continue; }
                            const value = { ...row.value, ...(priceCatalog ? { priceCatalog } : {}) };
                            if (selected.get(id)!.detail && value.summary && value.contributions === undefined) pages.set(id, { value, rows: [] });
                            else complete(id, value);
                        }
                        for (const page of batch.contributionPages ?? []) {
                            const id = getUsageAnalyticsQueryRequestKey(page.query);
                            const held = pages.get(id);
                            if (!held || !wanted.has(id)) throw invalid('detail_header_missing', ['contributionPages']);
                            if (page.offset !== held.rows.length) throw invalid('detail_offset', ['contributionPages', 'offset']);
                            if (held.totalCount !== undefined && held.totalCount !== page.totalCount)
                                throw invalid('detail_count', ['contributionPages', 'totalCount']);
                            held.totalCount = page.totalCount;
                            for (const row of page.rows) held.rows.push(row);
                            if (held.rows.length > page.totalCount || (page.nextOffset === null
                                ? held.rows.length !== page.totalCount : page.nextOffset !== held.rows.length || page.rows.length === 0))
                                throw invalid('detail_completion', ['contributionPages', 'nextOffset']);
                            if (page.nextOffset === null) {
                                complete(id, { ...held.value, contributions: held.rows });
                                pages.delete(id);
                            }
                        }
                        for (const [id, value] of chunk) resolved.set(id, value);
                        if (chunk.size) publish(chunk);
                    } });
                if (wanted.size) throw invalid('incomplete_batch', [pages.size ? 'contributionPages' : 'results']);
                return resolved;
            }, { scope: transport.scope ?? binding, signal: cancellation.signal }).finally(cancellation.dispose);
            const result = values.get(key)!;
            if ('error' in result) throw new HappyError('Usage slice unavailable', false,
                result.error === 'not_found' ? { status: 404, code: 'denied' } : { code: 'usage_query_failed' });
            return result;
        },
    };
}
