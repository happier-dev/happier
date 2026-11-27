import { type ActionExecuteFailure, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryBatchResponseSchema,
  UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageAccountingAsOfMs, type resolveUsagePageAccountingReads,
  type UsageAccountingSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

type ReadResponse = ActionExecuteFailure | Readonly<{ sourceFailure: Pick<ActionExecuteFailure, 'errorCode' | 'details' | 'failureCause'> }>
  | Readonly<{ response: { status: number; data: unknown } }>;

/** One accounting acquisition per Action batch, using Home's shared read snapshot. */
export async function readUsageAccountingSnapshots(input: Readonly<{
  reads: ReturnType<typeof resolveUsagePageAccountingReads>;
  nowMs: number;
  projectScopeKeys?: (projectKey: string) => Iterable<string>;
  post: (path: string, body: unknown) => Promise<ReadResponse>;
}>): Promise<Array<UsageAccountingSourceSnapshot | ActionExecuteFailure>> {
  if (input.reads.length === 0) return [];
  const reads = input.reads.map(({ query, period }) => ({ query, period,
    request: usageQueryToAnalyticsRequest({ ...query, period }, input.nowMs, input.projectScopeKeys) }));
  const batch = reads.length > 1;
  // Scalar reads already carry these facts. Preserve raw membership, pricing,
  // Work and export inputs when acquiring several slices through the shared route.
  const body = projectNativeJsonValueForTransport(batch
    ? { queries: reads.map(read => read.request), includeContributions: true } : reads[0]!.request);
  const result = await input.post(batch ? '/v2/usage/query-batch' : '/v2/usage/query', body);
  if ('ok' in result) return [result];
  const failed = (errorCode: string, status: 'error' | 'unsupported' = 'error'): UsageAccountingSourceSnapshot[] =>
    reads.map(({ query, period }) => ({ query, period, status, errorCode }));
  if ('sourceFailure' in result) {
    const { errorCode, details, failureCause } = result.sourceFailure;
    return failed(errorCode).map(snapshot => ({ ...snapshot,
      ...(details === undefined ? {} : { details }),
      ...(failureCause === undefined ? {} : { failureCause }),
    }));
  }
  const { status, data } = result.response;
  if (status === 404 && data !== null && typeof data === 'object' && 'error' in data
    && (data.error === 'not_found' || data.error === 'Session not found')) return failed('denied');
  if (status === 404 || status === 405 || status === 501) return failed('unsupported', 'unsupported');
  if (status >= 400) return failed(readUnexpectedActionErrorDiagnosticV1({ response: result.response }).errorCode ?? 'usage_query_failed');
  if (!batch) {
    const parsed = UsageAnalyticsQueryResponseSchema.safeParse(data);
    return parsed.success ? [{ query: reads[0]!.query, period: reads[0]!.period, status: 'available',
      value: parsed.data, asOfMs: resolveUsageAccountingAsOfMs(parsed.data) }] : failed('usage_query_result_invalid');
  }
  const parsed = UsageAnalyticsQueryBatchResponseSchema.safeParse(data);
  if (!parsed.success) return failed('usage_query_result_invalid');
  const results = new Map(parsed.data.results.map(row => [getUsageAnalyticsQueryRequestKey(row.query), row]));
  return reads.map(({ query, period, request }): UsageAccountingSourceSnapshot => {
    const row = results.get(getUsageAnalyticsQueryRequestKey(request));
    if (!row) return { query, period, status: 'error', errorCode: 'usage_query_result_invalid' };
    if ('error' in row) return { query, period, status: 'error', errorCode: 'denied' };
    const value = parsed.data.priceCatalog ? { ...row.value, priceCatalog: parsed.data.priceCatalog } : row.value;
    return { query, period, status: 'available', value, asOfMs: resolveUsageAccountingAsOfMs(value) };
  });
}
