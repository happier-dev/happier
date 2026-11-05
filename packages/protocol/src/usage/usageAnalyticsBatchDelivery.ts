import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryBatchRequest, type UsageAnalyticsQueryBatchResponse,
  type UsageAnalyticsQueryBatchWireResponse } from './usageAnalyticsContracts.js';
import { projectUsageAnalyticsSummary } from './usageSummary.js';
import { projectUsageAccountingSessionMembership } from './usageAccountingMembership.js';

export type UsageContributionProjection = 'work';
/** An Accept parameter is ignorable by older Homes, whose strict JSON grammar stays unchanged. */
export function readUsageContributionProjection(accept: string | undefined | null): UsageContributionProjection | undefined {
  return accept?.split(',').some(media => media.split(';').slice(1)
    .some(parameter => parameter.trim() === 'contribution-projection=work')) ? 'work' : undefined;
}

export function readUsageContributionEncoding(accept: string | undefined | null): boolean {
  return accept?.split(',').some(media => media.split(';').slice(1)
    .some(parameter => parameter.trim() === 'contribution-encoding=dictionary')) === true;
}

/** Encode one already-projected line; the canonical response schema admits it back to ordinary rows. */
export function encodeUsageAnalyticsBatchDelivery(chunk: UsageAnalyticsQueryBatchResponse): UsageAnalyticsQueryBatchWireResponse {
  if (!chunk.contributionPages) return chunk;
  return { ...chunk, contributionPages: chunk.contributionPages.map(page => {
    const fields = [...new Set(page.rows.flatMap(row => Object.keys(row)))] as Array<keyof typeof page.rows[number]>;
    const values: unknown[] = [];
    const dictionary = new Map<string, number>();
    const indices = page.rows.map(row => fields.map(field => {
      const value = row[field];
      if (value === undefined) return null;
      const key = JSON.stringify(value);
      let index = dictionary.get(key);
      if (index === undefined) {
        index = values.length;
        values.push(value);
        dictionary.set(key, index);
      }
      return index;
    }));
    return { ...page, rows: { fields, values, indices } };
  }) };
}

/** One wire producer shared by the server and HTTP-boundary fixtures. */
export function* projectUsageAnalyticsBatchDelivery(batch: UsageAnalyticsQueryBatchResponse,
  input: UsageAnalyticsQueryBatchRequest, stream: boolean,
  contributionProjection?: UsageContributionProjection): Generator<UsageAnalyticsQueryBatchResponse> {
  if (input.contributionQueries === undefined) {
    yield batch;
    return;
  }
  const detail = new Set(input.contributionQueries.map(getUsageAnalyticsQueryRequestKey));
  const sessions = new Set(input.sessionQueries?.map(getUsageAnalyticsQueryRequestKey));
  yield { v: 1, ...(batch.priceCatalog ? { priceCatalog: batch.priceCatalog } : {}), results: [] };
  for (const result of batch.results) {
    if ('error' in result) {
      yield { v: 1, results: [result] };
      continue;
    }
    const wanted = detail.has(getUsageAnalyticsQueryRequestKey(result.query));
    const value = { ...result.value, ...(batch.priceCatalog ? { priceCatalog: batch.priceCatalog } : {}) };
    const { priceCatalog: _catalog, contributions: _rows, ...facts } = projectUsageAnalyticsSummary(value, result.query);
    yield { v: 1, results: [{ query: result.query, value: { ...facts,
      ...(sessions.has(getUsageAnalyticsQueryRequestKey(result.query)) ? { sessionIds:
        [...new Set(value.contributions?.flatMap(row => row.sessionId === null ? [] : [row.sessionId]))],
        sessionMembership: projectUsageAccountingSessionMembership(value.contributions ?? []),
      } : {}),
    } }] };
    if (!wanted) continue;
    const rows = contributionProjection === 'work' ? (value.contributions ?? []).map(row => {
      // Allocation, historical filtering and repricing consume these operands.
      // Context windows and account/connection attribution belong to other detail consumers.
      const { context: _context, connectedAccount: _account, providerConnectionId: _connection,
        providerAttribution: _attribution, providerSource: _providerSource, ...work } = row;
      return work;
    }) : value.contributions ?? [];
    let offset = input.contributionOffset ?? 0;
    // The caller's existing top-N clause is the detail page's requested row count,
    // not a new Usage ceiling. A stream completes all pages from this one snapshot.
    do {
      const page = rows.slice(offset, offset + result.query.topLimit);
      const end = offset + page.length;
      const nextOffset = end < rows.length ? end : null;
      yield { v: 1, results: [], contributionPages: [{ query: result.query,
        offset, totalCount: rows.length, nextOffset, rows: page }] };
      if (!stream || nextOffset === null) break;
      offset = nextOffset;
    } while (true);
  }
}

/** JSON exposes one explicitly incomplete detail page; NDJSON completes that read in one response. */
export function collectUsageAnalyticsBatchDelivery(chunks: Iterable<UsageAnalyticsQueryBatchResponse>): UsageAnalyticsQueryBatchResponse {
  const value: UsageAnalyticsQueryBatchResponse = { v: 1, results: [] };
  for (const chunk of chunks) {
    if (chunk.priceCatalog) value.priceCatalog = chunk.priceCatalog;
    for (const result of chunk.results) value.results.push(result);
    if (chunk.contributionPages) for (const page of chunk.contributionPages) (value.contributionPages ??= []).push(page);
  }
  return value;
}
