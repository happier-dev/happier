import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryResponseSchema,
    type UsageAnalyticsQueryBatchRequest, type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { ServedHomeRequest } from './actionHomesHttpHarness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { collectUsageAnalyticsBatchDelivery, encodeUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery,
    readUsageContributionEncoding, readUsageContributionProjection,
    type UsageContributionProjection } from '@happier-dev/protocol/usage/usageCost';

/** Legacy scalar fixtures omit detail; absence is not a witnessed empty population. */
function* projectScalarFixtureBatchDelivery(batch: UsageAnalyticsQueryBatchResponse,
    input: UsageAnalyticsQueryBatchRequest, stream: boolean, projection?: UsageContributionProjection): Generator<UsageAnalyticsQueryBatchResponse> {
    for (const result of batch.results) {
        const selected: UsageAnalyticsQueryBatchResponse = { ...batch, results: [result] };
        if ('value' in result && result.value.contributions === undefined) {
            if (batch.priceCatalog) yield { v: 1, results: [], priceCatalog: batch.priceCatalog };
            yield { v: 1, results: [result] };
        } else yield* projectUsageAnalyticsBatchDelivery(selected, input, stream, projection);
    }
}

/** Fetch-shaped fixtures use the same batch wire producer as served Home fixtures. */
export function createUsageQueryBatchFetchBoundary(
    request: RuntimeFetch,
): RuntimeFetch {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v2/usage/query-batch' || init?.method !== 'POST') return request(input, init);
        const boundary = createUsageQueryBatchHttpBoundary(async component => {
            if (component.path === '/v2/usage/query-batch') return undefined;
            return request(component.url.href, { ...init, method: component.method, headers: component.headers,
                signal: component.signal, body: JSON.stringify(component.body) });
        }, []);
        return (await boundary({ home: url.origin, accountId: null, url, path: url.pathname,
            method: init.method, headers: new Headers(init.headers), signal: init.signal,
            body: init.body ? JSON.parse(String(init.body)) : undefined }))!;
    };
}

/** A server HTTP boundary; component fixtures remain scalar while physical requests stay observable. */
export function createUsageQueryBatchHttpBoundary(route: (request: ServedHomeRequest) => Response | Promise<Response | undefined> | undefined,
    components: ServedHomeRequest[]) {
    return async (request: ServedHomeRequest): Promise<Response | undefined> => {
        if (request.path !== '/v2/usage/query-batch') { components.push(request); return route(request); }
        const direct = await route(request);
        if (direct) { components.push(request); return direct; }
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        const projection = readUsageContributionProjection(request.headers.get('accept'));
        const queries = [...new Map(input.queries.map(query => [getUsageAnalyticsQueryRequestKey(query), query])).values()];
        if (request.headers.get('accept')?.includes('application/x-ndjson')) {
            let cancelled = false;
            let catalogDelivered = false;
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                const emit = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); };
                    void Promise.all(queries.map(async query => {
                        const component = { ...request, path: '/v2/usage/query', url: new URL('/v2/usage/query', request.url), body: query };
                        components.push(component);
                        const response = await route(component);
                        if (!response?.ok) {
                            emit({ v: 1, results: [{ query, error: [401, 403, 404].includes(response?.status ?? 0)
                                ? 'not_found' : 'usage_query_failed' }] });
                            return;
                        }
                        const payload: unknown = await response.json();
                        const parsed = UsageAnalyticsQueryResponseSchema.safeParse(payload);
                        if (!parsed.success) { emit(payload); return; }
                        const { priceCatalog, contributions, ...facts } = parsed.data;
                        if (input.contributionQueries !== undefined) {
                            const batch: UsageAnalyticsQueryBatchResponse = { v: 1, ...(priceCatalog ? { priceCatalog } : {}),
                                results: [{ query, value: { ...facts, ...(contributions ? { contributions } : {}) } }] };
                            for (const chunk of projectScalarFixtureBatchDelivery(batch, input, true, projection)) {
                                if (chunk.priceCatalog) {
                                    if (catalogDelivered) continue;
                                    catalogDelivered = true;
                                }
                                emit(readUsageContributionEncoding(request.headers.get('accept')) ? encodeUsageAnalyticsBatchDelivery(chunk) : chunk);
                            }
                            return;
                        }
                        const catalog = !catalogDelivered && input.includeContributions && priceCatalog ? priceCatalog : undefined;
                        if (catalog) catalogDelivered = true;
                        emit({ v: 1, ...(catalog ? { priceCatalog: catalog } : {}), results: [{ query,
                            value: input.includeContributions ? { ...facts, contributions } : facts }] });
                    })).then(() => { if (!cancelled) controller.close(); }, error => { if (!cancelled) controller.error(error); });
                },
                cancel() { cancelled = true; },
            });
            return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
        }
        let priceCatalog: UsageAnalyticsQueryBatchResponse['priceCatalog'];
        const rows = await Promise.all(queries.map(async (query): Promise<UsageAnalyticsQueryBatchResponse['results'][number] | Response | undefined> => {
            const component = { ...request, path: '/v2/usage/query', url: new URL('/v2/usage/query', request.url), body: query };
            components.push(component);
            const response = await route(component);
            if (!response) return undefined;
            if (response.status === 404) return { query, error: 'not_found' };
            if (!response.ok) return response;
            const payload: unknown = await response.json();
            const parsed = UsageAnalyticsQueryResponseSchema.safeParse(payload);
            if (!parsed.success) return Response.json(payload); // Exercise the real client admission failure.
            const { priceCatalog: catalog, contributions, ...facts } = parsed.data;
            priceCatalog ??= catalog;
            return { query, value: input.includeContributions || input.contributionQueries !== undefined ? { ...facts, contributions } : facts };
        }));
        const failure = rows.find(row => row instanceof Response);
        if (failure) return failure;
        if (rows.some(row => row === undefined)) return undefined;
        const results = rows.flatMap(row => row && !(row instanceof Response) ? [row] : []);
        if (input.contributionQueries !== undefined) return Response.json(collectUsageAnalyticsBatchDelivery(
            projectScalarFixtureBatchDelivery({ v: 1, results, ...(priceCatalog ? { priceCatalog } : {}) }, input, false, projection)));
        return Response.json({ v: 1, results, ...(input.includeContributions && priceCatalog ? { priceCatalog } : {}) });
    };
}
