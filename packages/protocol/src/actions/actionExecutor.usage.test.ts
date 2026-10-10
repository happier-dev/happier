import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';
import { decodeBase64 } from '../crypto/base64.js';
import type { UsageWorkEvidence } from '../usage/usageOutcomeAllocation.js';

const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['a', 'b'] });

describe('personal usage Action execution', () => {
  it('publishes Coach evidence states through the same admitted query Action', async () => {
    const coachQuery = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const executor = createActionExecutor({ usageActions: {
      query: async input => resolveUsagePageAggregation({ queries: input.queries,
        accounting: [{ query: coachQuery, value: accounting, status: 'available', asOfMs: 200 }] }),
    } } as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [coachQuery] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { results: [{ coach: {
        period: { startMs: 100, endMs: 200 },
        evaluations: expect.arrayContaining([
          expect.objectContaining({ detectorId: 'duplicated_instructions', status: 'insufficient_evidence' }),
          expect.objectContaining({ detectorId: 'cache_busting_prompt_changes', status: 'insufficient_evidence' }),
        ]),
      } }] } });
  });
  it('preserves exact-query accounting and witnessed Work through the Action result', async () => {
    const workQuery = normalizeUsageQuery({ session: 'session', period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...workQuery, agents: ['other'] });
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens: accounting.totals.tokens,
      cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD' } };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: [contribution] });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open',
      } };
    const executor = createActionExecutor({ usageActions: {
      query: async input => resolveUsagePageAggregation({ queries: input.queries,
        accounting: [{ query: workQuery, value, status: 'available' }], work: [{ query: workQuery, status: 'partial', evidence: [witness] }] }),
    } } as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [workQuery, other] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { v: 1, results: expect.arrayContaining([
        expect.objectContaining({ requestedQuery: workQuery, work: expect.objectContaining({ allocations: [expect.objectContaining({ contribution,
          reason: 'allocated', outcome: expect.objectContaining({ repositoryKey: 'repo' }) })] }) }),
        expect.objectContaining({ requestedQuery: other }),
      ]) } });
  });
  it('treats reversed batches as the same canonical set of independently resolved slices', async () => {
    const executor = createActionExecutor({ usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries }),
    } } as ActionExecutorDeps);
    const pinned = { ...query, period: { startMs: 0, endMs: 100 } };
    const first = await executor.execute('usage.query', { queries: [query, pinned] }, { surface: 'cli' });
    const second = await executor.execute('usage.query', { queries: [pinned, query, query] }, { surface: 'cli' });
    expect(first).toEqual(second);
  });
  it('returns deduplicated complete identities and independent snapshot slices without awaiting pending sources', async () => {
    const executor = createActionExecutor({ usageActions: {
      // Authenticated read transport is the boundary; query/key/aggregation logic stays real.
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, status: 'available', value: accounting }], quota: { status: 'pending' } }),
    } } as ActionExecutorDeps);
    const pinned = { ...query, period: { startMs: 0, endMs: 100 } };
    const result = await executor.execute('usage.query', { queries: [query, { ...query, agents: ['b', 'a', 'a'] }, pinned] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true, result: { results: expect.arrayContaining([
      expect.objectContaining({ requestedQuery: query, shownQuery: query, accounting, pending: true }),
      expect.objectContaining({ requestedQuery: pinned, shownQuery: pinned, pending: true }),
    ]) } });
  });
  it('refuses incomplete or foreign slice sets instead of presenting unrequested accounting', async () => {
    const executor = createActionExecutor({ usageActions: {
      query: async () => resolveUsagePageAggregation({ queries: [normalizeUsageQuery({ agents: ['foreign'] })],
        accounting: [{ query: normalizeUsageQuery({ agents: ['foreign'] }), status: 'available', value: accounting }] }),
    } } as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [query] }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid' });
  });
  it('exports selected facts through the same authorized read and the single canonical byte serializer', async () => {
    const executor = createActionExecutor({ usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, status: 'available', value: accounting, asOfMs: 150 }] }),
    } } as ActionExecutorDeps);
    const request = { query, format: 'json' as const, fields: ['totals' as const] };
    const result = await executor.execute('usage.export', request, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true, result: { mediaType: 'application/json', fields: ['totals'], asOfMs: 150 } });
    if (result.ok && result.result && typeof result.result === 'object' && 'base64' in result.result) {
      const content = JSON.parse(new TextDecoder().decode(decodeBase64(String(result.result.base64))));
      expect(content.accounting).toEqual({ totals: accounting.totals });
    }
  });
  it('keeps typed read denial and late cancellation from disclosing file or accounting bytes', async () => {
    const controller = new AbortController();
    const denied = createActionExecutor({ usageActions: {
      query: async () => ({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }),
    } } as ActionExecutorDeps);
    expect(await denied.execute('usage.export', { query, format: 'json', fields: ['totals'] }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    const retired = createActionExecutor({ usageActions: {
      query: async request => { controller.abort(); return resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, status: 'available', value: accounting }] }); },
    } } as ActionExecutorDeps);
    expect(await retired.execute('usage.query', { queries: [query] }, { surface: 'cli', signal: controller.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
  it('reports unknown accounting freshness without substituting the export clock', async () => {
    const executor = createActionExecutor({ usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, status: 'available', value: accounting }] }),
    } } as ActionExecutorDeps);
    expect(await executor.execute('usage.export', { query, format: 'json', fields: ['totals'] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { asOfMs: null, fileName: 'usage.json' } });
  });
});
